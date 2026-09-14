import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type {
  SessionHistoryWorkerRequest,
  SessionHistoryWorkerResult,
} from "../config/sessions/session-history-types.js";
import { readSessionHistoryPageInWorker } from "../config/sessions/session-history-worker-runtime.js";
import type { SessionTranscriptHistoryWorkerInput } from "../config/sessions/session-transcript.worker.js";
import { DEFAULT_WORKER_PENDING_TASKS } from "../infra/worker-task-capacity.js";

const runWorker = vi.hoisted(() => vi.fn());
const preparation = vi.hoisted(() => ({
  enabled: false,
  generation: Symbol("registry"),
  run: vi.fn(),
}));
vi.mock("../config/sessions/session-transcript-worker-runtime.js", () => ({
  runSessionHistoryWorkerRequest: runWorker,
  runSessionColdPreparationWorkerRequest: preparation.run,
}));
vi.mock("../config/sessions/session-cold-storage-read.js", () => ({
  readRestoredSessionTranscript: async (
    scope: { agentId: string; sessionId: string; storePath?: string; sessionKey?: string },
    read: (target: { agentId: string; sessionId: string; path?: string }) => unknown,
    options?: {
      prepareColdRead?: (
        request: { scope: typeof scope },
        generation: symbol,
      ) => Promise<{ target: typeof scope }>;
    },
  ) =>
    preparation.enabled && options?.prepareColdRead
      ? read((await options.prepareColdRead({ scope }, preparation.generation)).target)
      : read({ ...scope, path: scope.storePath }),
}));

type RpcRequest = Extract<SessionHistoryWorkerRequest, { kind: "rpc" }>;
const queued: Array<{
  prepare: () => SessionTranscriptHistoryWorkerInput;
  result: ReturnType<typeof createDeferred<SessionHistoryWorkerResult>>;
}> = [];

beforeEach(() => {
  queued.length = 0;
  preparation.enabled = false;
  preparation.generation = Symbol("registry");
  preparation.run.mockReset();
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

it("bounds coalesced waiters and releases their capacity without cloning cancelled replies", async () => {
  const controller = new AbortController();
  const readers = Array.from({ length: DEFAULT_WORKER_PENDING_TASKS }, (_, index) =>
    readSessionHistoryPageInWorker(request(), index === 0 ? controller.signal : undefined),
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
    expect(results[0]).toEqual({ status: "rejected", reason: cancelled });
    expect(results.slice(1).every((result) => result.status === "fulfilled")).toBe(true);
    expect(clone).toHaveBeenCalledTimes(DEFAULT_WORKER_PENDING_TASKS - 1);
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
});

it("shares an initial probe only within its captured registry generation", async () => {
  preparation.enabled = true;
  const replies = [
    createDeferred<{
      target: { agentId: string; sessionId: string; path: string };
      archive: undefined;
    }>(),
    createDeferred<{
      target: { agentId: string; sessionId: string; path: string };
      archive: undefined;
    }>(),
  ];
  preparation.run
    .mockImplementationOnce(() => replies[0]!.promise)
    .mockImplementationOnce(() => replies[1]!.promise);
  const first = readSessionHistoryPageInWorker(request());
  const shared = readSessionHistoryPageInWorker(request());
  expect(preparation.run).toHaveBeenCalledOnce();
  preparation.generation = Symbol("changed registry");
  const successor = readSessionHistoryPageInWorker(request());
  expect(preparation.run).toHaveBeenCalledTimes(2);
  for (const reply of replies) {
    reply.resolve({
      target: {
        agentId: "main",
        sessionId: "history-worker",
        path: "/tmp/history-worker-fixture/sessions.json",
      },
      archive: undefined,
    });
  }
  await vi.waitFor(() => expect(queued).toHaveLength(1));
  queued[0]!.prepare();
  queued[0]!.result.resolve(page("one page after prepared scopes"));
  const result = await Promise.all([first, shared, successor]);
  expect(result[0]).toEqual(result[1]);
  expect(result[1]).toEqual(result[2]);
});
