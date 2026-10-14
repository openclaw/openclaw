import { once } from "node:events";
import http from "node:http";
import { PassThrough } from "node:stream";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";
import { WebSocket } from "ws";
import type { WorkerComputerParams } from "../../../packages/gateway-protocol/src/schema/worker-computer.js";
import {
  releaseAgentRunDelegatedAuthority,
  resetAgentRunRegistryForTest,
} from "../../infra/agent-run-registry.js";
import { resetPluginRuntimeStateForTest } from "../../plugins/runtime.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { reserveTestPortListener } from "../../test-utils/port-claims.js";
import { createWorkerComputerTool } from "../../worker/computer-runtime.js";
import { parseNodeWorkerComputerInput } from "../../worker/node-computer-protocol.js";
import {
  DESKTOP_OBSERVE_PATH,
  handleDesktopObserveUpgrade,
  mintDesktopObserverToken,
} from "../desktop/observe-bridge.js";
import {
  createDesktopSessionRegistry,
  type DesktopSessionRegistry,
} from "../desktop/session-registry.js";
import { createWorkerComputerService } from "./computer-service.js";
import {
  createHarness,
  connectionIdentity,
  EXECUTION_ID,
} from "./computer-transport.test-support.js";
import { createWorkerComputerRpc } from "./worker-turn-computer-rpc.js";

const takeover = {
  idempotencyKey: "takeover",
  nodeId: "desktop-node",
  command: "computer.act" as const,
  commandParams: { action: "__take_control", executionId: EXECUTION_ID },
};
const snapshot = {
  nodeId: "desktop-node",
  command: "screen.snapshot" as const,
  commandParams: { executionId: EXECUTION_ID },
};
const input = {
  nodeId: "desktop-node",
  command: "computer.act" as const,
  commandParams: { action: "type", executionId: EXECUTION_ID, text: "continue" },
};

async function setup() {
  const h = createHarness();
  const desktopRegistry = createDesktopSessionRegistry();
  const service = createWorkerComputerService({ ...h.options, desktopRegistry });
  const prepared = (await service.prepare(h.claim))!;
  const transport = prepared.bind(h.run, h.workerSource);
  await desktopRegistry.activate({ sourceKey: "environment-1", ownerEpoch: 7 });
  const close = vi.fn();
  desktopRegistry.attachObserver("environment-1", {
    control: true,
    ownerEpoch: 7,
    close,
  });
  return { h, desktopRegistry, service, prepared, transport, close };
}

describe("agent desktop takeover", () => {
  let viewerRegistry: DesktopSessionRegistry;
  let viewerPort: number;
  let closeViewerServer: () => Promise<void>;
  beforeAll(async () => {
    const fixture = await reserveTestPortListener({
      offsets: [0],
      createListener: () => http.createServer(),
    });
    viewerPort = fixture.claim.port;
    fixture.listener.on("upgrade", (request, socket, head) => {
      handleDesktopObserveUpgrade(request, socket, head, { registry: viewerRegistry });
    });
    closeViewerServer = async () => {
      await fixture.releaseListener();
      await fixture.claim.release();
    };
  });
  afterAll(async () => closeViewerServer());

  async function connectViewer(registry: DesktopSessionRegistry) {
    viewerRegistry = registry;
    const stream = new PassThrough();
    const finished = createDeferredCore<{ error?: { message?: string } }>();
    const owner = registry.createStream({
      sourceKey: "environment-1",
      ownerEpoch: 7,
      onStopped: () => {},
    });
    expect(owner.reserve()).toBe(true);
    onTestFinished(async () => {
      finished.resolve({});
      await owner.stop();
    });
    await owner.connect(
      { attached: Promise.resolve({ stream }), cancel: () => {} },
      () => finished.promise,
    );
    const attachment = owner.publish()!;
    const { token } = mintDesktopObserverToken({
      sourceKey: "environment-1",
      ownerEpoch: 7,
      control: true,
      attachment,
    });
    const ws = new WebSocket(
      "ws://127.0.0.1:" + viewerPort + DESKTOP_OBSERVE_PATH + "?token=" + token,
    );
    const closed = once(ws, "close");
    onTestFinished(async () => {
      ws.terminate();
      stream.destroy();
      await closed;
    });
    await once(ws, "open");
    return { ws, closed, stream };
  }

  async function expectViewerConnected(viewer: Awaited<ReturnType<typeof connectViewer>>) {
    const pong = once(viewer.ws, "pong");
    viewer.ws.ping("viewer-still-open");
    await Promise.race([
      pong,
      viewer.closed.then(() => {
        throw new Error("Reclaimed viewer was disconnected");
      }),
    ]);
    expect(viewer.ws.readyState).toBe(WebSocket.OPEN);
    expect(viewer.stream.destroyed).toBe(false);
  }
  beforeEach(() => {
    resetAgentRunRegistryForTest();
    resetPluginRuntimeStateForTest();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    resetAgentRunRegistryForTest();
    resetPluginRuntimeStateForTest();
  });

  it("takes control through the worker RPC and preserves a later human takeover on replay", async () => {
    const f = await setup();
    const viewer = await connectViewer(f.desktopRegistry);
    const originalInvoke = f.h.privateInvoke.getMockImplementation()!;
    f.h.privateInvoke.mockImplementation(async (invocation) => {
      const result = await originalInvoke(invocation);
      const request = parseNodeWorkerComputerInput(JSON.stringify(invocation.params));
      return result.ok && request.operation === "snapshot"
        ? {
            ...result,
            payload: {
              format: "png",
              width: 1,
              height: 1,
              displayFrameId: "after-takeover",
              base64:
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
            },
          }
        : result;
    });
    const cleanups: Array<(reason: string) => Promise<void>> = [];
    const registerRunCleanup = (cleanup: (reason: string) => Promise<void>) =>
      cleanups.push(cleanup);
    const rpc = createWorkerComputerRpc({
      execute: f.service.execute,
      validate: () => ({ ok: true }),
    });
    const connection = new AbortController();
    let takeoverRequest: WorkerComputerParams | undefined;
    const tool = createWorkerComputerTool({
      descriptor: f.prepared.descriptor,
      runId: f.h.claim.runId,
      registerRunCleanup,
      requestComputer: async (request) => {
        if (JSON.parse(request.paramsJson).action === "__take_control") {
          takeoverRequest = request;
        }
        const result = await rpc(connectionIdentity(f.h), request, connection.signal);
        return result.ok
          ? { type: "res", id: "computer", ok: true, payload: result.result }
          : {
              type: "res",
              id: "computer",
              ok: false,
              error: {
                code: "UNAVAILABLE",
                message:
                  "message" in result
                    ? (result.message ?? "Computer request rejected")
                    : "Computer request rejected",
                details: { reason: "gateway-unavailable" },
              },
            };
      },
    });
    try {
      const result = await tool.execute("resume", { action: "take_control" });
      expect(result.details).toMatchObject({
        action: "take_control",
        frameId: expect.any(String),
      });
      expect(result.content.some((block) => block.type === "image")).toBe(true);
      const [code, reason] = await viewer.closed;
      expect([code, reason.toString()]).toEqual([4000, "control-taken:Agent"]);
      expect(viewer.stream.destroyed).toBe(true);
      expect(f.desktopRegistry.hasController("environment-1", 7)).toBe(false);
      const reclaimed = await connectViewer(f.desktopRegistry);
      f.prepared.bind(f.h.run, f.h.workerSource);
      await expect(tool.execute("resume", { action: "take_control" })).rejects.toThrow(
        "operator took control again",
      );
      await expect(
        tool.execute("still-human", { action: "type", text: "must not type" }),
      ).rejects.toThrow("operator has control");
      await expectViewerConnected(reclaimed);
      expect(takeoverRequest).toBeDefined();
      const keyless = {
        command: takeoverRequest!.command,
        paramsJson: takeoverRequest!.paramsJson,
      };
      for (const request of [keyless, { ...keyless, idempotencyKey: "" }]) {
        await expect(
          rpc(connectionIdentity(f.h), request, connection.signal),
        ).resolves.toMatchObject({
          ok: false,
          message: expect.stringContaining("requires an idempotency key"),
        });
        await expectViewerConnected(reclaimed);
      }
      await tool.execute("resume-again", { action: "take_control" });
      const [nextCode, nextReason] = await reclaimed.closed;
      expect([nextCode, nextReason.toString()]).toEqual([4000, "control-taken:Agent"]);
      expect(reclaimed.stream.destroyed).toBe(true);
      const afterRevocation = await connectViewer(f.desktopRegistry);
      expect(releaseAgentRunDelegatedAuthority(f.h.workerSource.authority)).toBe(true);
      await expect(
        rpc(connectionIdentity(f.h), { ...keyless, idempotencyKey: "revoked" }, connection.signal),
      ).resolves.toMatchObject({
        ok: false,
        message: expect.stringContaining("run authority closed"),
      });
      await expectViewerConnected(afterRevocation);
    } finally {
      await Promise.all(cleanups.map((cleanup) => cleanup("test-complete")));
      await f.service.close();
      await f.desktopRegistry.stopAll();
    }
  });

  it("does not let a pre-takeover screenshot unlock input", async () => {
    const f = await setup();
    const viewerClose = vi.fn();
    f.desktopRegistry.attachObserver("environment-1", {
      control: false,
      ownerEpoch: 7,
      close: viewerClose,
    });
    const entered = createDeferredCore();
    const resume = createDeferredCore();
    f.h.state.afterDispatch = async () => {
      entered.resolve();
      await resume.promise;
    };
    try {
      const pending = f.transport.invoke(snapshot);
      await entered.promise;
      await f.transport.invoke(takeover);
      expect(viewerClose).not.toHaveBeenCalled();
      resume.resolve();
      await pending;
      await expect(f.transport.invoke(input)).rejects.toThrow("fresh screenshot");
      f.h.state.afterDispatch = undefined;
      await f.transport.invoke(snapshot);
      await expect(f.transport.invoke(input)).resolves.toEqual({ ok: true });
    } finally {
      resume.resolve();
      await f.service.close();
      await f.desktopRegistry.stopAll();
    }
  });

  it.each(["placement", "grant", "deny", "epoch"] as const)(
    "does not evict a controller after %s revocation",
    async (reason) => {
      const f = await setup();
      const assertAuthorized = () => {
        if (reason === "grant") {
          throw new Error("grant revoked");
        }
      };
      if (reason === "placement") {
        f.h.releaseClaim();
      }
      if (reason === "deny") {
        f.h.state.config = { gateway: { nodes: { commands: { deny: ["computer.act"] } } } };
      }
      if (reason === "epoch") {
        f.desktopRegistry.claimOwnerEpoch("environment-1", 8);
      }
      try {
        await expect(f.transport.invoke(takeover, assertAuthorized)).rejects.toThrow();
        expect(f.close).not.toHaveBeenCalled();
        expect(f.desktopRegistry.hasController("environment-1", 7)).toBe(true);
      } finally {
        await f.service.close();
        await f.desktopRegistry.stopAll();
      }
    },
  );
});
