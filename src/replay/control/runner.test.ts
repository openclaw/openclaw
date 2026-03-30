import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ReplayControlError } from "./errors.js";
import { createReplayRun, stepReplayRun, toReplayRunStateResponse } from "./runner.js";

async function expectReplayControlError(
  fn: () => Promise<unknown>,
  expected: { code: string; status: number },
) {
  await expect(fn()).rejects.toMatchObject(expected);
}

const cleanupDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

async function writeTrajectoryFixture(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-replay-runner-"));
  cleanupDirs.push(dir);
  const fixturePath = path.join(
    process.cwd(),
    "src",
    "research",
    "contracts",
    "__fixtures__",
    "trajectory",
    "v1",
    "small.json",
  );
  const raw = await fs.readFile(fixturePath, "utf8");
  const outPath = path.join(dir, "trajectory.v1.json");
  await fs.writeFile(outPath, raw, "utf8");
  return outPath;
}

describe("replay runner", () => {
  it("maps missing trajectory file to not_found", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-replay-runner-"));
    cleanupDirs.push(dir);
    const missing = path.join(dir, "nope.json");
    await expectReplayControlError(
      () =>
        createReplayRun({
          runId: "run-missing",
          request: { trajectoryPath: missing, mode: "recorded" },
        }),
      { code: "not_found", status: 404 },
    );
  });

  it("maps invalid trajectory JSON to invalid_request", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-replay-runner-"));
    cleanupDirs.push(dir);
    const badPath = path.join(dir, "bad.json");
    await fs.writeFile(badPath, "{ not json", "utf8");
    await expectReplayControlError(
      () =>
        createReplayRun({
          runId: "run-bad-json",
          request: { trajectoryPath: badPath, mode: "recorded" },
        }),
      { code: "invalid_request", status: 400 },
    );
  });

  it("replays deterministic step sequence from trajectory", async () => {
    const trajectoryPath = await writeTrajectoryFixture();
    const run = await createReplayRun({
      runId: "run-1",
      request: { trajectoryPath, mode: "recorded" },
      nowMs: 1700000000000,
    });

    const step = stepReplayRun({ run, nowMs: 1700000000100 });
    expect(step.runId).toBe("run-1");
    expect(step.stepIdx).toBe(0);
    expect(step.done).toBe(true);
    expect(step.status).toBe("completed");
    expect(step.replayedToolCalls).toHaveLength(1);
    expect(step.replayedToolCalls[0]).toMatchObject({
      toolCallId: "call-1",
      toolName: "exec",
      ok: true,
    });

    const state = toReplayRunStateResponse(run);
    expect(state.status).toBe("completed");
    expect(state.stepIdx).toBe(1);
    expect(state.totalSteps).toBe(1);
  });

  it("fails when allowlist excludes replayed tool", async () => {
    const trajectoryPath = await writeTrajectoryFixture();
    const run = await createReplayRun({
      runId: "run-2",
      request: { trajectoryPath, mode: "recorded", toolAllowlist: ["memory_search"] },
    });
    expect(() => stepReplayRun({ run })).toThrowError(ReplayControlError);
    expect(() => stepReplayRun({ run })).toThrow(/allowlisted/);
  });

  it("enforces maxToolCalls across the whole run", async () => {
    const trajectoryPath = await writeTrajectoryFixture();
    const run = await createReplayRun({
      runId: "run-3",
      request: { trajectoryPath, mode: "recorded", maxToolCalls: 0 },
    });
    expect(() => stepReplayRun({ run })).toThrowError(ReplayControlError);
    expect(() => stepReplayRun({ run })).toThrow(/Max tool calls exceeded/);
  });

  it("enforces timeoutMs across replay step execution", async () => {
    const trajectoryPath = await writeTrajectoryFixture();
    const run = await createReplayRun({
      runId: "run-4",
      request: { trajectoryPath, mode: "recorded", timeoutMs: 1 },
      nowMs: 1000,
    });
    expect(() => stepReplayRun({ run, nowMs: 1002 })).toThrowError(ReplayControlError);
    expect(() => stepReplayRun({ run, nowMs: 1002 })).toThrow(/Replay timeout exceeded/);
  });

  it("treats explicit empty toolAllowlist as deny-all (tri-state)", async () => {
    const trajectoryPath = await writeTrajectoryFixture();
    const run = await createReplayRun({
      runId: "run-empty-allow",
      request: { trajectoryPath, mode: "recorded", toolAllowlist: [] },
    });
    expect(run.toolAllowlist.size).toBe(0);
    expect(() => stepReplayRun({ run })).toThrowError(ReplayControlError);
    expect(() => stepReplayRun({ run })).toThrow(/allowlisted in replay/);
  });
});
