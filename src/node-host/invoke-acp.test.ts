import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __testing as runtimeRegistryTesting,
  registerAcpRuntimeBackend,
  unregisterAcpRuntimeBackend,
} from "../acp/runtime/registry.js";
import type {
  AcpRuntime,
  AcpRuntimeEnsureInput,
  AcpRuntimeEvent,
  AcpRuntimeHandle,
  AcpRuntimeTurnInput,
} from "../acp/runtime/types.js";
import { __testing, handleAcpInvokeCommand } from "./invoke-acp.js";
import type { NodeInvokeRequestPayload } from "./invoke.js";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (error?: unknown) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  let reject!: Deferred<T>["reject"];
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type NodeEventCall = {
  event: string;
  payload: unknown;
};

class FakeNodeHostRuntime implements AcpRuntime {
  readonly ensured: AcpRuntimeEnsureInput[] = [];
  readonly turns: AcpRuntimeTurnInput[] = [];
  readonly cancelled: Array<{ handle: AcpRuntimeHandle; reason?: string }> = [];
  readonly closed: Array<{ handle: AcpRuntimeHandle; reason: string }> = [];
  statusError: Error | null = null;
  rewriteStopReasonOnCancel = true;

  private readonly readyToEmit = createDeferred<void>();
  private readonly releaseTurn = createDeferred<void>();
  private readonly finished = createDeferred<void>();
  private nextStopReason = "done";

  async ensureSession(input: AcpRuntimeEnsureInput): Promise<AcpRuntimeHandle> {
    this.ensured.push(input);
    return {
      sessionKey: input.sessionKey,
      backend: "acpx",
      runtimeSessionName: `acpx:v1:${input.sessionKey}`,
      backendSessionId: "acpx-session-1",
      ...(input.cwd ? { cwd: input.cwd } : {}),
    };
  }

  async *runTurn(input: AcpRuntimeTurnInput): AsyncIterable<AcpRuntimeEvent> {
    this.turns.push(input);
    this.readyToEmit.resolve();
    await this.releaseTurn.promise;
    yield {
      type: "text_delta",
      stream: "output",
      text: "hello from runtime",
      tag: "agent_message_chunk",
    };
    yield {
      type: "status",
      text: "runtime step",
      tag: "session_info_update",
    };
    yield {
      type: "done",
      stopReason: this.nextStopReason,
    };
    this.finished.resolve();
  }

  async getStatus(): Promise<{ summary: string }> {
    if (this.statusError) {
      throw this.statusError;
    }
    return {
      summary: "local runtime ready",
    };
  }

  async cancel(input: { handle: AcpRuntimeHandle; reason?: string }): Promise<void> {
    this.cancelled.push(input);
    if (this.rewriteStopReasonOnCancel) {
      this.nextStopReason = input.reason ?? "cancelled";
    }
    this.releaseTurn.resolve();
  }

  async close(input: { handle: AcpRuntimeHandle; reason: string }): Promise<void> {
    this.closed.push(input);
  }

  async waitForTurnStart() {
    await this.readyToEmit.promise;
  }

  releaseTurnToComplete(stopReason = "done") {
    this.nextStopReason = stopReason;
    this.releaseTurn.resolve();
  }

  async waitForTurnFinish() {
    await this.finished.promise;
  }
}

afterEach(async () => {
  unregisterAcpRuntimeBackend("acpx");
  runtimeRegistryTesting.resetAcpRuntimeBackendsForTests();
  __testing.resetNodeAcpSessionsForTests();
  await __testing.resetNodeAcpRuntimeBootstrapForTests();
});

function buildFrame(params: {
  command: string;
  nodeId?: string;
  payload: Record<string, unknown>;
}): NodeInvokeRequestPayload {
  return {
    id: "invoke-1",
    nodeId: params.nodeId ?? "node-1",
    command: params.command,
    paramsJSON: JSON.stringify(params.payload),
  };
}

function buildDeps(sendNodeEvent?: (event: string, payload: unknown) => Promise<void>) {
  return {
    ensureRuntimeReady: async () => {},
    loadConfig: () => ({
      acp: {
        backend: "acpx",
      },
    }),
    sendNodeEvent,
  };
}

describe("handleAcpInvokeCommand", () => {
  it("runs a real local runtime turn and emits canonical ACP worker traffic", async () => {
    const runtime = new FakeNodeHostRuntime();
    registerAcpRuntimeBackend({
      id: "acpx",
      runtime,
    });
    const nodeEvents: NodeEventCall[] = [];

    const ensured = await handleAcpInvokeCommand(
      buildFrame({
        command: "acp.session.ensure",
        payload: {
          sessionKey: "agent:main:acp:test",
          leaseId: "lease-1",
          leaseEpoch: 1,
          agent: "main",
          mode: "persistent",
          cwd: "/workspace",
        },
      }),
      buildDeps(async (event, payload) => {
        nodeEvents.push({ event, payload });
      }),
    );
    expect(ensured).toMatchObject({
      handled: true,
      ok: true,
      payload: {
        sessionKey: "agent:main:acp:test",
        leaseId: "lease-1",
        leaseEpoch: 1,
        nodeRuntimeSessionId: "acpx-session-1",
      },
    });

    const started = await handleAcpInvokeCommand(
      buildFrame({
        command: "acp.turn.start",
        payload: {
          sessionKey: "agent:main:acp:test",
          runId: "run-1",
          leaseId: "lease-1",
          leaseEpoch: 1,
          requestId: "req-1",
          mode: "prompt",
          text: "hello",
        },
      }),
      buildDeps(async (event, payload) => {
        nodeEvents.push({ event, payload });
      }),
    );
    expect(started).toMatchObject({
      handled: true,
      ok: true,
      payload: {
        accepted: true,
        runId: "run-1",
        nodeWorkerRunId: expect.any(String),
      },
    });

    await runtime.waitForTurnStart();

    const runningStatus = await handleAcpInvokeCommand(
      buildFrame({
        command: "acp.session.status",
        payload: {
          sessionKey: "agent:main:acp:test",
          leaseId: "lease-1",
          leaseEpoch: 1,
        },
      }),
      buildDeps(),
    );
    expect(runningStatus).toMatchObject({
      handled: true,
      ok: true,
      payload: {
        state: "running",
        nodeRuntimeSessionId: "acpx-session-1",
        nodeWorkerRunId: expect.any(String),
        details: {
          summary: "local runtime ready",
        },
      },
    });

    runtime.releaseTurnToComplete("end_turn");
    await runtime.waitForTurnFinish();

    await vi.waitFor(() => {
      expect(nodeEvents).toHaveLength(3);
    });
    expect(nodeEvents).toEqual([
      {
        event: "acp.worker.event",
        payload: {
          nodeId: "node-1",
          sessionKey: "agent:main:acp:test",
          runId: "run-1",
          leaseId: "lease-1",
          leaseEpoch: 1,
          seq: 1,
          event: {
            type: "text_delta",
            stream: "output",
            text: "hello from runtime",
            tag: "agent_message_chunk",
          },
        },
      },
      {
        event: "acp.worker.event",
        payload: {
          nodeId: "node-1",
          sessionKey: "agent:main:acp:test",
          runId: "run-1",
          leaseId: "lease-1",
          leaseEpoch: 1,
          seq: 2,
          event: {
            type: "status",
            text: "runtime step",
            tag: "session_info_update",
          },
        },
      },
      {
        event: "acp.worker.terminal",
        payload: {
          nodeId: "node-1",
          sessionKey: "agent:main:acp:test",
          runId: "run-1",
          leaseId: "lease-1",
          leaseEpoch: 1,
          terminalEventId: expect.any(String),
          finalSeq: 2,
          terminal: {
            kind: "completed",
            stopReason: "end_turn",
          },
        },
      },
    ]);

    const idleStatus = await handleAcpInvokeCommand(
      buildFrame({
        command: "acp.session.status",
        payload: {
          sessionKey: "agent:main:acp:test",
          leaseId: "lease-1",
          leaseEpoch: 1,
        },
      }),
      buildDeps(),
    );
    expect(idleStatus).toMatchObject({
      handled: true,
      ok: true,
      payload: {
        state: "idle",
        nodeRuntimeSessionId: "acpx-session-1",
      },
    });
  });

  it("delegates cancel and close to the real runtime instead of local bookkeeping", async () => {
    const runtime = new FakeNodeHostRuntime();
    registerAcpRuntimeBackend({
      id: "acpx",
      runtime,
    });
    const nodeEvents: NodeEventCall[] = [];

    await handleAcpInvokeCommand(
      buildFrame({
        command: "acp.session.ensure",
        payload: {
          sessionKey: "agent:main:acp:test",
          leaseId: "lease-1",
          leaseEpoch: 1,
          agent: "main",
          mode: "persistent",
        },
      }),
      buildDeps(async (event, payload) => {
        nodeEvents.push({ event, payload });
      }),
    );

    await handleAcpInvokeCommand(
      buildFrame({
        command: "acp.turn.start",
        payload: {
          sessionKey: "agent:main:acp:test",
          runId: "run-cancel",
          leaseId: "lease-1",
          leaseEpoch: 1,
          requestId: "req-cancel",
          mode: "prompt",
          text: "cancel me",
        },
      }),
      buildDeps(async (event, payload) => {
        nodeEvents.push({ event, payload });
      }),
    );

    await runtime.waitForTurnStart();

    const cancelled = await handleAcpInvokeCommand(
      buildFrame({
        command: "acp.turn.cancel",
        payload: {
          sessionKey: "agent:main:acp:test",
          runId: "run-cancel",
          leaseId: "lease-1",
          leaseEpoch: 1,
          reason: "manual-cancel",
        },
      }),
      buildDeps(),
    );
    expect(cancelled).toMatchObject({
      handled: true,
      ok: true,
      payload: {
        accepted: true,
      },
    });
    expect(runtime.cancelled).toMatchObject([
      {
        reason: "manual-cancel",
      },
    ]);

    const cancellingStatus = await handleAcpInvokeCommand(
      buildFrame({
        command: "acp.session.status",
        payload: {
          sessionKey: "agent:main:acp:test",
          leaseId: "lease-1",
          leaseEpoch: 1,
        },
      }),
      buildDeps(),
    );
    expect(cancellingStatus).toMatchObject({
      handled: true,
      ok: true,
      payload: {
        state: "cancelling",
      },
    });

    await runtime.waitForTurnFinish();
    await vi.waitFor(() => {
      expect(nodeEvents.at(-1)).toMatchObject({
        event: "acp.worker.terminal",
        payload: {
          runId: "run-cancel",
          terminal: {
            kind: "cancelled",
            stopReason: "manual-cancel",
          },
        },
      });
    });

    const closed = await handleAcpInvokeCommand(
      buildFrame({
        command: "acp.session.close",
        payload: {
          sessionKey: "agent:main:acp:test",
          leaseId: "lease-1",
          leaseEpoch: 1,
          reason: "cleanup",
        },
      }),
      buildDeps(),
    );
    expect(closed).toMatchObject({
      handled: true,
      ok: true,
      payload: {
        accepted: true,
      },
    });
    expect(runtime.closed).toMatchObject([
      {
        reason: "cleanup",
      },
    ]);

    const missingStatus = await handleAcpInvokeCommand(
      buildFrame({
        command: "acp.session.status",
        payload: {
          sessionKey: "agent:main:acp:test",
          leaseId: "lease-1",
          leaseEpoch: 1,
        },
      }),
      buildDeps(),
    );
    expect(missingStatus).toMatchObject({
      handled: true,
      ok: true,
      payload: {
        state: "missing",
      },
    });
  });

  it("treats a replayed fast-finished start with the same runId and requestId as idempotent", async () => {
    const runtime = new FakeNodeHostRuntime();
    registerAcpRuntimeBackend({
      id: "acpx",
      runtime,
    });
    const nodeEvents: NodeEventCall[] = [];

    await handleAcpInvokeCommand(
      buildFrame({
        command: "acp.session.ensure",
        payload: {
          sessionKey: "agent:main:acp:test",
          leaseId: "lease-1",
          leaseEpoch: 1,
          agent: "main",
          mode: "persistent",
        },
      }),
      buildDeps(async (event, payload) => {
        nodeEvents.push({ event, payload });
      }),
    );

    const first = await handleAcpInvokeCommand(
      buildFrame({
        command: "acp.turn.start",
        payload: {
          sessionKey: "agent:main:acp:test",
          runId: "run-fast",
          leaseId: "lease-1",
          leaseEpoch: 1,
          requestId: "req-fast",
          mode: "prompt",
          text: "hi",
        },
      }),
      buildDeps(async (event, payload) => {
        nodeEvents.push({ event, payload });
      }),
    );

    await runtime.waitForTurnStart();
    runtime.releaseTurnToComplete("end_turn");
    await runtime.waitForTurnFinish();

    const second = await handleAcpInvokeCommand(
      buildFrame({
        command: "acp.turn.start",
        payload: {
          sessionKey: "agent:main:acp:test",
          runId: "run-fast",
          leaseId: "lease-1",
          leaseEpoch: 1,
          requestId: "req-fast",
          mode: "prompt",
          text: "hi",
        },
      }),
      buildDeps(async (event, payload) => {
        nodeEvents.push({ event, payload });
      }),
    );
    const firstPayload = (first as Extract<typeof first, { handled: true; ok: true }>).payload as {
      nodeWorkerRunId: string;
    };

    expect(first).toMatchObject({
      handled: true,
      ok: true,
      payload: {
        accepted: true,
        nodeWorkerRunId: expect.any(String),
      },
    });
    expect(second).toMatchObject({
      handled: true,
      ok: true,
      payload: {
        accepted: true,
        nodeWorkerRunId: firstPayload.nodeWorkerRunId,
      },
    });
    expect(runtime.turns).toHaveLength(1);
    expect(nodeEvents).toHaveLength(3);
  });

  it("classifies bare done after cancel intent as cancelled", async () => {
    const runtime = new FakeNodeHostRuntime();
    runtime.rewriteStopReasonOnCancel = false;
    registerAcpRuntimeBackend({
      id: "acpx",
      runtime,
    });
    const nodeEvents: NodeEventCall[] = [];

    await handleAcpInvokeCommand(
      buildFrame({
        command: "acp.session.ensure",
        payload: {
          sessionKey: "agent:main:acp:test",
          leaseId: "lease-1",
          leaseEpoch: 1,
          agent: "main",
          mode: "persistent",
        },
      }),
      buildDeps(async (event, payload) => {
        nodeEvents.push({ event, payload });
      }),
    );

    await handleAcpInvokeCommand(
      buildFrame({
        command: "acp.turn.start",
        payload: {
          sessionKey: "agent:main:acp:test",
          runId: "run-bare-done",
          leaseId: "lease-1",
          leaseEpoch: 1,
          requestId: "req-bare-done",
          mode: "prompt",
          text: "cancel me",
        },
      }),
      buildDeps(async (event, payload) => {
        nodeEvents.push({ event, payload });
      }),
    );

    await runtime.waitForTurnStart();
    runtime.releaseTurnToComplete();

    await expect(
      handleAcpInvokeCommand(
        buildFrame({
          command: "acp.turn.cancel",
          payload: {
            sessionKey: "agent:main:acp:test",
            runId: "run-bare-done",
            leaseId: "lease-1",
            leaseEpoch: 1,
            reason: "manual-cancel",
          },
        }),
        buildDeps(),
      ),
    ).resolves.toMatchObject({
      handled: true,
      ok: true,
    });

    await runtime.waitForTurnFinish();
    await vi.waitFor(() => {
      expect(nodeEvents.at(-1)).toMatchObject({
        event: "acp.worker.terminal",
        payload: {
          runId: "run-bare-done",
          terminal: {
            kind: "cancelled",
            stopReason: "manual-cancel",
          },
        },
      });
    });
  });

  it("propagates runtime status failure instead of synthesizing a healthy status payload", async () => {
    const runtime = new FakeNodeHostRuntime();
    runtime.statusError = new Error("status backend exploded");
    registerAcpRuntimeBackend({
      id: "acpx",
      runtime,
    });

    await handleAcpInvokeCommand(
      buildFrame({
        command: "acp.session.ensure",
        payload: {
          sessionKey: "agent:main:acp:test",
          leaseId: "lease-1",
          leaseEpoch: 1,
          agent: "main",
          mode: "persistent",
        },
      }),
      buildDeps(),
    );

    const status = await handleAcpInvokeCommand(
      buildFrame({
        command: "acp.session.status",
        payload: {
          sessionKey: "agent:main:acp:test",
          leaseId: "lease-1",
          leaseEpoch: 1,
        },
      }),
      buildDeps(),
    );

    expect(status).toMatchObject({
      handled: true,
      ok: false,
      code: "UNAVAILABLE",
      message: expect.stringContaining("status backend exploded"),
    });
  });
});
