import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliDeps } from "../../cli/deps.js";
import type { HealthSummary } from "../../commands/health.js";

vi.mock("../../channels/plugins/index.js", () => ({
  normalizeChannelId: vi.fn(),
}));
vi.mock("../../cli/outbound-send-deps.js", () => ({
  createOutboundSendDeps: vi.fn(() => ({})),
}));
vi.mock("../../commands/agent.js", () => ({
  agentCommandFromIngress: vi.fn(),
}));
vi.mock("../../config/config.js", () => ({
  loadConfig: vi.fn(() => ({ session: { mainKey: "agent:main:main" } })),
}));
vi.mock("../../config/sessions.js", () => ({
  updateSessionStore: vi.fn(),
}));
vi.mock("../../infra/device-identity.js", () => ({
  loadOrCreateDeviceIdentity: vi.fn(),
}));
vi.mock("../../infra/heartbeat-wake.js", () => ({
  requestHeartbeatNow: vi.fn(),
}));
vi.mock("../../infra/outbound/deliver.js", () => ({
  deliverOutboundPayloads: vi.fn(),
}));
vi.mock("../../infra/outbound/session-context.js", () => ({
  buildOutboundSessionContext: vi.fn(() => ({})),
}));
vi.mock("../../infra/outbound/targets.js", () => ({
  resolveOutboundTarget: vi.fn(() => ({ ok: true, to: "target" })),
}));
vi.mock("../../infra/push-apns.js", () => ({
  registerApnsRegistration: vi.fn(),
}));
vi.mock("../../infra/system-events.js", () => ({
  enqueueSystemEvent: vi.fn(),
}));
vi.mock("../../routing/session-key.js", () => ({
  normalizeMainKey: vi.fn((value: string) => value),
  scopedHeartbeatWakeOptions: vi.fn(() => undefined),
}));
vi.mock("../../runtime.js", () => ({
  defaultRuntime: {},
}));
vi.mock("../chat-attachments.js", () => ({
  parseMessageWithAttachments: vi.fn(async () => ({ message: "", images: [] })),
}));
vi.mock("./attachment-normalize.js", () => ({
  normalizeRpcAttachmentsToChatAttachments: vi.fn(() => []),
}));
vi.mock("../session-utils.js", () => ({
  loadSessionEntry: vi.fn(),
  migrateAndPruneGatewaySessionStoreKey: vi.fn(),
}));
vi.mock("../ws-log.js", () => ({
  formatForLog: vi.fn((value: unknown) => String(value)),
}));

const { AcpGatewayNodeRuntime, __testing: acpGatewayTesting } =
  await import("../../acp/store/gateway-events.js");
const { AcpGatewayStore, AcpGatewayStoreError } = await import("../../acp/store/store.js");
const { nodeHandlers } = await import("./nodes.js");

const tempRoots: string[] = [];

function buildContext() {
  return {
    deps: {} as CliDeps,
    cron: {} as never,
    cronStorePath: "/tmp/cron.json",
    loadGatewayModelCatalog: async () => [],
    getHealthCache: () => null,
    refreshHealthSnapshot: async () => ({}) as HealthSummary,
    logHealth: { error: vi.fn() },
    logGateway: { warn: vi.fn(), debug: vi.fn() },
    incrementPresenceVersion: vi.fn(() => 1),
    getHealthVersion: vi.fn(() => 1),
    broadcast: vi.fn(),
    broadcastToConnIds: vi.fn(),
    nodeSendToSession: vi.fn(),
    nodeSendToAllSubscribed: vi.fn(),
    nodeSubscribe: vi.fn(),
    nodeUnsubscribe: vi.fn(),
    nodeUnsubscribeAll: vi.fn(),
    hasConnectedMobileNode: vi.fn(() => false),
    nodeRegistry: {
      handleInvokeResult: vi.fn(),
      get: vi.fn(),
      invoke: vi.fn(),
    },
    agentRunSeq: new Map(),
    chatAbortControllers: new Map(),
    chatAbortedRuns: new Map(),
    chatRunBuffers: new Map(),
    chatDeltaSentAt: new Map(),
    addChatRun: vi.fn(),
    removeChatRun: vi.fn(),
    registerToolEventRecipient: vi.fn(),
    dedupe: new Map(),
    wizardSessions: new Map(),
    findRunningWizard: vi.fn(() => null),
    purgeWizardSession: vi.fn(),
    getRuntimeSnapshot: vi.fn(),
    startChannel: vi.fn(),
    stopChannel: vi.fn(),
    markChannelLoggedOut: vi.fn(),
    wizardRunner: vi.fn(),
    broadcastVoiceWakeChanged: vi.fn(),
  } as never;
}

afterEach(async () => {
  acpGatewayTesting.resetAcpGatewayNodeRuntimeForTests();
  await Promise.all(
    tempRoots.splice(0).map(async (root) => await fs.rm(root, { recursive: true, force: true })),
  );
});

describe("nodeHandlers node.event ACP ingress", () => {
  async function createRuntime() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-node-event-acp-"));
    tempRoots.push(root);
    const runtime = new AcpGatewayNodeRuntime(
      new AcpGatewayStore({
        storePath: path.join(root, "acp", "gateway-node-runtime-store.json"),
      }),
    );
    acpGatewayTesting.setAcpGatewayNodeRuntimeForTests(runtime);
    return runtime;
  }

  it("routes live node.event ACP worker traffic into the durable gateway runtime", async () => {
    const runtime = await createRuntime();
    const lease = await runtime.store.acquireLease({
      sessionKey: "agent:main:acp:test-session",
      nodeId: "node-1",
      leaseId: "lease-1",
      now: 10,
    });
    await runtime.store.startRun({
      sessionKey: "agent:main:acp:test-session",
      runId: "run-1",
      requestId: "req-1",
      now: 10,
    });
    const respond = vi.fn();

    await nodeHandlers["node.event"]({
      params: {
        event: "acp.worker.event",
        payload: {
          nodeId: "node-1",
          sessionKey: "agent:main:acp:test-session",
          runId: "run-1",
          leaseId: lease.leaseId,
          leaseEpoch: lease.leaseEpoch,
          seq: 1,
          event: {
            type: "text_delta",
            stream: "output",
            text: "hello",
          },
        },
      },
      respond,
      context: buildContext(),
      client: {
        connect: {
          role: "node",
          client: {
            id: "node-1",
            mode: "node",
            name: "node",
            platform: "linux",
            version: "test",
          },
        },
      } as never,
      req: { type: "req", id: "req-1", method: "node.event" },
      isWebchatConnect: () => false,
    });

    expect(respond).toHaveBeenCalledWith(true, { ok: true }, undefined);
    expect(await runtime.store.listRunEvents("run-1")).toMatchObject([
      {
        seq: 1,
        event: {
          type: "text_delta",
          text: "hello",
        },
      },
    ]);
  });

  it("maps ACP worker validation failures to INVALID_REQUEST on the live RPC path", async () => {
    const runtime = await createRuntime();
    const lease = await runtime.store.acquireLease({
      sessionKey: "agent:main:acp:test-session",
      nodeId: "node-1",
      leaseId: "lease-1",
      now: 10,
    });
    await runtime.store.startRun({
      sessionKey: "agent:main:acp:test-session",
      runId: "run-1",
      requestId: "req-1",
      now: 10,
    });
    const respond = vi.fn();

    await nodeHandlers["node.event"]({
      params: {
        event: "acp.worker.event",
        payload: {
          nodeId: "node-1",
          sessionKey: "agent:main:acp:test-session",
          runId: "run-1",
          leaseId: lease.leaseId,
          leaseEpoch: lease.leaseEpoch,
          seq: 1,
          event: {
            type: "done",
          },
        },
      },
      respond,
      context: buildContext(),
      client: {
        connect: {
          role: "node",
          client: {
            id: "node-1",
            mode: "node",
            name: "node",
            platform: "linux",
            version: "test",
          },
        },
      } as never,
      req: { type: "req", id: "req-2", method: "node.event" },
      isWebchatConnect: () => false,
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: expect.stringContaining("event.type=done"),
        details: {
          code: "ACP_NODE_INVALID_EVENT",
        },
      }),
    );
    expect(await runtime.store.listRunEvents("run-1")).toHaveLength(0);
  });

  it("rejects unsupported acp.worker.status explicitly on the live RPC path", async () => {
    const runtime = await createRuntime();
    const lease = await runtime.store.acquireLease({
      sessionKey: "agent:main:acp:test-session",
      nodeId: "node-1",
      leaseId: "lease-1",
      now: 10,
    });
    await runtime.store.startRun({
      sessionKey: "agent:main:acp:test-session",
      runId: "run-1",
      requestId: "req-1",
      now: 10,
    });
    const respond = vi.fn();

    await nodeHandlers["node.event"]({
      params: {
        event: "acp.worker.status",
        payload: {
          nodeId: "node-1",
          sessionKey: "agent:main:acp:test-session",
          runId: "run-1",
          leaseId: lease.leaseId,
          leaseEpoch: lease.leaseEpoch,
        },
      },
      respond,
      context: buildContext(),
      client: {
        connect: {
          role: "node",
          client: {
            id: "node-1",
            mode: "node",
            name: "node",
            platform: "linux",
            version: "test",
          },
        },
      } as never,
      req: { type: "req", id: "req-3", method: "node.event" },
      isWebchatConnect: () => false,
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: expect.stringContaining("Unsupported ACP worker event"),
        details: {
          code: "ACP_NODE_INVALID_EVENT",
        },
      }),
    );
  });

  it("maps gateway durability failures to UNAVAILABLE on the live RPC path", async () => {
    acpGatewayTesting.setAcpGatewayNodeRuntimeForTests({
      store: {} as never,
      ingestNodeEvent: async () => {
        throw new AcpGatewayStoreError("ACP_NODE_STORE_WRITE_FAILED", "disk full");
      },
      markNodeDisconnected: async () => ({ sessions: [], runs: [] }),
      reconcileSuspectLease: async () => ({}) as never,
      expireSuspectLeases: async () => ({ sessions: [], runs: [], leases: [] }),
      querySessionStatus: async () => ({}) as never,
      reconcileConnectedNodeLeases: async () => ({ reconciled: [], lost: [] }),
      ensureSession: async () => ({ ok: true }),
      loadSession: async () => ({ ok: true }),
      startTurn: async () => ({ ok: true }),
      cancelTurn: async () => ({ ok: true }),
      closeSession: async () => ({ ok: true }),
    } as never);
    const respond = vi.fn();

    await nodeHandlers["node.event"]({
      params: {
        event: "acp.worker.event",
        payload: {
          nodeId: "node-1",
          sessionKey: "agent:main:acp:test-session",
          runId: "run-1",
          leaseId: "lease-1",
          leaseEpoch: 1,
          seq: 1,
          event: {
            type: "text_delta",
            text: "hello",
          },
        },
      },
      respond,
      context: buildContext(),
      client: {
        connect: {
          role: "node",
          client: {
            id: "node-1",
            mode: "node",
            name: "node",
            platform: "linux",
            version: "test",
          },
        },
      } as never,
      req: { type: "req", id: "req-4", method: "node.event" },
      isWebchatConnect: () => false,
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "UNAVAILABLE",
        message: "disk full",
        details: {
          code: "ACP_NODE_STORE_WRITE_FAILED",
        },
      }),
    );
  });
});
