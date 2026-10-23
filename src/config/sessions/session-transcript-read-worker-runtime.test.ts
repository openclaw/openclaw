import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkerTaskError } from "@openclaw/worker-runtime";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ContextPreparationTimeoutError } from "../../agents/failover/local-preparation-error.js";
import { WorkerTaskPool } from "../../infra/worker-task-pool.js";
import type { WorkerTaskOptions } from "../../infra/worker-task-pool.types.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db-cache.js";
import {
  readSessionTranscriptModelContextInWorker,
  withSessionEntrySourceInWorker,
} from "./session-transcript-read-worker-runtime.js";
import type { SessionEntryWorkerInput } from "./session-transcript-worker-read.types.js";

const run = vi.fn();
let sourcePath: string | undefined;
let tempRoot: string;

const target = {
  agentId: "main",
  sessionId: "context-budget",
  sessionKey: "agent:main:context-budget",
  storePath: "/synthetic/agents/main/sessions/sessions.json",
};

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "session-export-root-"));
  vi.stubEnv("TMPDIR", tempRoot);
  run.mockReset();
  vi.spyOn(WorkerTaskPool.prototype, "run").mockImplementation((prepare, options) =>
    run(typeof prepare === "function" ? prepare() : prepare, options),
  );
});
afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  if (sourcePath) {
    await fs.rm(path.dirname(sourcePath), { recursive: true, force: true });
    sourcePath = undefined;
  }
  await fs.rm(tempRoot, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it("gives cold context reads three minutes while preserving caller cancellation", async () => {
  const context = { events: [] };
  run.mockResolvedValue({ ok: true, value: context });
  const controller = new AbortController();
  await expect(
    readSessionTranscriptModelContextInWorker(target, undefined, controller.signal),
  ).resolves.toBe(context);
  expect(run).toHaveBeenCalledWith(expect.objectContaining({ kind: "model-context", target }), {
    timeoutMs: 180_000,
    signal: controller.signal,
  });
  controller.abort();
  await expect(
    readSessionTranscriptModelContextInWorker(target, undefined, controller.signal),
  ).rejects.toBe(controller.signal.reason);
  expect(run).toHaveBeenCalledOnce();
});

it("preserves the worker timeout cause and identifies local context preparation", async () => {
  const cause = new WorkerTaskError("worker task timed out", "timeout");
  run.mockRejectedValue(cause);
  const failure = await readSessionTranscriptModelContextInWorker(target, undefined).catch(
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(ContextPreparationTimeoutError);
  expect(failure).toMatchObject({ code: "timeout", cause });
});

it("preserves unrelated worker failures", async () => {
  const failure = new WorkerTaskError("worker task closed", "unavailable");
  run.mockRejectedValue(failure);
  await expect(readSessionTranscriptModelContextInWorker(target, undefined)).rejects.toBe(failure);
});

async function stageSource(options: WorkerTaskOptions<SessionEntryWorkerInput>) {
  const controller = new AbortController();
  const response = await options.onRequest!(
    { kind: "session-entry-source" },
    { signal: controller.signal, yieldSignal: controller.signal },
  );
  const input = response.input;
  if (
    !input ||
    typeof input !== "object" ||
    !("filePath" in input) ||
    typeof input.filePath !== "string"
  ) {
    throw new Error("expected prepared export destination");
  }
  sourcePath = input.filePath;
  // Independent wire fixture includes multiline imported JSON and multibyte content.
  const payload = Buffer.from(
    JSON.stringify({ type: "message", message: { role: "user", content: "🦞" } }, null, 2),
  );
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length);
  await fs.writeFile(sourcePath, Buffer.concat([header, payload]), { mode: 0o600 });
  return {
    ok: true,
    value: {
      preparedSource: {
        snapshot: {
          stats: { maxSeq: 1, eventCount: 1, sizeBytes: payload.length },
          sessionKey: target.sessionKey,
        },
        resetRecallCutoff: { state: "absent" },
      },
    },
  };
}

it.each([
  { fail: false, cleanupFail: false },
  { fail: true, cleanupFail: false },
  { fail: false, cleanupFail: true },
  { fail: true, cleanupFail: true },
])(
  "settles source custody and errors (consumer=$fail, cleanup=$cleanupFail)",
  async ({ fail, cleanupFail }) => {
    let nativeSettled = false;
    run.mockImplementation(async (_input, options: WorkerTaskOptions<SessionEntryWorkerInput>) => {
      const reply = await stageSource(options);
      options.onExecutionSettled!({ retired: false });
      nativeSettled = true;
      return reply;
    });
    const failure = new Error("observer failed");
    const cleanupError = new Error("source cleanup failed");
    if (cleanupFail) {
      vi.spyOn(fs, "rm").mockRejectedValueOnce(cleanupError);
    }
    const result = withSessionEntrySourceInWorker(target.sessionKey, target, async (source) => {
      expect(nativeSettled).toBe(true);
      expect(sourcePath).toBeDefined();
      expect(path.dirname(path.dirname(sourcePath!))).toBe(tempRoot);
      expect(source).toBeDefined();
      expect([...source!.records]).toEqual([
        { type: "message", message: { role: "user", content: "🦞" } },
      ]);
      await fs.access(sourcePath!);
      if (fail) {
        throw failure;
      }
      return null;
    });
    if (fail && cleanupFail) {
      await expect(result).rejects.toMatchObject({ errors: [failure, cleanupError] });
    } else if (fail || cleanupFail) {
      await expect(result).rejects.toBe(fail ? failure : cleanupError);
    } else {
      await expect(result).resolves.toBeNull();
    }
    if (cleanupFail) {
      await fs.access(sourcePath!);
    } else {
      await expect(fs.access(path.dirname(sourcePath!))).rejects.toMatchObject({ code: "ENOENT" });
    }
  },
);

it("retains an abandoned export after failed retirement until the native settlement receipt", async () => {
  let settle: (() => void) | undefined;
  const failure = new Error("native retirement failed");
  run.mockImplementation(async (_input, options: WorkerTaskOptions<SessionEntryWorkerInput>) => {
    await stageSource(options);
    settle = () => options.onExecutionSettled!({ retired: true });
    throw failure;
  });
  const consume = vi.fn();
  await expect(withSessionEntrySourceInWorker(target.sessionKey, target, consume)).rejects.toBe(
    failure,
  );
  expect(consume).not.toHaveBeenCalled();
  await fs.access(sourcePath!);
  settle!();
  await vi.waitFor(async () => {
    await expect(fs.access(path.dirname(sourcePath!))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
