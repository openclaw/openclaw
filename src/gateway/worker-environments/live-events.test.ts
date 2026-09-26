import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  WorkerLiveEventErrorDetails as ErrorDetails,
  WorkerLiveEventParams as Params,
} from "../../../packages/gateway-protocol/src/schema.js";
import { drainStoreWriterQueuesForTest } from "../../../test/helpers/promise.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/io.js";
import * as sessions from "../../config/sessions/session-accessor.js";
import {
  emitAgentEvent,
  getAgentEventLifecycleGeneration,
  onAgentRuntimeEvent,
  type AgentEventRuntimePayload as Event,
} from "../../infra/agent-events.js";
import {
  claimAgentRunContext,
  clearAgentRunContext,
  getAgentRunContext,
  getAgentRunContextOwnership,
  resolveProjectedAgentRunProgressState,
  releaseAgentRunContext,
  sweepStaleRunContexts,
} from "../../infra/agent-run-registry.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { SQLITE_SESSION_WRITER_QUEUES } from "../../state/openclaw-agent-write-admission.js";
import { loadSqliteTrajectoryRuntimeEventRowsSync } from "../../trajectory/runtime-store.sqlite.js";
import type { WorkerConnectionIdentity as Identity } from "./connection-identity.js";
import * as liveProjection from "./live-event-projection.js";
import {
  createWorkerLiveEventReceiver,
  type WorkerLiveEventReceiver as Receiver,
} from "./live-events.js";
import {
  SID,
  KEY,
  EPOCH,
  RUN,
  LOCAL,
  ID,
  msg,
  live,
  tool,
  approval,
  lifecycle,
  farmIdentity,
  farmEvent,
  captureWorkerTranscriptSource,
  holdWorkerTranscriptWriter,
  seedWorkerLiveSession,
  type WireEvent,
} from "./live-events.test-support.js";
import type { WorkerTurnTranscriptSource } from "./placement-turn-claim-events.js";
import * as workerRunOwner from "./worker-turn-run-owner.js";

describe("worker live events", () => {
  let root: string;
  let store: string;
  const sources = new Map<string, WorkerTurnTranscriptSource>();
  let rx: Receiver;
  let events: Event[];
  let unsubscribe: (() => void) | undefined;
  let durableAckedSeq = 0;
  const readAckedSeq = () => durableAckedSeq;

  const captureSource = (sessionId = SID, sessionKey = KEY) => {
    const source = captureWorkerTranscriptSource({
      agentId: "main",
      sessionId,
      sessionKey,
      storePath: store,
    });
    if (!source.sessionTarget.expectedLifecycleRevision) {
      throw new Error("expected admitted live-event session");
    }
    sources.set(sessionId, source);
    return source;
  };
  const sourceFor = (identity: Identity = ID) => {
    const source = identity.sessionId && sources.get(identity.sessionId);
    if (!source) {
      throw new Error("expected captured worker source");
    }
    return source;
  };

  const ack = async (request: Params, ackedSeq = request.seq, id = ID) => {
    expect(await rx.apply({ identity: id, request, source: sourceFor(id), readAckedSeq })).toEqual({
      ok: true,
      result: { ackedSeq },
    });
  };
  const fail = async (request: Params, reason: ErrorDetails["reason"], id = ID) => {
    const details: ErrorDetails =
      reason === "resync-required"
        ? { reason, ackedSeq: durableAckedSeq, expectedSeq: durableAckedSeq + 1 }
        : { reason };
    expect(await rx.apply({ identity: id, request, source: sourceFor(id), readAckedSeq })).toEqual({
      ok: false,
      details,
    });
  };
  const start = (overrides: Partial<Parameters<typeof createWorkerLiveEventReceiver>[0]> = {}) => {
    rx?.clear();
    rx = createWorkerLiveEventReceiver(overrides);
  };
  const target = { canonicalKey: KEY, storeKeys: [KEY] };
  const remove = () =>
    sessions.deleteSessionEntryLifecycle({
      agentId: "main",
      archiveTranscript: false,
      expectedSessionId: SID,
      storePath: store,
      target,
    });
  const create = (updatedAt = 20) =>
    sessions.upsertSessionEntryCore(
      { agentId: "main", sessionKey: KEY, storePath: store },
      {
        sessionId: SID,
        updatedAt,
        lifecycleRevision: `live-lifecycle-${updatedAt}`,
        activeWriterRunId: RUN,
      },
    );
  const deltas = () => events.map((event) => event.data.delta);

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "openclaw-worker-live-"));
    store = path.join(root, "agents", "main", "sessions", "sessions.json");
    sources.clear();
    durableAckedSeq = 0;
    await create(10);
    captureSource();
    setRuntimeConfigSnapshot({ session: { store } });
    start();
    events = [];
    unsubscribe = onAgentRuntimeEvent((event) => events.push(event));
  });

  afterEach(async () => {
    unsubscribe?.();
    rx?.clear();
    clearRuntimeConfigSnapshot();
    await drainStoreWriterQueuesForTest(SQLITE_SESSION_WRITER_QUEUES, "live receiver test cleanup");
    closeOpenClawAgentDatabasesForTest();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("persists cloud-worker progress for sessions tail", async () => {
    const credential = ["trajectory", "credential", "secret"].join("-");
    unsubscribe?.();
    unsubscribe = onAgentRuntimeEvent((event) => {
      events.push(event);
      if (event.stream === "tool" && event.data.phase === "result") {
        event.data.result = { status: "live-consumer-mutated" };
      }
    });
    await ack(live(1, lifecycle({ phase: "start", startedAt: 100 })));
    await ack(
      live(
        2,
        tool({
          phase: "start",
          name: "write",
          toolCallId: "call-write",
          args: { path: "proof.txt", credential },
        }),
      ),
    );
    await ack(
      live(
        3,
        tool({
          phase: "result",
          name: "write",
          toolCallId: "call-write",
          isError: false,
          result: { status: "written", credential },
        }),
      ),
    );
    const terminal = live(4, lifecycle({ phase: "end", startedAt: 100, endedAt: 200 }));
    await ack(terminal);
    await ack(terminal);

    const rows = loadSqliteTrajectoryRuntimeEventRowsSync({
      agentId: "main",
      sessionId: SID,
      storePath: store,
    });
    expect(rows.map((row) => row.event.type)).toEqual([
      "session.started",
      "tool.call",
      "tool.result",
      "model.completed",
      "session.ended",
    ]);
    expect(events.find((event) => event.data.phase === "result")?.data.result).toEqual({
      status: "live-consumer-mutated",
    });
    expect(rows[2]?.event.data).toMatchObject({
      name: "write",
      success: true,
      result: { status: "written" },
    });
    expect(rows[4]?.event.data).toMatchObject({ status: "success" });
    expect(JSON.stringify(rows)).not.toContain(credential);
  });

  const lifecycleCredential = ["lifecycle", "credential", "value"].join("-");
  it.each([
    [
      "length completions",
      lifecycle({ phase: "end", startedAt: 100, endedAt: 200, stopReason: "length" }),
      "length",
      "success",
    ],
    [
      "provider errors",
      lifecycle({
        phase: "error",
        startedAt: 100,
        endedAt: 200,
        stopReason: "error",
        error: `provider failed after Bearer ${lifecycleCredential}`,
        fallbackExhaustedFailure: true,
      }),
      "error",
      "error",
    ],
    [
      "aborted completions",
      lifecycle({
        phase: "end",
        startedAt: 100,
        endedAt: 200,
        stopReason: "aborted",
        aborted: true,
      }),
      "aborted",
      "interrupted",
    ],
  ])("persists stop reasons for %s", async (_name, terminal, stopReason, status) => {
    await ack(live(1, lifecycle({ phase: "start", startedAt: 100 })));
    await ack(live(2, terminal));

    const rows = loadSqliteTrajectoryRuntimeEventRowsSync({
      agentId: "main",
      sessionId: SID,
      storePath: store,
    });
    expect(rows.slice(-2).map((row) => row.event)).toMatchObject([
      { type: "model.completed", data: { stopReason } },
      { type: "session.ended", data: { status, stopReason } },
    ]);
    expect(JSON.stringify(rows)).not.toContain(lifecycleCredential);
  });

  it("maps and sanitizes kinds", async () => {
    const credential = ["fixture", "credential", "value"].join("-");
    const output = (char: string, status: string) => ({
      content: [{ type: "image", bytes: 6, omitted: true }],
      details: { credential, status, aggregated: char.repeat(9000) },
    });
    const variants: WireEvent[] = [
      { kind: "assistant", payload: { text: "hello", delta: "hello" } },
      { kind: "thinking", payload: { text: "Inspecting", delta: "ing" } },
      tool({ phase: "start", name: "read", toolCallId: "call", args: { credential } }),
      tool({
        phase: "update",
        name: " BASH ",
        toolCallId: "call",
        partialResult: output("p", "running"),
      }),
      tool({
        phase: "result",
        name: "bash",
        toolCallId: "call",
        isError: false,
        result: output("r", "completed"),
      }),
      approval({ phase: "requested", kind: "exec", status: "pending", title: "Approve" }),
      approval({ phase: "resolved", kind: "exec", status: "approved", title: "Approved" }),
      lifecycle({ phase: "start", startedAt: 100 }),
      lifecycle({
        phase: "fallback_step",
        fallbackStepType: "fallback_step",
        fallbackStepFromModel: "openai/gpt-primary",
        fallbackStepFromFailureReason: "tls_certificate",
        fallbackStepFinalOutcome: "next_fallback",
      }),
    ];

    for (const [index, event] of variants.entries()) {
      await ack(live(index + 1, event, `run-map-${index}`));
    }
    const rawEvents = events.filter((event) => event.stream !== "item");
    expect(rawEvents.map((event) => event.stream)).toEqual(variants.map((event) => event.kind));
    expect(events.filter((event) => event.stream === "item").map((event) => event.data)).toEqual([
      expect.objectContaining({ itemId: "tool:call", phase: "start", status: "running" }),
      expect.objectContaining({ itemId: "tool:call", phase: "update", status: "running" }),
      expect.objectContaining({ itemId: "tool:call", phase: "end", status: "completed" }),
    ]);
    const capped = (char: string) => `${char.repeat(8000)}\n...(live output truncated)...`;
    expect(rawEvents[4]?.data).toMatchObject({
      name: "exec",
      result: { content: [{ bytes: 6, omitted: true }], details: { aggregated: capped("r") } },
    });
    expect(rawEvents[8]?.data).toMatchObject({
      fallbackStepFromFailureReason: "tls_certificate",
    });
    expect(JSON.stringify(events)).not.toContain(credential);
  });

  it("settles accepted writes before returning a synchronous diagnostic failure", async () => {
    const failure = new Error("synthetic diagnostic failure");
    const diagnostic = vi.spyOn(workerRunOwner, "captureWorkerTurnLiveEventOwner").mockReturnValue({
      record: () => {
        throw failure;
      },
      isCancelled: () => false,
    });
    const writer = holdWorkerTranscriptWriter(store);
    await writer.entered;
    let settled = false;
    const result = rx
      .apply({
        readAckedSeq,
        identity: ID,
        source: sourceFor(),
        request: live(1, lifecycle({ phase: "start", startedAt: 100 })),
      })
      .then(
        (value) => {
          settled = true;
          return value;
        },
        (error: unknown) => {
          settled = true;
          return error;
        },
      );
    try {
      await setImmediate();
      expect(events.map((event) => event.data.phase)).toEqual(["start"]);
      expect(settled).toBe(false);
      writer.release();
      await writer.done;
      expect(await result).toBe(failure);
      expect(
        loadSqliteTrajectoryRuntimeEventRowsSync({
          agentId: "main",
          sessionId: SID,
          storePath: store,
        }).map((row) => row.event.type),
      ).toEqual(["session.started"]);
    } finally {
      writer.release();
      await writer.done;
      await result;
      diagnostic.mockRestore();
    }
  });

  it("replays an unacked tail once", async () => {
    await ack(msg(2, " world"), 0);
    await ack(msg(1), 2, { ...ID });
    await ack(msg(1), 2);
    await ack(msg(2, " world"), 2);
    expect(deltas()).toEqual(["hello", " world"]);
  });

  it("resyncs a gap that exceeds the pending byte budget", async () => {
    start({ maxPendingBytes: 1 });
    await fail(msg(2, "buffered"), "resync-required");
  });

  it("restores the durable ACK when recreating a window", async () => {
    durableAckedSeq = 5;
    await ack(msg(6, "before", 5));
    rx.clear();
    await fail(msg(8, "stale", 7), "resync-required");
    await ack(msg(6, "fresh", 5));
  });

  it("does not revive a missing startup source from a replacement row", async () => {
    await remove();
    start();
    await fail(msg(1), "invalid-event");
    await create();
    await fail(msg(1), "invalid-event");
    expect(events).toEqual([]);
    captureSource();
    start();
    await fail(msg(6, "stale", 5), "resync-required");
    await ack(msg(1));
  });

  it("rotates owners", async () => {
    await ack(msg(1, "first"));
    const credentialHash = ["rotated", "credential", "hash"].join("-");
    rx.rotateCredential({
      credentialHash,
      environmentId: ID.environmentId,
      previousCredentialHash: ID.credentialHash,
      runEpoch: EPOCH,
      sessionId: SID,
    });
    const rotated = { ...ID, credentialHash };
    await ack(msg(2, "second", 1), 2, rotated);
    await fail(msg(3, "late", 2), "epoch-mismatch");
    const next = { ...rotated, ownerEpoch: EPOCH + 1 };
    await fail(msg(2, "skip", 1, RUN, next.ownerEpoch), "resync-required", next);
    await ack(msg(1, "new", 0, RUN, next.ownerEpoch), 1, next);
    await fail(msg(2, "late", 1), "epoch-mismatch", rotated);
    await ack(msg(2, "current", 1, RUN, next.ownerEpoch), 2, next);
    expect(deltas()).toEqual(["first", "second", "new", "current"]);
  });

  it("retires completed process fences when a new turn reuses its durable run id", async () => {
    await ack(live(1, lifecycle({ phase: "start", startedAt: 100 })));
    await ack(live(2, lifecycle({ phase: "end", startedAt: 100, endedAt: 200 })));
    const credentialHash = ["next", "process", "credential"].join("-");

    expect(
      rx.rotateCredential({
        ackedSeq: 2,
        credentialHash,
        environmentId: ID.environmentId,
        newProcessTurn: true,
        previousCredentialHash: ID.credentialHash,
        runEpoch: EPOCH,
        sessionId: SID,
      }),
    ).toBe(true);

    const nextProcess = { ...ID, credentialHash };
    await ack(live(3, lifecycle({ phase: "start", startedAt: 300 })), 3, nextProcess);
    expect(events.map((event) => event.data.phase)).toEqual(["start", "end", "start"]);
  });

  it("ACKs an exact cancelled finishing event without consulting the retired source", async () => {
    await remove();
    const source = sourceFor();
    const receipt = vi.spyOn(source, "receiptAuthority");
    const record = vi.fn();
    const owner = vi.spyOn(workerRunOwner, "captureWorkerTurnLiveEventOwner").mockReturnValue({
      isCancelled: () => true,
      record,
    });
    try {
      await fail(msg(1, "late"), "invalid-event");
      await ack(live(1, lifecycle({ phase: "finishing", aborted: true, endedAt: 200 })));
      expect(receipt).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
      expect(events).toEqual([]);
      expect(getAgentRunContext(RUN)).toBeUndefined();
      expect(
        loadSqliteTrajectoryRuntimeEventRowsSync({
          agentId: "main",
          sessionId: SID,
          storePath: store,
        }),
      ).toEqual([]);
    } finally {
      receipt.mockRestore();
      owner.mockRestore();
    }
  });

  it("rewinds cancelled preview ACKs before delivering the replacement turn terminal", async () => {
    await ack(msg(1, "cancelled preview"));
    await ack(msg(2, "another cancelled preview", 1));
    const credentialHash = "replacement-process-credential";
    const runId = "replacement-worker-run";

    expect(
      rx.rotateCredential({
        ackedSeq: 0,
        credentialHash,
        environmentId: ID.environmentId,
        newProcessTurn: true,
        previousCredentialHash: ID.credentialHash,
        runEpoch: EPOCH,
        sessionId: SID,
      }),
    ).toBe(true);

    const replacement = { ...ID, credentialHash, runId };
    await ack(live(1, lifecycle({ phase: "start", startedAt: 300 }), runId), 1, replacement);
    await ack(
      live(2, lifecycle({ phase: "finishing", startedAt: 300, endedAt: 400 }), runId),
      2,
      replacement,
    );
    expect(events.slice(-2).map((event) => event.data.phase)).toEqual(["start", "finishing"]);
  });

  it("ACKs before buffered failure", async () => {
    const first = msg(1, "first", 0, "run-prefix");
    const second = msg(2, "second", 0, "run-buffered");
    claimAgentRunContext(second.runId, { sessionKey: KEY });
    await ack(second, 0);
    await ack(first);
    await fail(second, "invalid-event");
    clearAgentRunContext(second.runId);
    await ack(second);
    expect(deltas()).toEqual(["first", "second"]);
  });

  it("retains a buffered capacity tail until the active run releases", async () => {
    start({ maxActiveRuns: 1 });
    const first = msg(1, "first", 0, "run-prefix");
    const second = msg(2, "second", 0, "run-buffered");
    const retry = msg(2, "replacement", 1, second.runId);
    const terminal = {
      ...live(3, lifecycle({ phase: "end", endedAt: 200 }), first.runId),
      lastAckedSeq: 1,
    };

    await ack(second, 0);
    await ack(first);
    expect(getAgentRunContext(first.runId)).toBeDefined();
    expect(getAgentRunContext(second.runId)).toBeUndefined();
    expect(events.map((event) => event.runId)).toEqual([first.runId]);

    await ack(retry, 1);
    expect(getAgentRunContext(first.runId)).toBeDefined();
    expect(events.map((event) => event.runId)).toEqual([first.runId]);

    await ack(terminal, 1);
    expect(getAgentRunContext(first.runId)).toBeDefined();
    expect(getAgentRunContext(second.runId)).toBeUndefined();
    expect(events.map((event) => event.runId)).toEqual([first.runId]);

    await ack(retry, 3);
    await ack(terminal, 3);
    expect(events.map((event) => [event.runId, event.stream])).toEqual([
      [first.runId, "assistant"],
      [second.runId, "assistant"],
      [first.runId, "lifecycle"],
    ]);
    expect(deltas()).toEqual(["first", "second", undefined]);
  });

  it("does not borrow capacity past another new run", async () => {
    start({ maxActiveRuns: 1 });
    const first = msg(1, "first", 0, "run-prefix");
    const second = msg(2, "second", 0, "run-buffered");
    const third = msg(3, "third", 0, "run-intervening");
    const terminal = {
      ...live(4, lifecycle({ phase: "end", endedAt: 200 }), first.runId),
      lastAckedSeq: 0,
    };

    await ack(second, 0);
    await ack(third, 0);
    await ack(terminal, 0);
    await ack(first);
    await ack(msg(2, "replacement", 1, second.runId), 1);

    expect(events.map((event) => event.runId)).toEqual([first.runId]);
    expect(getAgentRunContext(second.runId)).toBeUndefined();
    expect(getAgentRunContext(third.runId)).toBeUndefined();
  });

  it("bounds a retained capacity tail with normal resync", async () => {
    const first = msg(1, "first", 0, "run-prefix");
    const second = msg(2, "second", 0, "run-buffered");
    start({
      maxActiveRuns: 1,
      maxPendingBytes: Buffer.byteLength(JSON.stringify(second.event), "utf8"),
    });

    await ack(second, 0);
    await ack(first);
    expect(
      await rx.apply({
        readAckedSeq,
        identity: ID,
        source: sourceFor(),
        request: msg(3, "overflow", 1, "run-overflow"),
      }),
    ).toEqual({
      ok: false,
      details: { reason: "resync-required", ackedSeq: 1, expectedSeq: 2 },
    });

    await fail(msg(2, "blocked", 1, second.runId), "capacity-exceeded");
    await fail(msg(2, "stale", 1, second.runId), "resync-required");
    await ack(msg(1, "fresh", 0, second.runId));
    expect(deltas()).toEqual(["first", "fresh"]);
  });

  it("clears speculative pending events on in-window resync", async () => {
    start({ windowSize: 2 });
    await ack(msg(2, "stale"), 0);
    await fail(msg(3, "gap"), "resync-required");

    await ack(msg(1, "first"));
    await ack(msg(2, "fresh", 1));

    expect(deltas()).toEqual(["first", "fresh"]);
  });

  it("does not reserve a pending terminal for an unbuffered head", async () => {
    start({ maxActiveRuns: 1 });
    const activeRunId = "run-active";
    await ack(msg(1, "active", 0, activeRunId));
    await ack(
      {
        ...live(3, lifecycle({ phase: "end", endedAt: 200 }), activeRunId),
        lastAckedSeq: 1,
      },
      1,
    );
    await fail(msg(2, "overlap", 1, "run-overlap"), "capacity-exceeded");
    await fail(msg(2, "stale", 1, "run-overlap"), "resync-required");
    await ack(msg(1, "fresh", 0, "run-overlap"));
  });

  it.each([RUN, "run-sibling"])("resyncs after a swept context before %s", async (runId) => {
    await ack(msg(1, "before"));
    expect(getAgentRunContext(RUN)).toBeDefined();
    sweepStaleRunContexts(-1);
    expect(getAgentRunContext(RUN)).toBeUndefined();
    await fail(msg(2, "stale", 1, runId), "resync-required");
    await ack(msg(1, "fresh", 0, runId));
    expect(deltas()).toEqual(["before", "fresh"]);
  });

  it("keeps buffered and new trajectory writes on the admitted store after config changes", async () => {
    await ack(live(1, lifecycle({ phase: "start", startedAt: 100 })));
    await ack({ ...live(3, lifecycle({ phase: "end", endedAt: 200 })), lastAckedSeq: 1 }, 1);
    const replacementStore = path.join(root, "replacement.sqlite");
    await sessions.upsertSessionEntryCore(
      { agentId: "main", sessionKey: KEY, storePath: replacementStore },
      { sessionId: SID, updatedAt: 20 },
    );
    setRuntimeConfigSnapshot({ session: { store: replacementStore } });
    await ack(live(2, tool({ phase: "start", name: "read", toolCallId: "read-a", args: {} })), 3);

    expect(
      events.filter((event) => event.stream !== "item").map((event) => event.data.phase),
    ).toEqual(["start", "start", "end"]);
    expect(
      loadSqliteTrajectoryRuntimeEventRowsSync({
        agentId: "main",
        sessionId: SID,
        storePath: store,
      }).map((row) => row.event.type),
    ).toEqual(["session.started", "tool.call", "model.completed", "session.ended"]);
    expect(
      loadSqliteTrajectoryRuntimeEventRowsSync({
        agentId: "main",
        sessionId: SID,
        storePath: replacementStore,
      }),
    ).toEqual([]);
  });

  it("fences a committed reset", async () => {
    await ack(msg(1, "before"));
    await sessions.resetSessionEntryLifecycle({
      agentId: "main",
      buildNextEntry: () => ({ sessionId: `${SID}-replacement`, updatedAt: 20 }),
      storePath: store,
      target,
    });
    await fail(msg(2, "after", 1), "invalid-event");
  });

  it("restarts after deletion", async () => {
    await ack(msg(1, "before"));
    await ack(msg(3, "buffered", 1), 1);
    await remove();
    await fail(msg(2, "after", 1), "invalid-event");
    await create(30);
    await fail(msg(2, "replacement", 1), "invalid-event");
    captureSource();
    start();
    await ack(msg(1, "fresh"));
    expect(deltas()).toEqual(["before", "fresh"]);
  });

  it("fences terminal runs", async () => {
    await ack(
      live(1, { kind: "lifecycle", payload: { phase: "error", endedAt: 100, error: "retryable" } }),
    );
    await ack(msg(2, "recovered", 1));
    const end = events[0];
    clearAgentRunContext(RUN, end?.lifecycleGeneration, end?.contextClaimId);
    await fail(msg(3, "released", 2), "invalid-event");

    start({ windowSize: 2 });
    await ack(live(1, { kind: "lifecycle", payload: { phase: "end", endedAt: 200 } }));
    await ack(msg(2, "other", 1, "run-other"));
    await fail(msg(3, "late", 2), "invalid-event");
  });

  it("retains a terminal fence while its run remains claimed", async () => {
    start({ windowSize: 2 });
    await ack(live(1, { kind: "lifecycle", payload: { phase: "end", endedAt: 200 } }));
    await ack(msg(2, "other-first", 1, "run-other"));
    await ack(msg(3, "other-second", 2, "run-other"));

    await fail(msg(4, "late", 3), "invalid-event");
    expect(events.filter((event) => event.runId === RUN)).toHaveLength(1);
  });

  it.each([
    ["item", false],
    ["item", true],
    ["tool", false],
    ["tool", true],
  ] as const)(
    "stops publication after %s detaches the worker (shared: %s)",
    async (stream, shared) => {
      if (shared) {
        claimAgentRunContext(RUN, {
          ...LOCAL,
          isControlUiVisible: true,
          lifecycleGeneration: getAgentEventLifecycleGeneration(),
        });
      }
      const diagnostic = vi.fn();
      const recorder = vi
        .spyOn(workerRunOwner, "captureWorkerTurnLiveEventOwner")
        .mockReturnValue({ record: diagnostic, isCancelled: () => false });
      const stop = onAgentRuntimeEvent((event) => {
        if (event.runId === RUN && event.stream === stream) {
          rx.clearEnvironment(ID.environmentId, EPOCH);
        }
      });
      try {
        await fail(
          live(
            1,
            tool({ phase: "start", name: "read", toolCallId: "revoked", args: { path: "file" } }),
          ),
          "invalid-event",
        );
        expect(events.map((event) => event.stream)).toEqual(
          stream === "item" ? ["item"] : ["item", "tool"],
        );
        expect(diagnostic).not.toHaveBeenCalled();
        expect(
          loadSqliteTrajectoryRuntimeEventRowsSync({
            agentId: "main",
            sessionId: SID,
            storePath: store,
          }),
        ).toEqual([]);
      } finally {
        stop();
        recorder.mockRestore();
      }
    },
  );

  it("fences an environment detached before its first live event", async () => {
    rx.clearEnvironment(ID.environmentId, EPOCH);
    await fail(msg(1), "invalid-event");
    expect(events).toEqual([]);
  });

  it("clears on detach", async () => {
    await ack(msg(1, "delivered"));
    await ack(msg(3, "buffered", 1), 1);
    rx.clearEnvironment(ID.environmentId, EPOCH);
    expect(getAgentRunContext(RUN)).toBeUndefined();
    await fail(msg(1, "pending", 0, "run-pending"), "invalid-event");
  });

  it("adopts a compatible pre-registered gateway run context", async () => {
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    claimAgentRunContext(RUN, {
      ...LOCAL,
      isControlUiVisible: false,
      lifecycleGeneration,
    });

    await ack(msg(1, "worker"));

    expect(getAgentRunContext(RUN)).toMatchObject({
      ...LOCAL,
      isControlUiVisible: false,
      lifecycleGeneration,
      projectSessionActive: true,
    });
    expect(deltas()).toEqual(["worker"]);
  });

  it.each(["terminal process turnover", "detach"])(
    "clears an ownerless Gateway run context on %s",
    async (settledBy) => {
      claimAgentRunContext(RUN, {
        ...LOCAL,
        lifecycleGeneration: getAgentEventLifecycleGeneration(),
      });

      await ack(msg(1, "worker"));
      if (settledBy === "terminal process turnover") {
        await ack(live(2, lifecycle({ phase: "end", startedAt: 100, endedAt: 200 })));
        expect(
          rx.rotateCredential({
            ackedSeq: 2,
            credentialHash: "next-process-credential-hash",
            environmentId: ID.environmentId,
            newProcessTurn: true,
            previousCredentialHash: ID.credentialHash,
            runEpoch: EPOCH,
            sessionId: SID,
          }),
        ).toBe(true);
      } else {
        rx.clearEnvironment(ID.environmentId, EPOCH);
      }

      expect(getAgentRunContext(RUN)).toBeUndefined();
      expect(
        resolveProjectedAgentRunProgressState({ sessionKeys: [KEY], sessionId: SID }),
      ).toBeUndefined();
    },
  );

  it("joins a visible dispatch-owned run context without blocking its terminal", async () => {
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    // A worker-routed turn keeps its dispatch-owned Control UI visibility. The
    // gateway claims the run context (isControlUiVisible: true for a visible
    // turn) before handing the turn to the remote worker; joining live events
    // must inherit that visibility without excluding the outer terminal.
    claimAgentRunContext(RUN, {
      ...LOCAL,
      isControlUiVisible: true,
      lifecycleGeneration,
    });

    await ack(live(1, lifecycle({ phase: "start", startedAt: 100 })));
    await ack(msg(2, "worker", 1));
    await ack(live(3, lifecycle({ phase: "finishing", startedAt: 100, endedAt: 200 })));

    expect(getAgentRunContext(RUN)).toMatchObject({
      ...LOCAL,
      isControlUiVisible: true,
      lifecycleGeneration,
      projectSessionActive: true,
    });
    expect(resolveProjectedAgentRunProgressState({ sessionKeys: [KEY], sessionId: SID })).toBe(
      "running",
    );
    expect(events.map((event) => [event.stream, event.data.phase ?? event.data.delta])).toEqual([
      ["lifecycle", "start"],
      ["assistant", "worker"],
      ["lifecycle", "finishing"],
    ]);
    expect(events.map((event) => event.controlUiVisible)).toEqual([true, true, true]);

    emitAgentEvent({
      runId: RUN,
      stream: "lifecycle",
      data: { phase: "end", startedAt: 100, endedAt: 200 },
    });

    const end = events.at(-1);
    expect(end?.data.phase).toBe("end");
    clearAgentRunContext(RUN, end?.lifecycleGeneration, end?.contextClaimId);
    expect(getAgentRunContext(RUN)).toBeUndefined();
    expect(
      resolveProjectedAgentRunProgressState({ sessionKeys: [KEY], sessionId: SID }),
    ).toBeUndefined();
  });

  it("shares a compatible non-exclusive Gateway run owner", async () => {
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    const gatewayClaim = claimAgentRunContext(
      RUN,
      {
        sessionId: LOCAL.sessionId,
        sessionKey: LOCAL.sessionKey,
        isControlUiVisible: false,
        lifecycleGeneration,
      },
      { ownsContext: true, trackOwner: true },
    );
    expect(gatewayClaim).toBeDefined();

    await ack(live(1, lifecycle({ phase: "start", startedAt: 100 })));

    expect(getAgentRunContext(RUN)).toMatchObject({
      ...LOCAL,
      isControlUiVisible: false,
      lifecycleGeneration,
      projectSessionActive: true,
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.controlUiVisible).toBe(false);

    rx.clear();
    expect(getAgentRunContext(RUN)).toBeDefined();
    releaseAgentRunContext(RUN, gatewayClaim);
  });

  const farmSession = async (n: number, updatedAt = 20) => {
    const source = await seedWorkerLiveSession(store, n, updatedAt);
    sources.set(source.sessionTarget.sessionId, source);
  };
  it("evicts the oldest quiescent window instead of rejecting new sessions at the cap", async () => {
    await Promise.all([farmSession(1), farmSession(2), farmSession(3)]);
    start({ maxSessions: 2 });
    for (const n of [1, 2]) {
      await ack(
        farmEvent(n, 1, { kind: "assistant", payload: { text: "hi", delta: "hi" } }),
        1,
        farmIdentity(n),
      );
      // Turn completion releases the run context gateway-side; the window's
      // stale activeRuns entry lingers until the next event revalidates it.
      for (const claimId of getAgentRunContextOwnership(`run-farm-${n}`)?.claimIds ?? []) {
        releaseAgentRunContext(`run-farm-${n}`, claimId);
      }
    }
    // Both existing windows are quiescent per the run-context registry; the
    // third session evicts the oldest instead of failing with capacity-exceeded.
    await ack(
      farmEvent(3, 1, { kind: "assistant", payload: { text: "new", delta: "new" } }),
      1,
      farmIdentity(3),
    );
    durableAckedSeq = 1;
    await ack(
      farmEvent(1, 2, { kind: "assistant", payload: { text: "resumed", delta: "resumed" } }),
      2,
      farmIdentity(1),
    );
  });

  it("retains a quiescent window through acknowledgment validation", async () => {
    await Promise.all([farmSession(1), farmSession(2)]);
    start({ maxSessions: 1 });
    const writes: Promise<void>[] = [];
    const record = liveProjection.recordWorkerLiveTrajectoryEvent;
    const projection = vi
      .spyOn(liveProjection, "recordWorkerLiveTrajectoryEvent")
      .mockImplementation((...params) => {
        const write = record(...params);
        if (write) {
          writes.push(write);
        }
        return write;
      });
    const writer = holdWorkerTranscriptWriter(store);
    await writer.entered;
    const terminal = rx.apply({
      readAckedSeq,
      identity: farmIdentity(1),
      source: sourceFor(farmIdentity(1)),
      request: farmEvent(1, 1, lifecycle({ phase: "end", endedAt: 200 })),
    });
    let competing: ReturnType<typeof rx.apply> | undefined;
    try {
      for (const claimId of getAgentRunContextOwnership("run-farm-1")?.claimIds ?? []) {
        releaseAgentRunContext("run-farm-1", claimId);
      }
      expect(getAgentRunContext("run-farm-1")).toBeUndefined();
      const next = farmEvent(2, 1, { kind: "assistant", payload: { text: "next", delta: "next" } });
      await fail(next, "capacity-exceeded", farmIdentity(2));
      expect(events.map((event) => event.runId)).toEqual(["run-farm-1"]);

      const write = writes.at(-1);
      if (!write) {
        throw new Error("expected an accepted terminal trajectory write");
      }
      // Registered after apply's Promise.all reaction, this runs after the
      // write settles but before apply resumes ACK validation.
      competing = write.then(() =>
        rx.apply({
          identity: farmIdentity(2),
          request: next,
          source: sourceFor(farmIdentity(2)),
          readAckedSeq,
        }),
      );

      writer.release();
      await writer.done;
      const [terminalResult, competingResult] = await Promise.all([terminal, competing]);
      expect.soft(competingResult).toEqual({ ok: false, details: { reason: "capacity-exceeded" } });
      expect(terminalResult).toEqual({ ok: true, result: { ackedSeq: 1 } });
      await ack(next, 1, farmIdentity(2));
      expect(events.map((event) => event.runId)).toEqual(["run-farm-1", "run-farm-2"]);
    } finally {
      writer.release();
      await writer.done;
      await terminal;
      await competing;
      projection.mockRestore();
    }
  });

  it("rejects a new session only when every window has an active run", async () => {
    await Promise.all([farmSession(1), farmSession(2), farmSession(3)]);
    start({ maxSessions: 2 });
    for (const n of [1, 2]) {
      await ack(
        farmEvent(n, 1, { kind: "assistant", payload: { text: "hi", delta: "hi" } }),
        1,
        farmIdentity(n),
      );
    }
    await fail(
      farmEvent(3, 1, { kind: "assistant", payload: { text: "new", delta: "new" } }),
      "capacity-exceeded",
      farmIdentity(3),
    );
  });

  it("rejects a compatible context held by an exclusive Gateway owner", async () => {
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    const gatewayClaim = claimAgentRunContext(
      RUN,
      { ...LOCAL, lifecycleGeneration },
      { exclusive: true, ownsContext: true, trackOwner: true },
    );
    expect(gatewayClaim).toBeDefined();

    await fail(msg(1, "blocked"), "invalid-event");
    expect(events).toEqual([]);

    releaseAgentRunContext(RUN, gatewayClaim);
  });

  it("rejects pre-registered gateway run contexts with mismatched identity", async () => {
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    const mismatches: Array<{
      context: Parameters<typeof claimAgentRunContext>[1];
      name: string;
    }> = [
      { name: "session-id", context: { ...LOCAL, sessionId: `${SID}-other` } },
      { name: "session-key", context: { ...LOCAL, sessionKey: `${KEY}-other` } },
      { name: "agent-id", context: { ...LOCAL, agentId: "other" } },
      { name: "lifecycle", context: { ...LOCAL, lifecycleGeneration: "other-lifecycle" } },
    ];

    for (const mismatch of mismatches) {
      const runId = `run-mismatch-${mismatch.name}`;
      claimAgentRunContext(runId, {
        isControlUiVisible: false,
        lifecycleGeneration,
        ...mismatch.context,
      });
      await fail(msg(1, "blocked", 0, runId), "invalid-event");
      clearAgentRunContext(runId);
    }
    expect(events).toEqual([]);
  });

  it("keeps a claimed run id exclusive against a later untracked local claim", async () => {
    const worker = "run-worker-first";
    await ack(msg(1, "worker", 0, worker));
    // A same-identity untracked claim cannot hijack a run live events already own.
    claimAgentRunContext(worker, LOCAL);
    clearAgentRunContext(worker);
    emitAgentEvent({
      runId: worker,
      stream: "assistant",
      data: { text: "local", delta: "local" },
    });
    await ack(msg(2, "again", 1, worker));
    expect(deltas()).toEqual(["worker", "again"]);
  });
});
