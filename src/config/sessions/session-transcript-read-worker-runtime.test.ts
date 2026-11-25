import { WorkerTaskError } from "@openclaw/worker-runtime";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ContextPreparationTimeoutError } from "../../agents/failover/local-preparation-error.js";
import { WorkerTaskPool } from "../../infra/worker-task-pool.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db-cache.js";
import { readSessionTranscriptModelContextInWorker } from "./session-transcript-read-worker-runtime.js";

const run = vi.fn();

const target = {
  agentId: "main",
  sessionId: "context-budget",
  sessionKey: "agent:main:context-budget",
  storePath: "/synthetic/agents/main/sessions/sessions.json",
};

beforeEach(() => {
  run.mockReset();
  vi.spyOn(WorkerTaskPool.prototype, "run").mockImplementation((prepare, options) =>
    run(typeof prepare === "function" ? prepare() : prepare, options),
  );
});
afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
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
