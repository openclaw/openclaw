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

it("releases a failed claim so an in-flight sibling executes on retry", async () => {
  const effectOnce = createIngressEffectOnce(EFFECT_ONCE_PARAMS);
  const failure = new Error("write failed");
  const gate = createDeferred<string>();
  const firstRun = vi.fn(() => gate.promise);
  const retryRun = vi.fn(async () => "retried");
  const params = { eventId: "event-2", effect: "config-write" };
  const first = effectOnce.runOnce({ ...params, run: firstRun });
  await vi.waitFor(() => expect(firstRun).toHaveBeenCalledOnce());
  const retry = effectOnce.runOnce({ ...params, run: retryRun });
  await Promise.resolve();
  gate.reject(failure);

  await expect(first).rejects.toBe(failure);
  await expect(retry).resolves.toEqual({ kind: "executed", value: "retried" });
  expect(retryRun).toHaveBeenCalledOnce();
});

it("settles concurrent same-key claims once and replays later calls", async () => {
  const effectOnce = createIngressEffectOnce(EFFECT_ONCE_PARAMS);
  const gate = createDeferred();
  const run = vi.fn(async () => {
    await gate.promise;
    return "cleared";
  });

  const params = { eventId: "event-3", effect: "storage-clear", run };
  const first = effectOnce.runOnce(params);
  await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
  const second = effectOnce.runOnce(params);
  gate.resolve();

  await expect(first).resolves.toEqual({ kind: "executed", value: "cleared" });
  await expect(second).resolves.toEqual({ kind: "replayed" });
  await expect(effectOnce.runOnce(params)).resolves.toEqual({ kind: "replayed" });
  expect(run).toHaveBeenCalledOnce();
});

it("rejects before executing when durable state cannot be read", async () => {
  await breakStateDirectory();
  const onDiskError = vi.fn();
  const run = vi.fn(async () => "unsafe");
  const effectOnce = createIngressEffectOnce({ ...EFFECT_ONCE_PARAMS, onDiskError });

  await expect(
    effectOnce.runOnce({ eventId: "event-read-error", effect: "config-write", run }),
  ).rejects.toThrow("Failed to open the plugin state database");
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
  const effectOnce = createIngressEffectOnce({ ...EFFECT_ONCE_PARAMS, onDiskError });

  const params = { eventId: "event-write-error", effect: "visible-ack" };
  const first = effectOnce.runOnce({ ...params, run });
  await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
  const waiter = effectOnce.runOnce({ ...params, run: waiterRun });
  const outcomes = Promise.all([
    expect(first).rejects.toThrow("Failed to open the plugin state database"),
    expect(waiter).rejects.toThrow("Failed to open the plugin state database"),
  ]);
  gate.resolve();
  await outcomes;
  expect(onDiskError).toHaveBeenCalledOnce();
  expect(run).toHaveBeenCalledOnce();
  expect(waiterRun).not.toHaveBeenCalled();
});
