import { mkdirSync, rmSync } from "node:fs";
import fs from "node:fs/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resetPluginStateStoreForTests } from "../plugin-state/plugin-state-store.js";
import { createIngressEffectOnce } from "./ingress-effect-once.js";

const EFFECT_ONCE_PARAMS = {
  pluginId: "test-ingress-effect-once",
  namespacePrefix: "test.ingress-effect-once",
  ttlMs: 60_000,
  stateMaxEntries: 100,
};
function createRunner(onDiskError?: (error: unknown) => void) {
  const guard = createIngressEffectOnce({ ...EFFECT_ONCE_PARAMS, onDiskError });
  return <T>(run: () => Promise<T>) => guard.runOnce({ eventId: "event", effect: "write", run });
}
const diskError = "Failed to open the plugin state database";

const tempDirs = createTempDirTracker();
let stateDir: string;

beforeEach(() => {
  resetPluginStateStoreForTests();
  stateDir = tempDirs.make("openclaw-ingress-effect-once-");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
});

afterEach(() => {
  resetPluginStateStoreForTests();
  vi.unstubAllEnvs();
  tempDirs.cleanup();
});

async function breakStateDirectory() {
  resetPluginStateStoreForTests();
  await fs.rm(stateDir, { recursive: true, force: true });
  await fs.writeFile(stateDir, "not a directory");
}

it.each([false, true])(
  "settles same-key claims and retries only effect failures (fails=%s)",
  async (fails) => {
    const runOnce = createRunner();
    const failure = new Error("write failed");
    const gate = createDeferred<string>();
    const firstRun = vi.fn(() => gate.promise);
    const retryRun = vi.fn(async () => "retried");
    const first = runOnce(firstRun);
    await vi.waitFor(() => expect(firstRun).toHaveBeenCalledOnce());
    const retry = runOnce(retryRun);
    await Promise.resolve();
    if (fails) {
      gate.reject(failure);
      await expect(first).rejects.toBe(failure);
      await expect(retry).resolves.toEqual({ kind: "executed", value: "retried" });
    } else {
      gate.resolve("cleared");
      await expect(first).resolves.toEqual({ kind: "executed", value: "cleared" });
      await expect(retry).resolves.toEqual({ kind: "replayed" });
      await expect(runOnce(retryRun)).resolves.toEqual({ kind: "replayed" });
    }
    expect(firstRun).toHaveBeenCalledOnce();
    expect(retryRun).toHaveBeenCalledTimes(fails ? 1 : 0);
  },
);

it("rejects before executing when durable state cannot be read", async () => {
  await breakStateDirectory();
  const onDiskError = vi.fn();
  const run = vi.fn(async () => "unsafe");
  await expect(createRunner(onDiskError)(run)).rejects.toThrow(diskError);
  expect(onDiskError).toHaveBeenCalledOnce();
  expect(run).not.toHaveBeenCalled();
});

it.each([false, true])("rejects a durable commit and its waiter (repair=%s)", async (repair) => {
  let repairedStateDir = false;
  const onDiskError = vi.fn(() => {
    if (!repair || repairedStateDir) {
      return;
    }
    repairedStateDir = true;
    rmSync(stateDir, { recursive: true, force: true });
    mkdirSync(stateDir, { recursive: true });
  });
  const gate = createDeferred();
  const run = vi.fn(async () => {
    await gate.promise;
    await breakStateDirectory();
    return "already-visible";
  });
  const waiterRun = vi.fn(async () => "unsafe-retry");
  const runOnce = createRunner(onDiskError);
  const first = runOnce(run);
  await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
  const waiter = runOnce(waiterRun);
  const outcomes = Promise.all([
    expect(first).rejects.toThrow(diskError),
    expect(waiter).rejects.toThrow(diskError),
  ]);
  gate.resolve();
  await outcomes;
  expect(onDiskError).toHaveBeenCalledOnce();
  expect(run).toHaveBeenCalledOnce();
  expect(waiterRun).not.toHaveBeenCalled();
});
