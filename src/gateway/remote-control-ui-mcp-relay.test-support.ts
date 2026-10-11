import { EventEmitter } from "node:events";
import { expect } from "vitest";
import mcpRelayPlugin from "../../extensions/mcp-relay/index.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
  createTestPluginApi,
  createTestPluginServiceScheduler,
} from "../plugin-sdk/plugin-test-api.js";
import {
  createPluginStateKeyedStore,
  type OpenAsyncKeyedStoreOptions,
} from "../plugin-state/plugin-state-store.js";
import type { GatewayControlUiIngressFactoryV1 } from "../plugins/gateway-ingress.types.js";
import { createLazyPluginRuntime } from "../plugins/loader-module-runtime.js";
import type { OpenClawPluginServiceContextV2, OpenClawPluginServiceV2 } from "../plugins/types.js";
import type { OpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { GatewayRequestContext, GatewayRequestHandler } from "./server-methods/types.js";

type RelayFrame = {
  type: string;
  id?: string;
  sid?: string;
  op?: string;
  ok?: boolean;
  status?: number;
  b64?: string;
  text?: string;
  more?: boolean;
  code?: number;
  params?: { codeHash?: string };
};

/** Only relay I/O is fake; the plugin, keyed state, and ingress transport are real. */
export class McpRelayTestSocket extends EventEmitter {
  static latest: McpRelayTestSocket | undefined;
  readonly #frames: RelayFrame[] = [];
  readonly #readers: Array<(frame: RelayFrame) => void> = [];
  bufferedAmount = 0;

  constructor() {
    super();
    McpRelayTestSocket.latest = this;
  }

  send(text: string, callback?: (error?: Error) => void) {
    const frame = JSON.parse(text) as RelayFrame;
    const reader = this.#readers.shift();
    if (reader) {
      reader(frame);
    } else {
      this.#frames.push(frame);
    }
    callback?.();
  }

  receive(frame: unknown) {
    this.emit("message", Buffer.from(JSON.stringify(frame)), false);
  }

  next(): Promise<RelayFrame> {
    const frame = this.#frames.shift();
    return frame
      ? Promise.resolve(frame)
      : new Promise((resolve) => {
          this.#readers.push(resolve);
        });
  }

  close(code = 1000, reason = "") {
    this.emit("close", code, Buffer.from(reason));
  }

  terminate() {
    this.close(1006);
  }
}

export async function withMcpRelayIngress(
  params: {
    factory: GatewayControlUiIngressFactoryV1;
    config: OpenClawConfig;
    state: OpenClawTestState;
    context: GatewayRequestContext;
    publicOrigin: string;
    sandboxOrigin: string;
    frameAncestors: string[];
  },
  usePeer: (peer: {
    send(frame: unknown): Promise<void>;
    read(): Promise<string>;
  }) => Promise<void>,
) {
  const clock = createGatewaySchedulerClock(Date.now());
  const scheduler = createTestPluginServiceScheduler(createTestGatewayScheduler(clock.clock));
  const runtime = createLazyPluginRuntime({});
  runtime.state.openKeyedStore = <T>(options: OpenAsyncKeyedStoreOptions) =>
    createPluginStateKeyedStore<T>("mcp-relay", options, () => scheduler.signal.throwIfAborted());
  const methods = new Map<string, GatewayRequestHandler>();
  let service: OpenClawPluginServiceV2 | undefined;
  const api = createTestPluginApi({
    config: params.config,
    runtime,
    registerGatewayMethod: (method, handler) => methods.set(method, handler),
    registerService: (registered) => {
      if (registered.apiVersion !== 2) {
        throw new Error("Expected the scheduler-owned MCP relay service");
      }
      service = registered;
    },
  });
  mcpRelayPlugin.register(api);
  if (!service) {
    throw new Error("MCP relay did not register its service");
  }
  const context: OpenClawPluginServiceContextV2 = {
    config: params.config,
    stateDir: params.state.stateDir,
    logger: api.logger,
    scheduler,
    controlUiIngress: params.factory,
  };
  const call = async (method: string) => {
    const handler = methods.get(`mcp-relay.${method}`);
    if (!handler) {
      throw new Error(`MCP relay did not register ${method}`);
    }
    const respond = Promise.withResolvers<unknown>();
    await handler({
      req: { type: "req", id: method, method: `mcp-relay.${method}`, params: {} },
      params: {},
      client: null,
      isWebchatConnect: () => false,
      context: params.context,
      signal: scheduler.signal,
      hasCurrentClientAuthority: () => true,
      respond: (ok, result, error) => {
        if (ok) {
          respond.resolve(result);
        } else {
          respond.reject(new Error(error?.message ?? "MCP relay request failed"));
        }
      },
    });
    return respond.promise;
  };
  try {
    await service.start(context);
    await clock.advanceBy(0);
    const relay = McpRelayTestSocket.latest;
    if (!relay) {
      throw new Error("MCP relay did not connect");
    }
    const beforeReady = await call("status");
    const { gatewayId } = beforeReady as { gatewayId: string };
    relay.receive({
      type: "challenge",
      protocol: 1,
      nonce: Buffer.alloc(32, 7).toString("base64url"),
      relay: "mcp.openclaw.ai",
    });
    expect(await relay.next()).toMatchObject({ type: "hello", protocol: 1 });
    relay.receive({ type: "ready", gatewayId, ui: { frameAncestors: params.frameAncestors } });
    await clock.advanceBy(0);
    expect(await call("status")).toMatchObject({ ui: { available: true, basePath: "/claw" } });
    const pairing = call("pair");
    const offer = await relay.next();
    expect(offer).toMatchObject({ type: "req", op: "pair.offer" });
    relay.receive({ type: "res", id: offer.id, ok: true, result: {} });
    await pairing;
    const grantId = `gr_${Buffer.alloc(32, 19).toString("base64url")}`;
    relay.receive({
      type: "req",
      id: "grant-create",
      op: "grant.create",
      params: {
        grantId,
        codeHash: offer.params?.codeHash,
        client: { id: "integration", name: "Synthetic relay browser" },
      },
    });
    await clock.advanceBy(0);
    expect(await relay.next()).toMatchObject({ type: "res", id: "grant-create", ok: true });
    const origins = {
      grantId,
      publicOrigin: params.publicOrigin,
      sandboxOrigin: params.sandboxOrigin,
    };
    relay.receive({
      type: "ui.http",
      sid: "http-root",
      ...origins,
      surface: "control-ui",
      method: "GET",
      path: "/claw/",
      headers: [["accept", "text/html"]],
      b64: "",
      more: false,
    });
    const serving = clock.advanceBy(0);
    expect(await relay.next()).toMatchObject({
      type: "ui.http.head",
      sid: "http-root",
      status: 200,
    });
    const chunks: Buffer[] = [];
    for (;;) {
      const frame = await relay.next();
      expect(frame).toMatchObject({
        type: "ui.http.body",
        sid: "http-root",
        b64: expect.any(String),
      });
      chunks.push(Buffer.from(frame.b64!, "base64"));
      if (!frame.more) {
        break;
      }
    }
    await serving;
    expect(Buffer.concat(chunks).toString()).toContain('data-openclaw-remote-ingress="true"');
    relay.receive({
      type: "ui.ws.open",
      sid: "ws-browser",
      ...origins,
      path: "/claw",
      origin: params.publicOrigin,
      protocols: [],
    });
    const opening = clock.advanceBy(0);
    expect(await relay.next()).toMatchObject({ type: "ui.ws.opened", sid: "ws-browser" });
    await usePeer({
      send: async (frame) => {
        relay.receive({
          type: "ui.ws.msg",
          sid: "ws-browser",
          text: JSON.stringify(frame),
          more: false,
        });
        await clock.advanceBy(0);
      },
      read: async () => {
        const frame = await relay.next();
        expect(frame).toMatchObject({
          type: "ui.ws.msg",
          sid: "ws-browser",
          text: expect.any(String),
          more: false,
        });
        return frame.text!;
      },
    });
    relay.receive({ type: "ui.ws.close", sid: "ws-browser", code: 1000, reason: "proof complete" });
    await clock.advanceBy(0);
    await opening;
  } finally {
    await service.stop?.(context);
    await scheduler.stop();
    McpRelayTestSocket.latest = undefined;
  }
}
