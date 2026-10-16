import { EventEmitter } from "node:events";
import { expect } from "vitest";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
  createTestPluginApi,
  createTestPluginServiceScheduler,
} from "../plugin-sdk/plugin-test-api.js";
import { createPluginStateRuntimeStores } from "../plugin-state/plugin-state-store.js";
import type {
  GatewayControlUiIngressFactoryV2,
  GatewayControlUiIngressOpenOptionsV2,
  GatewayControlUiIngressV2,
} from "../plugins/gateway-ingress.types.js";
import { createLazyPluginRuntime } from "../plugins/loader-module-runtime.js";
import type { OpenClawPluginDefinition } from "../plugins/plugin-definition.types.js";
import type { OpenClawPluginServiceContextV2, OpenClawPluginServiceV2 } from "../plugins/types.js";
import {
  ensureCanonicalUserProfileForEmail,
  setCanonicalUserProfileRole,
} from "../state/user-profile-writes.js";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";
import type { OpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import {
  createPluginGatewayMethodDescriptor,
  type GatewayMethodDescriptor,
} from "./methods/descriptor.js";
import { createGatewayMethodRegistry } from "./methods/registry.js";
import { invalidateOperatorRolePolicy } from "./operator-role-policy.js";
import {
  connect,
  expectHello,
  usePeer,
  type Peer,
  type IngressFrame,
  TRUSTED_PROXY,
  TEAM_ROLES,
} from "./remote-control-ui-ingress.integration.test-support.js";
import { dispatchGatewayRequestInProcess } from "./server-in-process-dispatch.js";
import { coreGatewayHandlers } from "./server-methods/core-handlers.js";
import { prepareGatewayRequestHandler } from "./server-methods/lazy-core-handlers.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import type { GatewayClientRegistry } from "./server/client-registry.js";

const { default: mcpRelayPlugin } = await loadBundledPluginFacade<{
  default: Required<Pick<OpenClawPluginDefinition, "register">>;
}>({ pluginId: "mcp-relay", artifactBasename: "index.js" });

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
  code?: number | string;
  params?: { codeHash?: string; principal?: string; ceiling?: string[] };
  result?: unknown;
  error?: { code: string; message: string };
};

/** Only relay I/O is fake; the plugin, keyed state, and ingress transport are real. */
export class McpRelayTestSocket extends EventEmitter {
  static latest: McpRelayTestSocket | undefined;
  readonly #frames: RelayFrame[] = [];
  readonly #readers: Array<{
    matches: (frame: RelayFrame) => boolean;
    resolve: (frame: RelayFrame) => void;
  }> = [];
  bufferedAmount = 0;

  constructor() {
    super();
    McpRelayTestSocket.latest = this;
  }

  send(text: string, callback?: (error?: Error) => void) {
    const frame = JSON.parse(text) as RelayFrame;
    // The synthetic relay acknowledges durable revocation replays between service instances.
    if (frame.type === "req" && frame.op === "grant.revoke") {
      queueMicrotask(() => this.receive({ type: "res", id: frame.id, ok: true, result: {} }));
      callback?.();
      return;
    }
    const readerIndex = this.#readers.findIndex((reader) => reader.matches(frame));
    const reader = readerIndex < 0 ? undefined : this.#readers.splice(readerIndex, 1)[0];
    if (reader) {
      reader.resolve(frame);
    } else {
      this.#frames.push(frame);
    }
    callback?.();
  }

  receive(frame: unknown) {
    this.emit("message", Buffer.from(JSON.stringify(frame)), false);
  }

  next(matches: (frame: RelayFrame) => boolean = () => true): Promise<RelayFrame> {
    const index = this.#frames.findIndex(matches);
    const frame = index < 0 ? undefined : this.#frames.splice(index, 1)[0];
    return frame
      ? Promise.resolve(frame)
      : new Promise((resolve) => {
          this.#readers.push({ matches, resolve });
        });
  }

  close(code = 1000, reason = "") {
    this.emit("close", code, Buffer.from(reason));
  }

  terminate() {
    this.close(1006);
  }
}

export async function expectMcpRelayPrincipalAuthority(params: {
  factory: GatewayControlUiIngressFactoryV2;
  state: OpenClawTestState;
  context: GatewayRequestContext;
  config: OpenClawConfig;
  sharedToken: string;
  ownerSessionKey: string;
  configure: (config: OpenClawConfig, auth: ResolvedGatewayAuth) => Promise<void>;
  openOptions: GatewayControlUiIngressOpenOptionsV2;
  clients: GatewayClientRegistry;
  openRemote: (handle: GatewayControlUiIngressV2) => Promise<Peer>;
}) {
  // Keep lazy source transformation outside the relay's real RPC deadlines.
  for (const method of ["agents.list", "sessions.list", "sessions.describe", "chat.history"]) {
    await prepareGatewayRequestHandler(coreGatewayHandlers[method]!);
  }
  const admin = await ensureCanonicalUserProfileForEmail("relay-admin@ingress.example.test");
  const reader = await ensureCanonicalUserProfileForEmail("relay-reader@ingress.example.test");
  for (const person of [admin, reader]) {
    await setCanonicalUserProfileRole(person.id, "admin", {
      onCommitted: invalidateOperatorRolePolicy,
    });
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: `agent:main:ingress-${person.id}` },
      {
        sessionId: `ingress-${person.id}`,
        updatedAt: Date.now(),
        label: person.id,
        createdActor: { type: "human", source: "profile", id: person.id },
        visibility: "draft",
      },
    );
  }
  for (const profileId of [undefined, reader.id]) {
    const config: OpenClawConfig = {
      ...params.config,
      gateway: {
        ...params.config.gateway,
        roles: profileId ? TEAM_ROLES : undefined,
        auth: profileId
          ? { mode: "trusted-proxy", trustedProxy: TRUSTED_PROXY }
          : { mode: "token", token: params.sharedToken },
      },
    };
    await params.configure(
      config,
      profileId
        ? { mode: "trusted-proxy", trustedProxy: TRUSTED_PROXY, allowTailscale: false }
        : { mode: "token", token: params.sharedToken, allowTailscale: false },
    );
    const approvingUi = await params.factory.open({
      ...params.openOptions,
      audienceId: `relay-consent-${profileId ?? "owner"}`,
      principal: profileId ? { kind: "person", profileId } : { kind: "owner" },
      operatorScopeCeiling: ["operator.admin"],
    });
    try {
      await usePeer(await params.openRemote(approvingUi), async (approvingPeer) => {
        const identity = loadOrCreateDeviceIdentity({
          identityKey: `relay-consent-${profileId ?? "owner"}`,
        });
        expectHello(await connect(approvingPeer, { identity, profileId }), "remote-ingress", [
          "operator.admin",
        ]);
        const caller = [...params.clients].find(
          (client) => client.connect.device?.id === identity.deviceId,
        );
        if (!caller) {
          throw new Error("Missing admitted relay consent caller");
        }
        const clock = createGatewaySchedulerClock(Date.now());
        const scheduler = createTestPluginServiceScheduler(createTestGatewayScheduler(clock.clock));
        const runtime = createLazyPluginRuntime({});
        runtime.state.openKeyedStoreV2 = createPluginStateRuntimeStores("mcp-relay", () =>
          scheduler.signal.throwIfAborted(),
        ).openKeyedStoreV2;
        const methods: GatewayMethodDescriptor[] = [];
        const errors: string[] = [];
        let service: OpenClawPluginServiceV2 | undefined;
        const api = createTestPluginApi({
          config,
          runtime,
          logger: { info() {}, warn() {}, debug() {}, error: (message) => errors.push(message) },
          registerGatewayMethod: (name, handler, options) => {
            methods.push(
              createPluginGatewayMethodDescriptor({
                pluginId: "mcp-relay",
                name,
                handler,
                ...options,
              }),
            );
          },
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
          config,
          stateDir: params.state.stateDir,
          logger: api.logger,
          scheduler,
          controlUiIngress: params.factory,
        };
        const methodRegistry = createGatewayMethodRegistry(methods);
        const call = (method: string, input: Record<string, unknown> = {}) =>
          dispatchGatewayRequestInProcess(`mcp-relay.${method}`, input, {
            client: caller,
            isWebchatConnect: () => false,
            context: params.context,
            signal: scheduler.signal,
            hasCurrentClientAuthority: () => params.clients.has(caller),
            methodRegistry,
          });
        try {
          await service.start(context);
          await clock.advanceBy(0);
          const relay = McpRelayTestSocket.latest;
          if (!relay) {
            throw new Error("MCP relay did not connect");
          }
          const { gatewayId } = (await call("status")) as { gatewayId: string };
          relay.receive({
            type: "challenge",
            protocol: 1,
            nonce: Buffer.alloc(32, 7).toString("base64url"),
            relay: "mcp.openclaw.ai",
          });
          expect(await relay.next()).toMatchObject({ type: "hello", protocol: 1 });
          relay.receive({
            type: "ready",
            gatewayId,
            ui: { frameAncestors: params.openOptions.frameAncestors },
          });
          await clock.advanceBy(0);
          expect(await call("status")).toMatchObject({
            ui: { available: true, basePath: "/claw" },
          });
          const ceiling = profileId ? ["operator.admin"] : ["operator.read", "operator.write"];
          const pairing = call("pair", { ceiling });
          void pairing.catch(() => {});
          const offer = await awaitGateBeforeSettlement(
            relay.next(),
            pairing,
            "Pairing completed without a relay offer",
          );
          expect(offer).toMatchObject({
            type: "req",
            op: "pair.offer",
            params: { principal: profileId ? "person" : "owner", ceiling },
          });
          expect(offer.params).not.toHaveProperty("profileId");
          relay.receive({ type: "res", id: offer.id, ok: true, result: {} });
          await pairing;
          const grantId = `gr_${Buffer.alloc(32, profileId ? 21 : 20).toString("base64url")}`;
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
            publicOrigin: params.openOptions.publicOrigin,
            sandboxOrigin: params.openOptions.sandboxOrigin,
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
          const openSocket = (sid: string) =>
            relay.receive({
              type: "ui.ws.open",
              sid,
              ...origins,
              path: "/claw",
              origin: origins.publicOrigin,
              protocols: [],
            });
          const browserSid = "ws-browser";
          openSocket(browserSid);
          // Opening jobs own socket lifetimes; join them after revocation closes the sockets.
          const opening = clock.advanceBy(0);
          expect(await relay.next()).toMatchObject({ type: "ui.ws.opened", sid: "ws-browser" });
          const peer: Peer = {
            send: async (frame) => {
              relay.receive({
                type: "ui.ws.msg",
                sid: browserSid,
                text: JSON.stringify(frame),
                more: false,
              });
              await clock.advanceBy(0);
            },
            read: async () => {
              const frame = await relay.next(
                (candidate) => candidate.type === "ui.ws.msg" && candidate.sid === browserSid,
              );
              return JSON.parse(frame.text!) as IngressFrame;
            },
            close: async () => {},
          };
          expectHello(
            await connect(peer, {
              identity: loadOrCreateDeviceIdentity({
                identityKey: `synthetic-mcp-relay-${profileId ?? "owner"}`,
              }),
              scopes: [],
              profileId,
            }),
            "remote-ingress",
            ceiling,
          );
          let requestSequence = 0;
          const dataRequest = async (op: string, input: Record<string, unknown>) => {
            const id = `data-${++requestSequence}`;
            relay.receive({ type: "req", id, grantId, op, params: input });
            await clock.advanceBy(0);
            return relay.next((frame) => frame.type === "res" && frame.id === id);
          };
          expect(await dataRequest("status", {})).toMatchObject({
            ok: true,
            result: { agents: [expect.objectContaining({ id: "main" })] },
          });
          const ownKey = profileId ? `agent:main:ingress-${profileId}` : params.ownerSessionKey;
          const foreignKey = `agent:main:ingress-${admin.id}`;
          const listed = await dataRequest("conversations.list", { limit: 50 });
          expect(listed).toMatchObject({
            ok: true,
            result: {
              conversations: expect.arrayContaining([
                expect.objectContaining({ conversationId: ownKey }),
              ]),
            },
          });
          expect(
            await dataRequest("conversation.read", { conversationId: ownKey, limit: 1 }),
          ).toMatchObject({ ok: true, result: { conversationId: ownKey, messages: [] } });
          if (profileId) {
            // Existing UI authority retires; the same live grant then binds the current role.
            await setCanonicalUserProfileRole(profileId, "reader", {
              onCommitted: invalidateOperatorRolePolicy,
            });
            expect(await dataRequest("status", {})).toMatchObject({ ok: false });
            expect(
              await relay.next(
                (frame) =>
                  frame.sid === browserSid &&
                  (frame.type === "ui.error" || frame.type === "ui.ws.close"),
              ),
            ).toHaveProperty("sid", browserSid);
            expect(await dataRequest("status", {})).toMatchObject({ ok: true });
            expect(await dataRequest("conversations.list", { limit: 50 })).toMatchObject({
              result: {
                conversations: expect.not.arrayContaining([
                  expect.objectContaining({ conversationId: foreignKey }),
                ]),
              },
            });
            expect(
              await dataRequest("conversation.read", { conversationId: foreignKey, limit: 1 }),
            ).toMatchObject({ ok: false, error: { code: "not_found" } });
            expect(
              await dataRequest("message.send", {
                conversationId: ownKey,
                message: "Must not start",
                waitMs: 0,
              }),
            ).toMatchObject({ ok: false });
            expect(errors).toContainEqual("mcp-relay: op=message.send method=chat.send failed");
          }
          relay.receive({
            type: "req",
            id: "revoke-grant",
            op: "grant.revoked",
            params: { grantId, reason: "client_revoked" },
          });
          await clock.advanceBy(0);
          expect(
            await relay.next((frame) => frame.type === "res" && frame.id === "revoke-grant"),
          ).toMatchObject({ ok: true });
          if (!profileId) {
            expect(
              await relay.next((frame) => frame.sid === browserSid && frame.type === "ui.error"),
            ).toMatchObject({ code: "grant_revoked" });
          }
          expect(await dataRequest("conversations.list", { limit: 1 })).toMatchObject({
            ok: false,
            error: { code: "grant_revoked" },
          });
          openSocket("ws-reopened");
          await clock.advanceBy(0);
          expect(await relay.next((frame) => frame.sid === "ws-reopened")).toMatchObject({
            type: "ui.error",
            code: "grant_revoked",
          });
          await opening;
        } finally {
          await service.stop?.(context);
          await scheduler.stop();
          McpRelayTestSocket.latest = undefined;
        }
      });
    } finally {
      await approvingUi.close();
    }
  }
}
