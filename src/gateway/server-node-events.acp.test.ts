import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliDeps } from "../cli/deps.js";
import type { HealthSummary } from "../commands/health.js";
import type { NodeEventContext } from "./server-node-events-types.js";

vi.mock("../channels/plugins/index.js", () => ({
  normalizeChannelId: vi.fn(),
}));
vi.mock("../cli/outbound-send-deps.js", () => ({
  createOutboundSendDeps: vi.fn(() => ({})),
}));
vi.mock("../commands/agent.js", () => ({
  agentCommandFromIngress: vi.fn(),
}));
vi.mock("../config/config.js", () => ({
  loadConfig: vi.fn(() => ({ session: { mainKey: "agent:main:main" } })),
}));
vi.mock("../config/sessions.js", () => ({
  updateSessionStore: vi.fn(),
}));
vi.mock("../infra/device-identity.js", () => ({
  loadOrCreateDeviceIdentity: vi.fn(),
}));
vi.mock("../infra/heartbeat-wake.js", () => ({
  requestHeartbeatNow: vi.fn(),
}));
vi.mock("../infra/outbound/deliver.js", () => ({
  deliverOutboundPayloads: vi.fn(),
}));
vi.mock("../infra/outbound/session-context.js", () => ({
  buildOutboundSessionContext: vi.fn(() => ({})),
}));
vi.mock("../infra/outbound/targets.js", () => ({
  resolveOutboundTarget: vi.fn(() => ({ ok: true, to: "target" })),
}));
vi.mock("../infra/push-apns.js", () => ({
  registerApnsRegistration: vi.fn(),
}));
vi.mock("../infra/system-events.js", () => ({
  enqueueSystemEvent: vi.fn(),
}));
vi.mock("../routing/session-key.js", () => ({
  normalizeMainKey: vi.fn((value: string) => value),
  scopedHeartbeatWakeOptions: vi.fn(() => undefined),
}));
vi.mock("../runtime.js", () => ({
  defaultRuntime: {},
}));
vi.mock("./chat-attachments.js", () => ({
  parseMessageWithAttachments: vi.fn(async () => ({ message: "", images: [] })),
}));
vi.mock("./server-methods/attachment-normalize.js", () => ({
  normalizeRpcAttachmentsToChatAttachments: vi.fn(() => []),
}));
vi.mock("./session-utils.js", () => ({
  loadSessionEntry: vi.fn(),
  migrateAndPruneGatewaySessionStoreKey: vi.fn(),
}));
vi.mock("./ws-log.js", () => ({
  formatForLog: vi.fn((value: unknown) => String(value)),
}));

const { AcpGatewayNodeRuntime, __testing: acpGatewayTesting } =
  await import("../acp/store/gateway-events.js");
const { AcpGatewayStore } = await import("../acp/store/store.js");
const { handleNodeDisconnect, handleNodeEvent } = await import("./server-node-events.js");

function buildCtx(): NodeEventContext {
  return {
    deps: {} as CliDeps,
    broadcast: () => {},
    nodeSendToSession: () => {},
    nodeSubscribe: () => {},
    nodeUnsubscribe: () => {},
    broadcastVoiceWakeChanged: () => {},
    addChatRun: () => {},
    removeChatRun: () => undefined,
    chatAbortControllers: new Map(),
    chatAbortedRuns: new Map(),
    chatRunBuffers: new Map(),
    chatDeltaSentAt: new Map(),
    dedupe: new Map(),
    agentRunSeq: new Map(),
    getHealthCache: () => null,
    refreshHealthSnapshot: async () => ({}) as HealthSummary,
    loadGatewayModelCatalog: async () => [],
    logGateway: { warn: () => {} },
  };
}

const tempRoots: string[] = [];

afterEach(async () => {
  acpGatewayTesting.resetAcpGatewayNodeRuntimeForTests();
  await Promise.all(
    tempRoots.splice(0).map(async (root) => await fs.rm(root, { recursive: true, force: true })),
  );
});

describe("handleNodeEvent ACP worker ingress", () => {
  async function createRuntime() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-server-node-events-acp-"));
    tempRoots.push(root);
    const runtime = new AcpGatewayNodeRuntime(
      new AcpGatewayStore({
        storePath: path.join(root, "acp", "gateway-node-runtime-store.json"),
      }),
    );
    acpGatewayTesting.setAcpGatewayNodeRuntimeForTests(runtime);
    return runtime;
  }

  it("persists ACP worker events and terminals through handleNodeEvent", async () => {
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

    await handleNodeEvent(buildCtx(), "node-1", {
      event: "acp.worker.event",
      payloadJSON: JSON.stringify({
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
      }),
    });
    await handleNodeEvent(buildCtx(), "node-1", {
      event: "acp.worker.terminal",
      payloadJSON: JSON.stringify({
        nodeId: "node-1",
        sessionKey: "agent:main:acp:test-session",
        runId: "run-1",
        leaseId: lease.leaseId,
        leaseEpoch: lease.leaseEpoch,
        terminalEventId: "term-1",
        finalSeq: 1,
        terminal: {
          kind: "completed",
          stopReason: "end_turn",
        },
      }),
    });

    expect(await runtime.store.listRunEvents("run-1")).toMatchObject([
      {
        seq: 1,
        event: {
          type: "text_delta",
          text: "hello",
        },
      },
    ]);
    expect(await runtime.store.getRun("run-1")).toMatchObject({
      state: "completed",
      terminal: {
        terminalEventId: "term-1",
      },
    });
  });

  it("rejects event.type=done before mutating durable state", async () => {
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

    await expect(
      handleNodeEvent(buildCtx(), "node-1", {
        event: "acp.worker.event",
        payloadJSON: JSON.stringify({
          nodeId: "node-1",
          sessionKey: "agent:main:acp:test-session",
          runId: "run-1",
          leaseId: lease.leaseId,
          leaseEpoch: lease.leaseEpoch,
          seq: 1,
          event: {
            type: "done",
          },
        }),
      }),
    ).rejects.toMatchObject({
      code: "ACP_NODE_INVALID_EVENT",
    });
    expect(await runtime.store.listRunEvents("run-1")).toHaveLength(0);
  });

  it("recovers through gateway disconnect plus heartbeat reconnect before accepting a terminal", async () => {
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
    await handleNodeEvent(buildCtx(), "node-1", {
      event: "acp.worker.event",
      payloadJSON: JSON.stringify({
        nodeId: "node-1",
        sessionKey: "agent:main:acp:test-session",
        runId: "run-1",
        leaseId: lease.leaseId,
        leaseEpoch: lease.leaseEpoch,
        seq: 1,
        event: {
          type: "status",
          text: "working",
        },
      }),
    });
    await handleNodeDisconnect("node-1", {
      now: 11,
    });

    await expect(
      handleNodeEvent(buildCtx(), "node-1", {
        event: "acp.worker.terminal",
        payloadJSON: JSON.stringify({
          nodeId: "node-1",
          sessionKey: "agent:main:acp:test-session",
          runId: "run-1",
          leaseId: lease.leaseId,
          leaseEpoch: lease.leaseEpoch,
          terminalEventId: "term-1",
          finalSeq: 1,
          terminal: {
            kind: "completed",
          },
        }),
      }),
    ).rejects.toMatchObject({
      code: "ACP_NODE_ACTIVE_LEASE_MISSING",
    });

    await handleNodeEvent(buildCtx(), "node-1", {
      event: "acp.worker.heartbeat",
      payloadJSON: JSON.stringify({
        nodeId: "node-1",
        sessionKey: "agent:main:acp:test-session",
        runId: "run-1",
        leaseId: lease.leaseId,
        leaseEpoch: lease.leaseEpoch,
        state: "running",
        nodeRuntimeSessionId: "runtime-1",
        nodeWorkerRunId: "worker-1",
        workerProtocolVersion: 1,
        ts: 12,
      }),
    });

    expect(await runtime.store.getActiveLease("agent:main:acp:test-session")).toMatchObject({
      state: "active",
      nodeRuntimeSessionId: "runtime-1",
      nodeWorkerRunId: "worker-1",
      workerProtocolVersion: 1,
    });
    expect(await runtime.store.getRun("run-1")).toMatchObject({
      state: "running",
    });

    await expect(
      handleNodeEvent(buildCtx(), "node-1", {
        event: "acp.worker.terminal",
        payloadJSON: JSON.stringify({
          nodeId: "node-1",
          sessionKey: "agent:main:acp:test-session",
          runId: "run-1",
          leaseId: lease.leaseId,
          leaseEpoch: lease.leaseEpoch,
          terminalEventId: "term-1",
          finalSeq: 1,
          terminal: {
            kind: "completed",
          },
        }),
      }),
    ).resolves.toBeUndefined();

    expect(await runtime.store.getRun("run-1")).toMatchObject({
      state: "completed",
      terminal: {
        terminalEventId: "term-1",
      },
    });
  });
});
