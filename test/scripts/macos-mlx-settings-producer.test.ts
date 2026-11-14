import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runMlxSettingsProducer } from "../../scripts/lib/macos-mlx-settings-producer.mts";
import { waitForManagedProcessGroupExit } from "../../scripts/lib/managed-child-process.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const cwd = path.resolve(import.meta.dirname, "../..");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const child = `
const token = process.env.OPENCLAW_MLX_SETTINGS_PRODUCER_TOKEN;
const notify = (kind, value = token) => new Promise((resolve, reject) => {
  process.send({kind, token: value}, error => error ? reject(error) : resolve());
});
const start = () => new Promise((resolve, reject) => {
  process.once('message', message => {
    if (message.kind !== 'go' || message.token !== token) process.exit(19);
    resolve();
  });
  void notify('ready').catch(reject);
});
const finish = async () => { await notify('complete'); process.disconnect(); };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
`;

function run(
  body: string,
  options: {
    bootstrapTimeoutMs?: number;
    operationTimeoutMs?: number;
    remainingMs?: (ceiling: number) => number;
  } = {},
) {
  const observation: Record<string, unknown> = {};
  const result = runMlxSettingsProducer({
    cwd,
    env: process.env,
    args: ["--input-type=module", "--eval", child + body],
    observation,
    bootstrapTimeoutMs: 5_000,
    operationTimeoutMs: 1_000,
    remainingMs: (ceiling) => ceiling,
    ...options,
  });
  return { result, observation };
}

async function expectRetired(observation: Record<string, unknown>) {
  expect(observation.processesRetired).toBe(true);
  expect(typeof observation.leaderPid).toBe("number");
  expect(
    await waitForManagedProcessGroupExit({ pid: observation.leaderPid as number }, 1_000, {
      errorPolicy: "indeterminate",
    }),
  ).toBe(true);
}

describe.skipIf(process.platform === "win32")("MLX settings producer deadline ownership", () => {
  it("admits cold startup longer than the separate operation deadline", async () => {
    const f = run("await delay(1_100); await start(); await delay(20); await finish();");
    await expect(f.result).resolves.toBe(0);
    expect(f.observation.bootstrapElapsedMs).toBeGreaterThan(1_000);
    expect(f.observation).toMatchObject({
      bootstrapReady: true,
      operationAllocatedMs: 1_000,
      operationSignaledComplete: true,
      exitCode: 0,
    });
    await expectRetired(f.observation);
  });

  it("externally retires synchronous bootstrap work without admitting the operation", async () => {
    const f = run("while (true) {}", { bootstrapTimeoutMs: 500 });
    await expect(f.result).rejects.toThrow("bootstrap timed out");
    expect(f.observation).toMatchObject({ bootstrapReady: false, timeoutPhase: "bootstrap" });
    expect(f.observation.operationAllocatedMs).toBeUndefined();
    await expectRetired(f.observation);
  });

  it("externally retires synchronous operation work after readiness", async () => {
    const f = run("await start(); while (true) {}", { operationTimeoutMs: 500 });
    await expect(f.result).rejects.toThrow("operation timed out");
    expect(f.observation).toMatchObject({
      bootstrapReady: true,
      operationSignaledComplete: false,
      timeoutPhase: "operation",
    });
    await expectRetired(f.observation);
  });

  it("does not admit a READY sent during bootstrap cancellation", async () => {
    const workFile = path.join(tempDirs.make("mlx-producer-late-ready-"), "work");
    const readyFile = `${workFile}.ready`;
    const f = run(
      `process.on('message', () => import('node:fs').then(fs => fs.writeFileSync(${JSON.stringify(workFile)}, 'work')));
process.on('SIGTERM', async () => {
  await notify('ready');
  (await import('node:fs')).writeFileSync(${JSON.stringify(readyFile)}, 'sent');
  await delay(100); process.exit(0);
});
await delay(10_000);`,
      { bootstrapTimeoutMs: 500 },
    );
    await expect(f.result).rejects.toThrow("bootstrap timed out");
    expect(f.observation.bootstrapReady).toBe(false);
    expect(fs.readFileSync(readyFile, "utf8")).toBe("sent");
    expect(fs.existsSync(workFile)).toBe(false);
    await expectRetired(f.observation);
  });

  it.each([
    ["missing readiness", "process.exit(0);", "without completing"],
    ["early operation exit", "await start(); process.exit(0);", "without completing"],
    ["wrong token", "await notify('ready', 'other'); await delay(10_000);", "Invalid"],
    [
      "duplicate readiness",
      "const admitted = start(); await notify('ready'); await admitted; await delay(10_000);",
      "Unexpected or duplicate",
    ],
    ["completion before readiness", "await notify('complete'); await delay(10_000);", "Unexpected"],
  ])("rejects %s and joins its child", async (_name, body, message) => {
    const f = run(body);
    await expect(f.result).rejects.toThrow(message);
    await expectRetired(f.observation);
  });

  it("does not reset the supplied shrinking deadline after readiness", async () => {
    const end = performance.now() + 1_000;
    const f = run("await start(); await delay(10_000);", {
      operationTimeoutMs: 5_000,
      remainingMs: (ceiling) => Math.min(ceiling, Math.floor(end - performance.now())),
    });
    await expect(f.result).rejects.toThrow("operation timed out");
    expect(f.observation.operationAllocatedMs).toBeLessThan(1_000);
    expect(f.observation.bootstrapReady).toBe(true);
    await expectRetired(f.observation);
  });

  it("keeps the operation deadline after completion until the process tree retires", async () => {
    const pidFile = path.join(tempDirs.make("mlx-producer-retirement-"), "descendant.pid");
    const f = run(
      `await start();
const { spawn } = await import('node:child_process');
const fs = await import('node:fs');
const descendant = spawn(process.execPath, ['--eval', 'setInterval(() => {}, 1000)'], {
  stdio: ['ignore', 'inherit', 'inherit'],
});
fs.writeFileSync(${JSON.stringify(pidFile)}, String(descendant.pid));
await finish();
await delay(10_000);`,
      { operationTimeoutMs: 500 },
    );
    await expect(f.result).rejects.toThrow("operation timed out");
    expect(f.observation).toMatchObject({
      operationSignaledComplete: true,
      timeoutPhase: "operation",
    });
    await expectRetired(f.observation);
    const descendantPid = Number(fs.readFileSync(pidFile, "utf8"));
    expect(Number.isSafeInteger(descendantPid)).toBe(true);
    expect(() => process.kill(descendantPid, 0)).toThrow();
  });

  it("does not send GO when operation admission has no remaining budget", async () => {
    const workFile = path.join(tempDirs.make("mlx-producer-admission-"), "work");
    const f = run(
      `await start(); (await import('node:fs')).writeFileSync(${JSON.stringify(workFile)}, 'work'); await finish();`,
      { remainingMs: (ceiling) => (ceiling === 1_000 ? 0 : ceiling) },
    );
    await expect(f.result).rejects.toThrow("no admitted phase budget");
    expect(f.observation.bootstrapReady).toBe(true);
    expect(f.observation.operationAllocatedMs).toBeUndefined();
    expect(fs.existsSync(workFile)).toBe(false);
    await expectRetired(f.observation);
  });

  it("preserves a producer's nonzero exit after admission", async () => {
    const f = run("await start(); process.exit(41);");
    await expect(f.result).resolves.toBe(41);
    expect(f.observation.operationSignaledComplete).toBe(false);
    await expectRetired(f.observation);
  });
});
