import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import process from "node:process";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../infra/runtime-worker-url.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { sessionNativeProcessEntrypoints } from "./native-process-runtime.test-support.js";
import {
  appendTranscriptMessage,
  loadSessionEntry,
  loadTranscriptEvents,
  updateSessionEntry,
  upsertSessionEntryCore,
  withTranscriptWriteLock,
} from "./session-accessor.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.test-support.js";
import type { ReplySessionInitializationCommitResult } from "./session-accessor.types.js";

vi.mock("../config.js", async () => ({
  ...(await vi.importActual<typeof import("../config.js")>("../config.js")),
  getRuntimeConfig: vi.fn().mockReturnValue({}),
}));

type TranscriptRewriteChildResult = { ok: true } | { message: string; name: string; ok: false };

type ConcurrencyWorkerRequest =
  | {
      kind: "reply-init";
      preparedUpdatedAt: number;
      storePath: string;
    }
  | {
      kind: "transcript-rewrite";
      rewriteMode: "read-then-replace" | "replace-twice";
      sessionId: string;
      storePath: string;
    };

type ConcurrencyWorkerReady<TRequest extends ConcurrencyWorkerRequest> =
  TRequest["kind"] extends "reply-init"
    ? { currentEntry?: unknown; revision: string }
    : { eventCount: number };

type ConcurrencyWorkerResult<TRequest extends ConcurrencyWorkerRequest> =
  TRequest["kind"] extends "reply-init"
    ? ReplySessionInitializationCommitResult
    : TranscriptRewriteChildResult;

type ConcurrencyWorkerMessage =
  | { phase: "booted" }
  | { error: { message: string; name: string }; phase: "error"; requestId: number }
  | { phase: "ready"; requestId: number; value: unknown }
  | { phase: "result"; requestId: number; value: unknown };

// Module compilation belongs to invocation preparation; retain native startup and handshake guards.
const WORKER_BOOT_TIMEOUT_MS = 30_000;
const SCENARIO_TIMEOUT_MS = 10_000;
const SESSION_KEY = "agent:main:main";
const AGENT_ID = "main";
const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-reply-init-");
let concurrencyWorker: ReturnType<typeof spawn> | undefined;
let nextRequestId = 0;

function createConcurrencyWorkerScript(sessionAccessorUrl: string): string {
  return `
const {
  commitReplySessionInitialization,
  loadReplySessionInitializationSnapshot,
  withTranscriptWriteLock,
} = await import(${JSON.stringify(sessionAccessorUrl)});

const SESSION_KEY = ${JSON.stringify(SESSION_KEY)};
const AGENT_ID = ${JSON.stringify(AGENT_ID)};
const proceedResolvers = new Map();
const scope = (request) => ({ agentId: AGENT_ID, sessionKey: SESSION_KEY, storePath: request.storePath });
const failure = (error) => ({
  name: error instanceof Error ? error.name : typeof error,
  message: error instanceof Error ? error.message : String(error),
});

function send(message) {
  process.send?.(message);
}

async function ready(request, value) {
  const proceed = new Promise((resolve) => { proceedResolvers.set(request.requestId, resolve); });
  send({ phase: "ready", requestId: request.requestId, value });
  await proceed;
}

function message(id, content) {
  return { type: "message", id, parentId: null, message: { role: "assistant", content } };
}

async function runReplyInit(request) {
  const snapshot = await loadReplySessionInitializationSnapshot(scope(request));
  await ready(request, { currentEntry: snapshot.currentEntry, revision: snapshot.revision });
  return commitReplySessionInitialization({
    ...scope(request),
    activeSessionKey: SESSION_KEY,
    expectedRevision: snapshot.revision,
    sessionEntry: {
      sessionId: "existing-session",
      updatedAt: request.preparedUpdatedAt,
    },
    snapshotEntry: snapshot.currentEntry,
  });
}

async function runTranscriptRewrite(request) {
  try {
    await withTranscriptWriteLock(
      { ...scope(request), sessionId: request.sessionId },
      async (transcript) => {
        if (request.rewriteMode === "replace-twice") {
          const firstReplacement = [
            { type: "session", version: 3, id: request.sessionId },
            message("first-replacement", "first replacement"),
          ];
          await transcript.replaceEvents(firstReplacement);
          await ready(request, { eventCount: firstReplacement.length });
          await transcript.replaceEvents([
            firstReplacement[0],
            message("first-replacement", "second replacement"),
          ]);
          return;
        }
        const events = await transcript.readEvents();
        await ready(request, { eventCount: events.length });
        const rewrittenEvents = events.map((event) => event.id === "rewrite-target"
          ? { ...event, message: { ...event.message, content: "rewritten content" } }
          : event);
        await transcript.replaceEvents(rewrittenEvents);
      },
    );
    return { ok: true };
  } catch (error) {
    return { ok: false, ...failure(error) };
  }
}

process.on("message", (request) => {
  if (request.kind === "shutdown") {
    process.exit(0);
  }
  if (request.kind === "proceed") {
    const resolve = proceedResolvers.get(request.requestId);
    proceedResolvers.delete(request.requestId);
    resolve?.();
    return;
  }
  void (async () => {
    const value =
      request.kind === "reply-init"
        ? await runReplyInit(request)
        : await runTranscriptRewrite(request);
    send({ phase: "result", requestId: request.requestId, value });
  })().catch((error) => {
    send({ error: failure(error), phase: "error", requestId: request.requestId });
  });
});

process.on("disconnect", () => process.exit(0));
send({ phase: "booted" });
`;
}

function isWorkerMessage(message: unknown): message is ConcurrencyWorkerMessage {
  return typeof message === "object" && message !== null && "phase" in message;
}

function waitForWorkerMessage<T>(
  child: ReturnType<typeof spawn>,
  label: string,
  timeoutMs: number,
  handle: (
    message: ConcurrencyWorkerMessage,
    resolve: (value: T) => void,
    fail: (error: Error) => void,
  ) => void,
  start?: (fail: (error: Error) => void) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      fail(new Error(`timeout waiting for concurrency worker ${label}`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timeout);
      child.off("error", onError);
      child.off("exit", onExit);
      child.off("message", onMessage);
    };
    const fail = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onError = fail;
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      fail(
        new Error(
          `concurrency worker exited during ${label} code=${String(code)} signal=${String(signal)}`,
        ),
      );
    };
    const onMessage = (message: unknown) => {
      if (isWorkerMessage(message)) {
        handle(
          message,
          (value) => {
            cleanup();
            resolve(value);
          },
          fail,
        );
      }
    };
    child.once("error", onError);
    child.once("exit", onExit);
    child.on("message", onMessage);
    start?.(fail);
  });
}

async function getConcurrencyWorker(): Promise<ReturnType<typeof spawn>> {
  if (concurrencyWorker) {
    return concurrencyWorker;
  }
  const sessionAccessorUrl = resolveRuntimeWorkerUrl(sessionNativeProcessEntrypoints.accessor);
  const child = spawn(
    process.execPath,
    [
      ...resolveRuntimeWorkerArgv(sessionAccessorUrl).slice(0, -1),
      "--input-type=module",
      "--eval",
      createConcurrencyWorkerScript(sessionAccessorUrl.href),
    ],
    { stdio: ["ignore", "pipe", "pipe", "ipc"] },
  );
  try {
    await waitForWorkerMessage<void>(
      child,
      "startup",
      WORKER_BOOT_TIMEOUT_MS,
      (message, resolve) => {
        if (message.phase === "booted") {
          resolve();
        }
      },
    );
  } catch (error) {
    child.kill();
    throw error;
  }
  concurrencyWorker = child;
  return child;
}

async function runConcurrencyScenario<TRequest extends ConcurrencyWorkerRequest>(
  request: TRequest,
  onReady: (value: ConcurrencyWorkerReady<TRequest>) => Promise<void> | void,
): Promise<ConcurrencyWorkerResult<TRequest>> {
  const child = await getConcurrencyWorker();
  const requestId = ++nextRequestId;
  let readyHandled = false;
  return waitForWorkerMessage<ConcurrencyWorkerResult<TRequest>>(
    child,
    request.kind,
    SCENARIO_TIMEOUT_MS,
    (message, resolve, fail) => {
      if (!("requestId" in message) || message.requestId !== requestId) {
        return;
      }
      if (message.phase === "error") {
        const error = new Error(message.error.message);
        error.name = message.error.name;
        fail(error);
        return;
      }
      if (message.phase === "ready" && !readyHandled) {
        readyHandled = true;
        void Promise.resolve(onReady(message.value as ConcurrencyWorkerReady<TRequest>)).then(
          () => {
            child.send({ kind: "proceed", requestId }, (error) => {
              if (error) {
                fail(error);
              }
            });
          },
          fail,
        );
        return;
      }
      if (message.phase === "result") {
        resolve(message.value as ConcurrencyWorkerResult<TRequest>);
      }
    },
    (fail) =>
      child.send({ ...request, requestId }, (error) => {
        if (error) {
          fail(error);
        }
      }),
  );
}

const message = (id: string, content: string) => ({
  type: "message",
  id,
  parentId: null,
  message: { role: "assistant", content },
});
const transcriptEvents = (
  sessionId: string,
  id = "rewrite-target",
  content = "original content",
) => [{ type: "session", version: 3, id: sessionId }, message(id, content)];
async function fixture(sessionId: string) {
  const tempDir = sessionDirs.make();
  const storePath = path.join(tempDir, "sessions.json");
  const scope = { agentId: AGENT_ID, sessionId, sessionKey: SESSION_KEY, storePath };
  await upsertSessionEntryCore(scope, { sessionId, updatedAt: Date.now() });
  return { tempDir, storePath, scope };
}
async function waitForChild(child: ReturnType<typeof spawn>, label: string): Promise<void> {
  const output = { stdout: "", stderr: "" };
  for (const stream of ["stdout", "stderr"] as const) {
    child[stream]?.setEncoding("utf8");
    child[stream]?.on("data", (chunk) => {
      output[stream] += String(chunk);
    });
  }
  // Honor an already-observed exit instead of waiting for a spent event.
  if (child.exitCode === null && child.signalCode === null) {
    await once(child, "exit");
  }
  const { exitCode: code, signalCode: signal } = child;
  if (code !== 0) {
    throw new Error(
      `${label} child failed code=${String(code)} signal=${String(signal)}\nstdout:\n${output.stdout}\nstderr:\n${output.stderr}`,
    );
  }
}

describe("session accessor cross-process concurrency", () => {
  beforeAll(async () => {
    await getConcurrencyWorker();
  }, WORKER_BOOT_TIMEOUT_MS + 5_000);

  afterAll(async () => {
    const child = concurrencyWorker;
    concurrencyWorker = undefined;
    if (!child) {
      return;
    }
    if (child.exitCode === null && child.signalCode === null) {
      child.send({ kind: "shutdown" });
    }
    await waitForChild(child, "concurrency worker shutdown");
  });

  it("observes a child that exited before the waiter attached", async () => {
    const child = spawn(process.execPath, ["--eval", ""], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", () => resolve());
    });

    await waitForChild(child, "already exited");
  });

  it("commits after same-session activity from another process", async () => {
    const { storePath, scope } = await fixture("existing-session");
    const initialUpdatedAt = loadSessionEntry({ ...scope, readConsistency: "latest" })?.updatedAt;
    assert.ok(typeof initialUpdatedAt === "number", "initial session timestamp was not persisted");
    const activeTurnUpdatedAt = initialUpdatedAt + 20;
    const preparedUpdatedAt = initialUpdatedAt + 30;

    const result = await runConcurrencyScenario(
      { kind: "reply-init", preparedUpdatedAt, storePath },
      async (snapshot) => {
        expect(snapshot.revision).toBe(JSON.stringify({ sessionId: "existing-session" }));
        await updateSessionEntry(scope, () => ({ updatedAt: activeTurnUpdatedAt }), {
          skipMaintenance: true,
        });
      },
    );
    const expected = {
      sessionId: "existing-session",
      updatedAt: preparedUpdatedAt,
    };
    expect(result).toMatchObject({ ok: true, sessionEntry: expected });
    expect(loadSessionEntry({ ...scope, readConsistency: "latest" })).toMatchObject(expected);
  }, 15_000);

  it.each(["read-then-replace", "replace-twice"] as const)(
    "rejects %s after another process commits an append",
    async (rewriteMode) => {
      const sessionId = `cross-process-${rewriteMode}`;
      const { tempDir, storePath, scope } = await fixture(sessionId);
      const twice = rewriteMode === "replace-twice";
      const initial = twice
        ? transcriptEvents(sessionId, "first-replacement", "first replacement")
        : transcriptEvents(sessionId);
      if (!twice) {
        await replaceTranscriptEvents(scope, initial);
      }
      const appended = twice ? { id: "concurrent-append", parentId: "first-replacement" } : {};
      const content = twice ? "concurrent append" : "committed concurrent append";
      const result = await runConcurrencyScenario(
        { kind: "transcript-rewrite", rewriteMode, sessionId, storePath },
        async (ready) => {
          expect(ready).toEqual({ eventCount: 2 });
          await appendTranscriptMessage(scope, {
            cwd: tempDir,
            ...(twice ? { eventId: appended.id, parentId: appended.parentId } : {}),
            message: { role: "user", content, ...(!twice ? { timestamp: Date.now() } : {}) },
          });
        },
      );
      expect(result).toMatchObject({
        ok: false,
        name: "SqliteTranscriptMutationConflictError",
        message: `SQLite transcript changed while preparing rewrite for ${sessionId}`,
      });
      await expect(loadTranscriptEvents(scope)).resolves.toEqual([
        ...initial,
        expect.objectContaining({
          type: "message",
          ...appended,
          message: expect.objectContaining({ role: "user", content }),
        }),
      ]);
    },
    15_000,
  );

  it("refreshes a read snapshot after an append in the same locked callback", async () => {
    const sessionId = "rewrite-after-own-append";
    const { tempDir, scope } = await fixture(sessionId);
    await replaceTranscriptEvents(scope, transcriptEvents(sessionId));

    await withTranscriptWriteLock(scope, async (transcript) => {
      await transcript.readEvents();
      await transcript.appendMessage({
        cwd: tempDir,
        eventId: "owned-append",
        message: { role: "user", content: "owned append" },
        parentId: "rewrite-target",
      });
      const currentEvents = await loadTranscriptEvents(scope);
      const rewrittenEvents = currentEvents.map((event) =>
        event &&
        typeof event === "object" &&
        !Array.isArray(event) &&
        "id" in event &&
        event.id === "rewrite-target"
          ? Object.assign({}, event, {
              message: { role: "assistant", content: "rewritten content" },
            })
          : event,
      );
      await transcript.replaceEvents(rewrittenEvents);
    });

    await expect(loadTranscriptEvents(scope)).resolves.toEqual([
      ...transcriptEvents(sessionId, "rewrite-target", "rewritten content"),
      expect.objectContaining({
        type: "message",
        id: "owned-append",
        parentId: "rewrite-target",
        message: { role: "user", content: "owned append" },
      }),
    ]);
  });
});
