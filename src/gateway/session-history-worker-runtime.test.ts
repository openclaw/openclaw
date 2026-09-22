import { performance } from "node:perf_hooks";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type {
  SessionHistoryWorkerRequest,
  SessionHistoryWorkerResult,
  SessionHistoryDelta,
} from "../config/sessions/session-history-types.js";
import {
  SessionHistoryDeltaPreparationError,
  sessionHistoryCleanupError,
} from "../config/sessions/session-history-worker-errors.js";
import { readSessionHistoryPageInWorker } from "../config/sessions/session-history-worker-runtime.js";
import type { SessionTranscriptHistoryWorkerInput } from "../config/sessions/session-transcript-worker.types.js";
import { DEFAULT_WORKER_PENDING_TASKS } from "../infra/worker-task-capacity.js";
import * as stateContext from "../state/openclaw-state-worker-context.js";

const runWorker = vi.hoisted(() => vi.fn());
vi.mock("../config/sessions/session-transcript-worker-runtime.js", () => ({
  withSessionHistoryWorkerDatabase: (
    _options: unknown,
    operation: (owner: {
      generation: number;
      run: typeof runWorker;
      assertCurrent: () => void;
    }) => unknown,
  ) => operation({ generation: 1, run: runWorker, assertCurrent: () => {} }),
}));
vi.mock("../config/sessions/session-cold-storage-read.js", () => ({
  readRestoredSessionTranscript: async (_scope: unknown, read: () => unknown) => read(),
}));

type RpcRequest = Extract<SessionHistoryWorkerRequest, { kind: "rpc" }>;
const queued: Array<{
  prepare: () => SessionTranscriptHistoryWorkerInput;
  result: ReturnType<typeof createDeferred<SessionHistoryWorkerResult>>;
}> = [];

beforeEach(() => {
  queued.length = 0;
  runWorker.mockReset().mockImplementation((prepare: () => SessionTranscriptHistoryWorkerInput) => {
    const result = createDeferred<SessionHistoryWorkerResult>();
    queued.push({ prepare, result });
    return result.promise;
  });
});

function request(overrides: Partial<RpcRequest["params"]> = {}): RpcRequest {
  return {
    kind: "rpc",
    params: {
      sessionAgentId: "main",
      canonicalKey: "agent:main:history-worker",
      sessionId: "history-worker",
      storePath: "/tmp/history-worker-fixture/sessions.json",
      entry: { sessionId: "history-worker", updatedAt: 1, sessionStartedAt: 1 },
      provider: undefined,
      max: 20,
      maxHistoryBytes: 100_000,
      effectiveMaxChars: 8000,
      offset: undefined,
      messageId: undefined,
      ...overrides,
    },
  };
}

function page(text: string): SessionHistoryWorkerResult {
  return {
    kind: "rpc",
    page: { messages: [{ role: "assistant", content: [{ type: "text", text }] }] },
  };
}

it.each([false, true])(
  "keeps delta followers and their captured authority separate (deferred error: %s)",
  async (failed) => {
    const capture = stateContext.captureOpenClawStateWorkerContext;
    const assertions: Array<ReturnType<typeof vi.fn>> = [];
    const context = vi
      .spyOn(stateContext, "captureOpenClawStateWorkerContext")
      .mockImplementation((...args) => {
        const bound = capture(...args);
        const assertCurrent = vi.fn(bound.admission.assertCurrent);
        assertions.push(assertCurrent);
        return { ...bound, admission: { ...bound.admission, assertCurrent } };
      });
    try {
      const rpc = request().params;
      const deltaRequest: Extract<SessionHistoryWorkerRequest, { kind: "delta" }> = {
        kind: "delta",
        params: {
          target: {
            agentId: rpc.sessionAgentId,
            sessionId: rpc.sessionId,
            sessionKey: rpc.canonicalKey,
            sessionEntry: rpc.entry,
            storePath: rpc.storePath,
          },
          limits: { maxEvents: 200, maxBytes: 1_000_000 },
        },
      };
      const first = readSessionHistoryPageInWorker(deltaRequest);
      const second = readSessionHistoryPageInWorker(deltaRequest);
      expect(queued).toHaveLength(1);
      const partial: SessionHistoryDelta = {
        delta: { kind: "missing" },
        subagentCoordination: { sessions: [["source", false]], runMessages: [] },
      };
      queued[0]!.prepare();
      if (failed) {
        queued[0]!.result.reject(new SessionHistoryDeltaPreparationError(partial));
      } else {
        queued[0]!.result.resolve({ kind: "delta", ...partial });
      }
      const [a, b] = await Promise.all([first, second]);
      a.subagentCoordination.sessions[0]![1] = true;
      expect(b.subagentCoordination.sessions[0]![1]).toBe(false);
      assertions[0]!.mockImplementation(() => {
        throw new Error("original source revoked");
      });
      expect(a.assertCurrent).toThrow("original source revoked");
      expect(b.assertCurrent).not.toThrow();
    } finally {
      context.mockRestore();
    }
  },
);

it("does not recover partial delta facts when worker retirement fails", async () => {
  const rpc = request().params;
  const pending = readSessionHistoryPageInWorker({
    kind: "delta",
    params: {
      target: {
        agentId: rpc.sessionAgentId,
        sessionId: rpc.sessionId,
        sessionKey: rpc.canonicalKey,
        storePath: rpc.storePath,
        sessionEntry: rpc.entry,
      },
      limits: {},
    },
  });
  const failure = sessionHistoryCleanupError(
    new SessionHistoryDeltaPreparationError({
      delta: { kind: "missing" },
      subagentCoordination: { sessions: [], runMessages: [] },
    }),
    new Error("retirement failed"),
    "worker retirement",
  );
  const rejected = expect(pending).rejects.toBe(failure);
  queued[0]!.prepare();
  queued[0]!.result.reject(failure);
  await rejected;
});

it("shares queued equivalent pages but starts a fresh read after dispatch", async () => {
  const first = readSessionHistoryPageInWorker(request());
  const second = readSessionHistoryPageInWorker(request());
  expect(queued).toHaveLength(1);

  queued[0]!.prepare();
  const afterAppend = readSessionHistoryPageInWorker(request());
  expect(queued).toHaveLength(2);
  queued[0]!.result.resolve(page("before append"));
  const [a, b] = await Promise.all([first, second]);
  const sameSuccessor = readSessionHistoryPageInWorker(request());
  expect(queued).toHaveLength(2);
  queued[1]!.prepare();
  queued[1]!.result.resolve(page("after append"));

  const [latest, successor] = await Promise.all([afterAppend, sameSuccessor]);
  expect(a.messages).toEqual([
    { role: "assistant", content: [{ type: "text", text: "before append" }] },
  ]);
  expect(b).toEqual(a);
  expect(latest.messages).toEqual([
    { role: "assistant", content: [{ type: "text", text: "after append" }] },
  ]);
  expect(successor).toEqual(latest);
  expect(a.messages[0]).not.toBe(b.messages[0]);
  const message = asOptionalRecord(a.messages[0]);
  expect(message).toBeDefined();
  expect(message?.content).not.toBe(asOptionalRecord(b.messages[0])?.content);
  message!.content = ["changed by another caller"];
  expect(b.messages).toEqual([
    { role: "assistant", content: [{ type: "text", text: "before append" }] },
  ]);
});

it.each([
  { max: 2 },
  { provider: "other" },
  { ignoreCliSessionImports: true },
  { canonicalKey: "agent:main:other" },
  { maxHistoryBytes: 512 },
  { effectiveMaxChars: 20 },
  { offset: 2 },
  { messageId: "anchor" },
  { storePath: "/tmp/another-history-worker-fixture/sessions.json" },
  { sessionId: "replacement" },
  { entry: { sessionId: "history-worker", updatedAt: 1, sessionStartedAt: 2 } },
])("keeps distinct history selectors separate: %j", async (difference) => {
  const first = readSessionHistoryPageInWorker(request());
  const second = readSessionHistoryPageInWorker(request(difference));
  expect(queued).toHaveLength(2);
  for (const job of queued) {
    job.prepare();
    job.result.resolve(page("selected page"));
  }
  await Promise.all([first, second]);
});

it("discards a rejected queued read so a later request can succeed", async () => {
  const first = readSessionHistoryPageInWorker(request());
  const second = readSessionHistoryPageInWorker(request());
  const failed = Promise.allSettled([first, second]);
  queued[0]!.result.reject(new Error("worker unavailable"));
  expect(await failed).toEqual([
    { status: "rejected", reason: new Error("worker unavailable") },
    { status: "rejected", reason: new Error("worker unavailable") },
  ]);
  const fresh = readSessionHistoryPageInWorker(request());
  expect(queued).toHaveLength(2);
  queued[1]!.prepare();
  queued[1]!.result.resolve(page("recovered"));
  expect(await fresh).toEqual({
    messages: [{ role: "assistant", content: [{ type: "text", text: "recovered" }] }],
  });
});

it.each([0, DEFAULT_WORKER_PENDING_TASKS - 1])(
  "bounds coalesced waiters when reader %i cancels",
  async (cancelledIndex) => {
    const controller = new AbortController();
    const readers = Array.from({ length: DEFAULT_WORKER_PENDING_TASKS }, (_, index) =>
      readSessionHistoryPageInWorker(
        request(),
        index === cancelledIndex ? controller.signal : undefined,
      ),
    );
    const settled = Promise.allSettled(readers);
    expect(queued).toHaveLength(1);
    await expect(readSessionHistoryPageInWorker(request())).rejects.toMatchObject({
      code: "overloaded",
    });
    const cancelled = new Error("caller closed");
    controller.abort(cancelled);
    // The cancelled callback remains retained by the shared promise until its job settles.
    await expect(readSessionHistoryPageInWorker(request())).rejects.toMatchObject({
      code: "overloaded",
    });
    expect(queued).toHaveLength(1);

    const clone = vi.spyOn(globalThis, "structuredClone");
    try {
      queued[0]!.prepare();
      queued[0]!.result.resolve(page("shared result"));
      const results = await settled;
      expect(results[cancelledIndex]).toEqual({ status: "rejected", reason: cancelled });
      expect(
        results
          .filter((_, index) => index !== cancelledIndex)
          .every((result) => result.status === "fulfilled"),
      ).toBe(true);
      expect(clone).toHaveBeenCalledTimes(
        DEFAULT_WORKER_PENDING_TASKS - (cancelledIndex === 0 ? 2 : 1),
      );
    } finally {
      clone.mockRestore();
    }

    const fresh = Promise.all(
      Array.from({ length: DEFAULT_WORKER_PENDING_TASKS }, () =>
        readSessionHistoryPageInWorker(request()),
      ),
    );
    expect(queued).toHaveLength(2);
    queued[1]!.prepare();
    queued[1]!.result.resolve(page("capacity released"));
    for (const result of await fresh) {
      expect(result).toEqual({
        messages: [{ role: "assistant", content: [{ type: "text", text: "capacity released" }] }],
      });
    }
  },
);

it.runIf(process.env.OPENCLAW_BENCH_HISTORY_HANDOFF === "1")(
  "measures coalesced history handoff",
  async () => {
    const text = "x".repeat(1024 * 1024);
    const samples = [];
    for (let sample = 0; sample < 7; sample++) {
      const start = performance.now();
      const cpu = process.cpuUsage();
      for (let iteration = 0; iteration < 20; iteration++) {
        const first = readSessionHistoryPageInWorker(request());
        const second = readSessionHistoryPageInWorker(request());
        expect(queued).toHaveLength(1);
        queued[0]!.prepare();
        queued[0]!.result.resolve(page(text));
        const [a, b] = await Promise.all([first, second]);
        expect(a.messages[0]).not.toBe(b.messages[0]);
        queued.length = 0;
      }
      const used = process.cpuUsage(cpu);
      samples.push({
        msPerGroup: (performance.now() - start) / 20,
        cpuMsPerGroup: (used.user + used.system) / 1000 / 20,
      });
    }
    console.log(
      JSON.stringify({ readers: 2, textBytes: text.length, groupsPerSample: 20, samples }),
    );
  },
);

it.each([
  {
    entry: { sessionId: "history-worker", updatedAt: 1 },
    key: "agent:main:history-worker",
    validate: false,
  },
  { entry: undefined, key: "", validate: false },
  { entry: undefined, key: "agent:main:history-worker", validate: true },
  {
    entry: { sessionId: "successor", updatedAt: 1 },
    key: "agent:main:history-worker",
    validate: true,
  },
])(
  "carries conditional validation without reading or retargeting on enqueue: %j",
  async ({ entry, key, validate }) => {
    const pending = readSessionHistoryPageInWorker(request({ entry, canonicalKey: key }));
    expect(queued).toHaveLength(1);
    const input = queued[0]!.prepare();
    expect(input.target.transcript.sessionId).toBe("history-worker");
    expect(input.target.entryValidationKey).toBe(validate ? key : undefined);
    expect(input.database).toEqual({
      agentId: "main",
      path: expect.stringMatching(/openclaw-agent\.sqlite$/),
    });
    expect(input.target).not.toHaveProperty("database");
    expect(input.target).not.toHaveProperty("env");
    expect(runWorker.mock.calls[0]![1]).toBe(`1:${JSON.stringify(input)}`.length * 2);
    queued[0]!.result.resolve(page("requested transcript"));
    await pending;
  },
);

it.each([{ limit: 2 }, { cursor: "7" }, { maxChars: 20 }])(
  "includes HTTP pagination selectors in coalescing and byte admission: %j",
  async (difference) => {
    const rpc = request().params;
    const params = {
      target: {
        agentId: rpc.sessionAgentId,
        sessionKey: rpc.canonicalKey,
        sessionId: rpc.sessionId,
        sessionEntry: rpc.entry,
        storePath: rpc.storePath,
      },
      limit: 10,
      maxChars: 8000,
      cursor: undefined as string | undefined,
    };
    const first = readSessionHistoryPageInWorker({ kind: "http", params });
    const second = readSessionHistoryPageInWorker({
      kind: "http",
      params: { ...params, ...difference },
    });
    expect(queued).toHaveLength(2);
    for (const [index, job] of queued.entries()) {
      const input = job.prepare();
      expect(runWorker.mock.calls[index]![1]).toBe(`1:${JSON.stringify(input)}`.length * 2);
      job.result.resolve({
        kind: "http",
        snapshot: {
          history: { items: [], messages: [], hasMore: false },
          rawTranscriptSeq: 0,
          turnBoundaryPending: false,
          assistantErrorPending: false,
        },
      });
    }
    await Promise.all([first, second]);
  },
);
