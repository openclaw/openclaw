import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AcpGatewayStore } from "../acp/store/file-store.js";
import { FakeAcpNodeWorker } from "../acp/testing/fake-node-worker.js";
import { handleAcpWorkerNodeEvent } from "./server-node-events-acp.js";

const tempRoots: string[] = [];

async function createStore() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "acp-node-events-"));
  tempRoots.push(root);
  return new AcpGatewayStore(path.join(root, "gateway-store.json"));
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      await fs.rm(root, { recursive: true, force: true });
    }
  }
});

function buildContext(store: AcpGatewayStore) {
  return {
    acpGatewayStore: store,
    logGateway: {
      warn: vi.fn(),
    },
  };
}

async function invokeAcpWorkerEvent(params: {
  context: ReturnType<typeof buildContext>;
  nodeId: string;
  event: string;
  payload: Record<string, unknown>;
}) {
  return await handleAcpWorkerNodeEvent({
    context: params.context,
    nodeId: params.nodeId,
    event: params.event,
    payloadJSON: JSON.stringify(params.payload),
  });
}

describe("ACP worker node events", () => {
  it("ingests fake worker events through node.event and persists canonical terminal state", async () => {
    const store = await createStore();
    const context = buildContext(store);
    const started = await store.startRun({
      sessionKey: "agent:main:acp:test",
      runId: "run-1",
      requestId: "req-1",
      nodeId: "node-1",
      leaseId: "lease-1",
      leaseEpoch: 1,
    });
    expect(started.ok).toBe(true);

    const worker = new FakeAcpNodeWorker(
      async ({ event, nodeId, payload }) => {
        const response = await invokeAcpWorkerEvent({
          context,
          nodeId,
          event,
          payload,
        });
        if (!response.ok) {
          throw new Error(JSON.stringify(response.error));
        }
      },
      {
        sessionKey: "agent:main:acp:test",
        runId: "run-1",
        nodeId: "node-1",
        leaseId: "lease-1",
        leaseEpoch: 1,
      },
    );

    await worker.run([
      { kind: "heartbeat" },
      {
        kind: "event",
        seq: 1,
        eventId: "evt-1",
        event: { type: "text_delta", text: "hello" },
      },
      {
        kind: "terminal",
        finalSeq: 1,
        terminalEventId: "terminal-1",
        result: { status: "completed", stopReason: "done" },
      },
    ]);

    const snapshot = await store.readSnapshot();
    expect(snapshot.sessions["agent:main:acp:test"]?.state).toBe("idle");
    expect(snapshot.sessions["agent:main:acp:test"]?.lease?.lastHeartbeatAt).toBeTypeOf("number");
    expect(snapshot.runs["run-1"]?.state).toBe("completed");
    expect(snapshot.runs["run-1"]?.terminal?.terminalEventId).toBe("terminal-1");
    expect(snapshot.events["evt-1"]?.kind).toBe("event");
    expect(snapshot.events["terminal-1"]?.kind).toBe("terminal");
  });

  it("rejects stale epochs before mutating store state", async () => {
    const store = await createStore();
    const context = buildContext(store);
    await store.startRun({
      sessionKey: "agent:main:acp:test",
      runId: "run-1",
      requestId: "req-1",
      nodeId: "node-1",
      leaseId: "lease-1",
      leaseEpoch: 1,
    });
    await store.startRun({
      sessionKey: "agent:main:acp:test",
      runId: "run-2",
      requestId: "req-2",
      nodeId: "node-1",
      leaseId: "lease-2",
      leaseEpoch: 2,
    });

    const response = await invokeAcpWorkerEvent({
      context,
      nodeId: "node-1",
      event: "acp.worker.event",
      payload: {
        sessionKey: "agent:main:acp:test",
        runId: "run-1",
        nodeId: "node-1",
        leaseId: "lease-1",
        leaseEpoch: 1,
        seq: 1,
        eventId: "evt-stale",
        event: { type: "text_delta", text: "late" },
      },
    });

    expect(response.ok).toBe(false);
    if (response.ok) {
      return;
    }
    expect(response.error).toMatchObject({
      code: "INVALID_REQUEST",
      details: { code: "ACP_LEASE_EPOCH_STALE" },
    });
    const snapshot = await store.readSnapshot();
    expect(snapshot.events["evt-stale"]).toBeUndefined();
  });

  it("rejects done events on acp.worker.event and accepts acp.worker.terminal", async () => {
    const store = await createStore();
    const context = buildContext(store);
    await store.startRun({
      sessionKey: "agent:main:acp:test",
      runId: "run-1",
      requestId: "req-1",
      nodeId: "node-1",
      leaseId: "lease-1",
      leaseEpoch: 1,
    });

    const badEvent = await invokeAcpWorkerEvent({
      context,
      nodeId: "node-1",
      event: "acp.worker.event",
      payload: {
        sessionKey: "agent:main:acp:test",
        runId: "run-1",
        nodeId: "node-1",
        leaseId: "lease-1",
        leaseEpoch: 1,
        seq: 1,
        eventId: "evt-done",
        event: { type: "done" },
      },
    });
    expect(badEvent.ok).toBe(false);
    if (badEvent.ok) {
      return;
    }
    expect(badEvent.error).toMatchObject({
      code: "INVALID_REQUEST",
      details: { code: "ACP_EVENT_DONE_NOT_ALLOWED" },
    });

    const terminal = await invokeAcpWorkerEvent({
      context,
      nodeId: "node-1",
      event: "acp.worker.terminal",
      payload: {
        sessionKey: "agent:main:acp:test",
        runId: "run-1",
        nodeId: "node-1",
        leaseId: "lease-1",
        leaseEpoch: 1,
        finalSeq: 1,
        terminalEventId: "terminal-1",
        result: {
          status: "canceled",
          stopReason: "stop",
        },
      },
    });
    expect(terminal.ok).toBe(true);
    const snapshot = await store.readSnapshot();
    expect(snapshot.events["evt-done"]).toBeUndefined();
    expect(snapshot.runs["run-1"]?.terminal?.terminalEventId).toBe("terminal-1");
    expect(snapshot.runs["run-1"]?.state).toBe("canceled");
  });
});
