import path from "node:path";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import * as sqliteScope from "../config/sessions/session-accessor.sqlite-scope.js";
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
import { SessionTranscriptProjectionUnavailableError } from "../config/sessions/session-transcript-projection-error.js";
import * as reconcile from "../config/sessions/session-transcript-reconcile.js";
import type { SessionTranscriptHistoryWorkerInput } from "../config/sessions/session-transcript-worker.types.js";
import { normalizeStoreSessionKey } from "../config/sessions/store-entry.js";
import { DEFAULT_WORKER_PENDING_TASKS } from "../infra/worker-task-capacity.js";
import { AgentDatabaseRegistryChangedError } from "../state/openclaw-agent-db-registry-listing.js";
import * as stateContext from "../state/openclaw-state-worker-context.js";
import * as storeSources from "./session-utils-store-sources.js";

const { runWorker, readerAdmitted } = vi.hoisted(() => ({
  runWorker: vi.fn(),
  readerAdmitted: vi.fn(),
}));
// mock-isolation: Exercise dispatch and byte admission without opening real history workers.
vi.mock("../config/sessions/session-transcript-worker-runtime.js", () => ({
  withSessionHistoryWorkerDatabase: (
    _options: unknown,
    operation: (owner: { run: typeof runWorker; assertCurrent: () => void }) => unknown,
  ) =>
    operation({
      run: runWorker,
      assertCurrent() {},
    }),
}));
// mock-isolation: Cold restoration has its own owner tests; this fixture controls read callbacks.
vi.mock("../config/sessions/session-cold-storage-read.js", () => ({
  readRestoredSessionTranscript: async (_scope: unknown, read: () => unknown) => {
    const pending = read();
    readerAdmitted();
    return pending;
  },
}));

type RpcRequest = Extract<SessionHistoryWorkerRequest, { kind: "rpc" }>;
const queued: Array<{
  prepare: () => SessionTranscriptHistoryWorkerInput;
  result: ReturnType<typeof createDeferred<SessionHistoryWorkerResult>>;
}> = [];
let admittedReaders = 0;
const admissionWaiters: Array<{ count: number; ready: ReturnType<typeof createDeferred<void>> }> =
  [];

function waitForReaderAdmission(count: number): Promise<void> {
  if (admittedReaders >= count) {
    return Promise.resolve();
  }
  const ready = createDeferred();
  admissionWaiters.push({ count, ready });
  return ready.promise;
}

beforeEach(() => {
  vi.spyOn(sqliteScope, "prepareSqliteTranscriptReadScope").mockImplementation(async (scope) => {
    if (!scope.agentId || !scope.storePath) {
      throw new Error("Queue fixture requires an explicit history target");
    }
    return {
      agentId: scope.agentId,
      sessionId: scope.sessionId,
      env: scope.env,
      path: path.join(path.dirname(scope.storePath), "openclaw-agent.sqlite"),
      ownerStorePath: scope.storePath,
      ...(scope.sessionKey ? { sessionKey: normalizeStoreSessionKey(scope.sessionKey) } : {}),
    };
  });
  queued.length = 0;
  admittedReaders = 0;
  admissionWaiters.length = 0;
  readerAdmitted.mockReset().mockImplementation(() => {
    admittedReaders++;
    for (const waiter of admissionWaiters) {
      if (admittedReaders >= waiter.count) {
        waiter.ready.resolve();
      }
    }
  });
  runWorker.mockReset().mockImplementation((prepare: () => SessionTranscriptHistoryWorkerInput) => {
    const result = createDeferred<SessionHistoryWorkerResult>();
    queued.push({ prepare, result });
    return result.promise;
  });
});

afterEach(() => vi.restoreAllMocks());

it.each(["timeout", "cancel"] as const)(
  "bounds projection recovery and preserves caller %s",
  async (boundary) => {
    vi.useFakeTimers();
    const waiting = createDeferred();
    const controller = new AbortController();
    const unavailable = new SessionTranscriptProjectionUnavailableError("history-worker");
    vi.spyOn(reconcile, "startSessionTranscriptIndexReconcile").mockImplementation(() => {});
    vi.spyOn(reconcile, "waitForSessionTranscriptProjection").mockImplementation(
      async (_scope, signal) => {
        if (!signal) {
          throw new Error("Projection recovery requires a bounded signal");
        }
        waiting.resolve();
        return new Promise((_, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              const reason: unknown = signal.reason;
              reject(reason instanceof Error ? reason : new Error(String(reason)));
            },
            { once: true },
          );
        });
      },
    );
    let settled = false;
    const pending = readSessionHistoryPageInWorker(request(), controller.signal)
      .then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      )
      .finally(() => {
        settled = true;
      });
    try {
      await waitForReaderAdmission(1);
      queued[0]!.prepare();
      queued[0]!.result.reject(unavailable);
      expect(
        await Promise.race([waiting.promise.then(() => "waiting"), pending.then(() => "refused")]),
      ).toBe("waiting");
      await vi.advanceTimersByTimeAsync(2_999);
      expect(settled).toBe(false);
      const cancelled = new Error("history caller disconnected");
      if (boundary === "cancel") {
        controller.abort(cancelled);
      } else {
        await vi.advanceTimersByTimeAsync(1);
      }
      expect(await pending).toEqual({ error: boundary === "cancel" ? cancelled : unavailable });
      expect(queued).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      controller.abort();
      await pending;
      vi.useRealTimers();
    }
  },
);

it("does not schedule projection writes for read-only history", async () => {
  const start = vi
    .spyOn(reconcile, "startSessionTranscriptIndexReconcile")
    .mockImplementation(() => {});
  const wait = vi.spyOn(reconcile, "waitForSessionTranscriptProjection");
  const pending = readSessionHistoryPageInWorker({
    kind: "message-page",
    params: {
      target: historyTarget(),
      options: { offset: 0, maxMessages: 20, maxBytes: 100_000, readOnly: true },
    },
  });
  const unavailable = new SessionTranscriptProjectionUnavailableError("history-worker");
  const rejected = expect(pending).rejects.toBe(unavailable);
  await waitForReaderAdmission(1);
  queued[0]!.prepare();
  queued[0]!.result.reject(unavailable);
  await rejected;
  expect(start).not.toHaveBeenCalled();
  expect(wait).not.toHaveBeenCalled();
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

function historyTarget() {
  const rpc = request().params;
  return {
    agentId: rpc.sessionAgentId,
    sessionId: rpc.sessionId,
    sessionKey: rpc.canonicalKey,
    storePath: rpc.storePath,
  };
}

it("captures prepared Claude history authority, cwd, and node placement in queued requests", async () => {
  const pending = readSessionHistoryPageInWorker(
    request({
      entry: {
        sessionId: "history-worker",
        updatedAt: 1,
        execHost: "node",
        cliSessionBindings: {
          "claude-cli": {
            sessionId: "native-session",
            cwd: "/native/workspace",
            transcriptRoot: "/native/profile/projects",
          },
        },
      },
      cwd: "/current/child",
      cliHistoryProjectsRoot: "/authorized/profile/projects",
    }),
  );
  await waitForReaderAdmission(1);
  const input = queued[0]!.prepare();

  expect(input.request).toMatchObject({
    kind: "rpc",
    params: {
      cwd: "/current/child",
      cliHistoryProjectsRoot: "/authorized/profile/projects",
      entry: {
        execHost: "node",
        cliSessionBindings: {
          "claude-cli": {
            sessionId: "native-session",
            cwd: "/native/workspace",
            transcriptRoot: "/native/profile/projects",
          },
        },
      },
    },
  });
  expect(runWorker.mock.calls[0]![1]).toBe(JSON.stringify(input).length * 2);
  queued[0]!.result.resolve(page("captured authorized root"));
  await pending;
});

function page(text: string): Extract<SessionHistoryWorkerResult, { kind: "rpc" }> {
  return {
    kind: "rpc",
    page: { messages: [{ role: "assistant", content: [{ type: "text", text }] }] },
  };
}

it("treats an empty exact archive path as an ordinary recent-history request", async () => {
  const result = { messages: [], totalMessages: 0 };
  runWorker.mockImplementationOnce(async (prepare: () => SessionTranscriptHistoryWorkerInput) => {
    const input = prepare();
    expect(input.request.kind).toBe("recent-page");
    expect(input.request.params).not.toHaveProperty("exactArchivePath");
    return { kind: "recent-page", result };
  });
  await expect(
    readSessionHistoryPageInWorker({
      kind: "recent-page",
      params: { target: historyTarget(), exactArchivePath: "", options: { maxMessages: 10 } },
    }),
  ).resolves.toEqual(result);
});

function httpPage(): SessionHistoryWorkerResult {
  return {
    kind: "http",
    snapshot: {
      history: { items: [], messages: [], hasMore: false },
      rawTranscriptSeq: 0,
      turnBoundaryPending: false,
      assistantErrorPending: false,
    },
  };
}

it.each([false, true])(
  "keeps exact lookup independent of auxiliary registry churn but retains primary authority (revoke: %s)",
  async (revoke) => {
    vi.spyOn(storeSources, "prepareGatewaySessionStoreReadSourcesAsync").mockRejectedValue(
      new AgentDatabaseRegistryChangedError(),
    );
    const capture = stateContext.captureOpenClawStateWorkerContext;
    const revoked = new Error("primary history owner revoked");
    let workerReturned = false;
    vi.spyOn(stateContext, "captureOpenClawStateWorkerContext").mockImplementation((...args) => {
      const captured = capture(...args);
      return {
        ...captured,
        admission: {
          ...captured.admission,
          assertCurrent() {
            captured.admission.assertCurrent();
            if (revoke && workerReturned) {
              throw revoked;
            }
          },
        },
      };
    });
    const message = { role: "assistant", content: [{ type: "text", text: "primary answer" }] };
    const found = { found: true, oversized: false, message, seq: 2 };
    runWorker.mockImplementationOnce(async () => {
      workerReturned = true;
      return { kind: "message-by-id", result: found };
    });
    const pending = readSessionHistoryPageInWorker({
      kind: "message-by-id",
      params: { target: historyTarget(), messageId: "answer" },
    });
    if (revoke) {
      await expect(pending).rejects.toBe(revoked);
    } else {
      await expect(pending).resolves.toEqual(found);
    }
  },
);

it.each(["rpc", "http", "delta", "inline-visibility"] as const)(
  "retains auxiliary registry refusal for %s lineage projection",
  async (kind) => {
    const failure = new AgentDatabaseRegistryChangedError();
    vi.spyOn(storeSources, "prepareGatewaySessionStoreReadSourcesAsync").mockRejectedValue(failure);
    const rpc = request();
    const target = {
      agentId: rpc.params.sessionAgentId,
      sessionId: rpc.params.sessionId,
      sessionKey: rpc.params.canonicalKey,
      storePath: rpc.params.storePath,
    };
    const pending =
      kind === "rpc"
        ? readSessionHistoryPageInWorker(rpc)
        : kind === "http"
          ? readSessionHistoryPageInWorker({ kind, params: { target, maxChars: 8000, limit: 10 } })
          : kind === "inline-visibility"
            ? readSessionHistoryPageInWorker({
                kind,
                params: { target, lookup: { kind: "run", runId: "run", messageSeq: 1 } },
              })
            : readSessionHistoryPageInWorker({ kind, params: { target, limits: {} } });
    await expect(pending).rejects.toBe(failure);
    expect(runWorker).not.toHaveBeenCalled();
  },
);

it.each(["rpc", "http"] as const)(
  "captures %s request identity and selectors before target preparation and queue dispatch",
  async (kind) => {
    const makeRequest = (
      includeUnrelatedEnv = false,
    ): Extract<SessionHistoryWorkerRequest, { kind: "rpc" | "http" }> => {
      const rpc = request({
        provider: "original-provider",
        offset: 4,
        messageId: "original-anchor",
        ignoreCliSessionImports: true,
      });
      return kind === "rpc"
        ? rpc
        : {
            kind: "http",
            params: {
              target: {
                agentId: rpc.params.sessionAgentId,
                sessionId: rpc.params.sessionId,
                sessionKey: rpc.params.canonicalKey,
                storePath: rpc.params.storePath,
                sessionEntry: rpc.params.entry,
                env: {
                  OPENCLAW_STATE_DIR: "/tmp/http-history-captured-state",
                  ...(includeUnrelatedEnv ? { UNRELATED_SECRET: "synthetic" } : {}),
                },
              },
              limit: 20,
              maxChars: 8000,
              cursor: "7",
            },
          };
    };
    const supplied = makeRequest(true);
    const expected = makeRequest();
    const mutate = (stage: string) => {
      const entry =
        supplied.kind === "rpc" ? supplied.params.entry : supplied.params.target.sessionEntry;
      if (!entry) {
        throw new Error("Capture fixture requires entry metadata");
      }
      entry.sessionId = `${stage}-entry`;
      entry.updatedAt = 99;
      entry.sessionStartedAt = 98;
      if (supplied.kind === "rpc") {
        Object.assign(supplied.params, {
          sessionAgentId: "other",
          sessionId: `${stage}-session`,
          canonicalKey: `agent:other:${stage}`,
          storePath: `/tmp/${stage}/sessions.json`,
          provider: stage,
          max: 2,
          maxHistoryBytes: 512,
          effectiveMaxChars: 20,
          offset: 2,
          messageId: `${stage}-anchor`,
          ignoreCliSessionImports: false,
        });
      } else {
        if (supplied.params.target.env) {
          supplied.params.target.env.OPENCLAW_STATE_DIR = `/tmp/${stage}-http-state`;
        }
        Object.assign(supplied.params.target, {
          agentId: "other",
          sessionId: `${stage}-session`,
          sessionKey: `agent:other:${stage}`,
          storePath: `/tmp/${stage}/sessions.json`,
        });
        Object.assign(supplied.params, { limit: 2, maxChars: 20, cursor: `${stage}-cursor` });
      }
    };
    const entered = createDeferred();
    const release = createDeferred();
    const prepare = vi.mocked(sqliteScope.prepareSqliteTranscriptReadScope).getMockImplementation();
    if (!prepare) {
      throw new Error("Capture fixture requires the prepared-target boundary");
    }
    vi.mocked(sqliteScope.prepareSqliteTranscriptReadScope).mockImplementationOnce(
      async (...args) => {
        const target = await prepare(...args);
        entered.resolve();
        await release.promise;
        return target;
      },
    );
    const first = readSessionHistoryPageInWorker(supplied);
    await entered.promise;
    mutate("during-preparation");
    release.resolve();
    await waitForReaderAdmission(1);
    const second = readSessionHistoryPageInWorker(makeRequest());
    await waitForReaderAdmission(2);
    mutate("after-enqueue-before-dispatch");

    const dispatched = queued.map((job, index) => {
      const input = job.prepare();
      const bytes = runWorker.mock.calls[index]![1];
      job.result.resolve(kind === "rpc" ? page("captured request") : httpPage());
      return { input, bytes };
    });
    const outcomes = await Promise.allSettled([first, second]);
    expect.soft(outcomes.every((outcome) => outcome.status === "fulfilled")).toBe(true);
    expect.soft(outcomes[0]).toEqual(outcomes[1]);
    expect.soft(dispatched).toHaveLength(1);
    for (const { input, bytes } of dispatched) {
      expect.soft(input.request).toEqual(expected);
      expect.soft(input.target.transcript).toMatchObject({
        agentId: "main",
        sessionId: "history-worker",
        sessionKey: "agent:main:history-worker",
        storePath: "/tmp/history-worker-fixture/sessions.json",
      });
      expect.soft(bytes).toBe(JSON.stringify(input).length * 2);
    }
  },
);

it.each([
  "delta",
  "inline-visibility",
  "message-lookup",
  "recent",
  "message-by-id",
  "message-count",
] as const)("captures %s selectors and target before asynchronous dispatch", async (kind) => {
  const target = {
    agentId: "main",
    sessionId: "history-worker",
    sessionKey: "agent:main:history-worker",
    storePath: "/tmp/history-worker-fixture/sessions.json",
    sessionEntry: { sessionId: "history-worker" },
    env: { OPENCLAW_STATE_DIR: "/tmp/captured-history-state", UNRELATED_SECRET: "synthetic" },
  };
  const supplied =
    kind === "delta"
      ? {
          kind,
          params: { target, limits: { cursor: "original", maxBytes: 8000, maxEvents: 10 } },
        }
      : kind === "inline-visibility"
        ? {
            kind,
            params: { target, lookup: { kind: "run" as const, runId: "original", messageSeq: 7 } },
          }
        : kind === "recent"
          ? {
              kind,
              params: { target, maxMessages: 10, maxLines: 220, allowResetArchiveFallback: true },
            }
          : kind === "message-count"
            ? { kind, params: { target } }
            : kind === "message-by-id"
              ? {
                  kind,
                  params: {
                    target,
                    messageId: "original",
                    options: {
                      currentOnly: true as const,
                      maxBytes: 8000,
                      allowResetArchiveFallback: true,
                    },
                  },
                }
              : { kind, params: { target, messageId: "original" } };
  const expected = structuredClone(supplied);
  const pending = readSessionHistoryPageInWorker(supplied);
  target.sessionId = "successor";
  target.sessionEntry.sessionId = "successor";
  target.env.OPENCLAW_STATE_DIR = "/tmp/successor-history-state";
  if (supplied.kind === "delta") {
    supplied.params.limits.cursor = "successor";
    supplied.params.limits.maxEvents = 1;
  } else if (supplied.kind === "inline-visibility") {
    supplied.params.lookup.runId = "successor";
    supplied.params.lookup.messageSeq = 8;
  } else if (supplied.kind === "recent") {
    supplied.params.maxMessages = 1;
    supplied.params.maxLines = 2;
    supplied.params.allowResetArchiveFallback = false;
  } else if (supplied.kind === "message-by-id") {
    supplied.params.messageId = "successor";
    supplied.params.options.maxBytes = 1;
    supplied.params.options.allowResetArchiveFallback = false;
  } else if (supplied.kind === "message-lookup") {
    supplied.params.messageId = "successor";
  }
  await waitForReaderAdmission(1);
  const input = queued[0]!.prepare();
  queued[0]!.result.resolve(
    kind === "delta"
      ? {
          kind,
          delta: { kind: "reset", cursor: "next", reason: "invalid_cursor" },
          subagentCoordination: { sessions: [], runMessages: [] },
        }
      : kind === "inline-visibility"
        ? { kind, subagentCoordination: { sessions: [], runMessages: [["original", 7, false]] } }
        : kind === "message-by-id"
          ? { kind, result: { found: false, oversized: false } }
          : kind === "message-count"
            ? { kind, count: 0 }
            : { kind, messages: [] },
  );
  await pending;
  expect(input.request).toMatchObject({
    kind,
    params: {
      ...expected.params,
      target: {
        ...expected.params.target,
        env: { OPENCLAW_STATE_DIR: "/tmp/captured-history-state" },
      },
    },
  });
  expect(
    input.request.kind === "rpc" || input.request.kind === "rpc-message"
      ? undefined
      : input.request.params.target,
  ).not.toHaveProperty("env.UNRELATED_SECRET");
});

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
      await waitForReaderAdmission(2);
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
        ...historyTarget(),
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
  await waitForReaderAdmission(1);
  queued[0]!.prepare();
  queued[0]!.result.reject(failure);
  await rejected;
});

it("shares queued equivalent pages but starts a fresh read after dispatch", async () => {
  const first = readSessionHistoryPageInWorker(request());
  const second = readSessionHistoryPageInWorker(request());
  await waitForReaderAdmission(2);
  expect(queued).toHaveLength(1);

  queued[0]!.prepare();
  const afterAppend = readSessionHistoryPageInWorker(request());
  await waitForReaderAdmission(3);
  expect(queued).toHaveLength(2);
  queued[0]!.result.resolve(page("before append"));
  const [a, b] = await Promise.all([first, second]);
  const sameSuccessor = readSessionHistoryPageInWorker(request());
  await waitForReaderAdmission(4);
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

it.each(["rpc limit", "rpc store", "http cursor"] as const)(
  "keeps distinct %s selectors separate in coalescing and byte admission",
  async (selector) => {
    const makeRequest = (different: boolean): SessionHistoryWorkerRequest =>
      selector === "http cursor"
        ? {
            kind: "http",
            params: {
              target: { ...historyTarget(), sessionEntry: request().params.entry },
              limit: 10,
              maxChars: 8000,
              cursor: different ? "7" : undefined,
            },
          }
        : request(
            different
              ? selector === "rpc limit"
                ? { max: 2 }
                : { storePath: "/tmp/another-history-worker-fixture/sessions.json" }
              : {},
          );
    const first = readSessionHistoryPageInWorker(makeRequest(false));
    const second = readSessionHistoryPageInWorker(makeRequest(true));
    await waitForReaderAdmission(2);
    expect(queued).toHaveLength(2);
    for (const [index, job] of queued.entries()) {
      const input = job.prepare();
      expect(runWorker.mock.calls[index]![1]).toBe(JSON.stringify(input).length * 2);
      job.result.resolve(selector === "http cursor" ? httpPage() : page("selected page"));
    }
    await Promise.all([first, second]);
  },
);

it("discards a rejected queued read so a later request can succeed", async () => {
  const first = readSessionHistoryPageInWorker(request());
  const second = readSessionHistoryPageInWorker(request());
  const failed = Promise.allSettled([first, second]);
  await waitForReaderAdmission(2);
  queued[0]!.result.reject(new Error("worker unavailable"));
  expect(await failed).toEqual([
    { status: "rejected", reason: new Error("worker unavailable") },
    { status: "rejected", reason: new Error("worker unavailable") },
  ]);
  const fresh = readSessionHistoryPageInWorker(request());
  await waitForReaderAdmission(3);
  expect(queued).toHaveLength(2);
  queued[1]!.prepare();
  queued[1]!.result.resolve(page("recovered"));
  expect(await fresh).toEqual({
    messages: [{ role: "assistant", content: [{ type: "text", text: "recovered" }] }],
  });
});

it.each([
  { encoded: true, cancelledIndex: 0 },
  { encoded: false, cancelledIndex: DEFAULT_WORKER_PENDING_TASKS - 1 },
])(
  "bounds coalesced waiters when reader $cancelledIndex cancels during the worker read (encoded: $encoded)",
  async ({ cancelledIndex, encoded }) => {
    const controller = new AbortController();
    const readers = Array.from({ length: DEFAULT_WORKER_PENDING_TASKS }, (_, index) =>
      readSessionHistoryPageInWorker(
        request(),
        index === cancelledIndex ? controller.signal : undefined,
      ),
    );
    const settled = Promise.allSettled(readers);
    await waitForReaderAdmission(DEFAULT_WORKER_PENDING_TASKS);
    expect(queued).toHaveLength(1);
    await expect(readSessionHistoryPageInWorker(request())).rejects.toMatchObject({
      code: "overloaded",
    });
    queued[0]!.prepare();
    const cancelled = new Error("caller closed");
    controller.abort(cancelled);
    // The cancelled callback remains retained by the shared promise until its job settles.
    await expect(readSessionHistoryPageInWorker(request())).rejects.toMatchObject({
      code: "overloaded",
    });
    expect(queued).toHaveLength(1);

    const clone = vi.spyOn(globalThis, "structuredClone");
    try {
      const reply = page("shared result");
      const bytes = new TextEncoder().encode(JSON.stringify(reply.page.messages));
      if (encoded) {
        reply.page.messages = [];
        reply.page.encodedResponse = {
          messages: bytes,
          messagesBytes: bytes.byteLength,
          responseHistoryBytes: 1024,
          omission: { omittedCount: 1, normalizedBytes: 2048 },
        };
      }
      queued[0]!.result.resolve(reply);
      const results = await settled;
      expect(results[cancelledIndex]).toEqual({ status: "rejected", reason: cancelled });
      expect(
        results
          .filter((_, index) => index !== cancelledIndex)
          .every((result) => result.status === "fulfilled"),
      ).toBe(true);
      if (encoded) {
        const pages = results.flatMap((result) =>
          result.status === "fulfilled" ? [result.value] : [],
        );
        for (const result of pages) {
          // A coalesced page transfers its immutable wire buffer only once.
          expect(result.encodedResponse?.messages).toBe(bytes);
        }
        pages[0]!.encodedResponse!.omission!.omittedCount = 9;
        expect(pages[1]!.encodedResponse!.omission!.omittedCount).toBe(1);
      }
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
    await waitForReaderAdmission(DEFAULT_WORKER_PENDING_TASKS * 2);
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
    await waitForReaderAdmission(1);
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
    expect(runWorker.mock.calls[0]![1]).toBe(JSON.stringify(input).length * 2);
    queued[0]!.result.resolve(page("requested transcript"));
    await pending;
  },
);
