import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { getUpdateRunAsync } from "../infra/update-run-reader.js";
import { createUpdateRunAsync, recordUpdateRunStepAsync } from "../infra/update-run-write.async.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { VERSION } from "../version.js";
import { settleRunFromTrial } from "./gateway-trial.js";
import { readTrial, resolvePrefix, writeTrial, type Trial } from "./store.js";

const notices = vi.hoisted(() => [] as Array<{ runId: string; kind: string; status: string }>);
vi.mock("../gateway/update-run-notice.runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../gateway/update-run-notice.runtime.js")>()),
  createUpdateRunNotifier:
    async () => async (run: { runId: string; status: string }, kind: string) => {
      notices.push({ runId: run.runId, kind, status: run.status });
      return { delivered: true, owned: true };
    },
}));

const directories: string[] = [];
afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
  notices.length = 0;
  for (const dir of directories.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

it.each(["succeeded", "rolled-back"] as const)(
  "durably finishes a %s trial and marks its outcome reported",
  async (status) => {
    const state = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-trial-"));
    directories.push(state);
    vi.stubEnv("OPENCLAW_STATE_DIR", state);
    const options = { env: process.env };
    openOpenClawStateDatabase(options);
    const run = await createUpdateRunAsync({ trigger: "cli" }, options);
    const trial: Trial = {
      v: 2,
      runId: run.runId,
      phase: status === "succeeded" ? "committed" : "rolled-back",
      target: "releases/new/openclaw",
      previous: "releases/old/openclaw",
      version: VERSION,
      attempts: 1,
      createdAt: Date.now(),
      outcome: {
        status,
        reason: status === "rolled-back" ? "new build failed to start" : undefined,
        stderrTail:
          status === "rolled-back"
            ? "failed with token sk-abcdefghijklmnopqrstuvwxyz123456"
            : undefined,
        at: Date.now(),
      },
    };
    await writeTrial(trial);
    await settleRunFromTrial(trial);
    const finished = await getUpdateRunAsync(run.runId, options);
    expect(finished).toMatchObject({
      status: status === "succeeded" ? "succeeded" : "failed",
      phase: "finished",
    });
    if (status === "succeeded") {
      expect(finished).toMatchObject({
        after: { version: VERSION },
        verification: { runningVersion: VERSION, booted: true },
      });
    } else {
      expect(finished?.reason).toBe("new build failed to start");
      expect(finished?.steps.find((step) => step.step === "outcome")?.detail).not.toContain(
        "sk-abcdefghijklmnopqrstuvwxyz123456",
      );
      expect(finished?.steps.find((step) => step.step === "outcome")?.detail).toContain(
        "failed with token",
      );
    }
    expect(await readTrial(resolvePrefix())).toMatchObject({ reported: true });
    await settleRunFromTrial((await readTrial())!);
    expect((await getUpdateRunAsync(run.runId, options))?.finishedAtMs).toBe(
      finished?.finishedAtMs,
    );
  },
);

it.each([true, false])(
  "sends the outcome to a requester that received the start notice (acknowledged=%s)",
  async (acknowledged) => {
    const state = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-trial-"));
    directories.push(state);
    vi.stubEnv("OPENCLAW_STATE_DIR", state);
    const options = { env: process.env };
    openOpenClawStateDatabase(options);
    const run = await createUpdateRunAsync(
      { trigger: "chat", origin: { sessionKey: "agent:main:telegram:dm:1" } },
      options,
    );
    if (acknowledged) {
      await recordUpdateRunStepAsync(
        run.runId,
        { step: "notice:ack", status: "completed", endedAtMs: Date.now() },
        options,
      );
    }
    await settleRunFromTrial({
      v: 2,
      runId: run.runId,
      phase: "rolled-back",
      target: "releases/new/openclaw",
      previous: "releases/old/openclaw",
      version: VERSION,
      attempts: 2,
      createdAt: Date.now(),
      outcome: { status: "rolled-back", reason: "new build failed to start", at: Date.now() },
    });
    expect(notices).toEqual(
      acknowledged ? [{ runId: run.runId, kind: "finished", status: "failed" }] : [],
    );
  },
);
