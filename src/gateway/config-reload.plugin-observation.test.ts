import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/config.js";
import { PluginRuntimeApplicationError } from "../plugins/lifecycle.js";
import { withPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import {
  closeTestConfigReloaders,
  createReloaderHarness,
  flushReload,
  makeSnapshot,
  makeZeroDebounceHookWrite,
  prepareConfigReloadTest,
} from "./config-reload.test-support.js";

vi.mock("../config/io.audit.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/io.audit.js")>()),
  appendConfigAuditRecord: vi.fn(),
}));
vi.mock("../config/config-journal-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config-journal-snapshot.js")>()),
  readLatestConfigSnapshotAuditRecordAsync: vi.fn(async () => null),
  upsertConfigSnapshotAuditRecordAsync: vi.fn(),
}));

beforeEach((context) => {
  prepareConfigReloadTest(context);
  vi.useFakeTimers();
});
afterEach(async () => {
  await closeTestConfigReloaders();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const runtime = { operationId: "manual", generation: 1, pluginIds: ["notes"] };
const failure = () =>
  new PluginRuntimeApplicationError("candidate activation failed", {
    ...runtime,
    phase: "activate",
    committed: false,
  });

it.each(["none", "file-before", "file-during", "write-during"] as const)(
  "retains only real config work after a failed manual reload: %s",
  async (event) => {
    const config: OpenClawConfig = {};
    const write = makeZeroDebounceHookWrite("next");
    let snapshot = makeSnapshot({ config, hash: "initial" });
    const entered = createDeferred();
    const release = createDeferred();
    const error = failure();
    let reject = false;
    const harness = createReloaderHarness(async () => snapshot, {
      initialConfig: config,
      onHotReload: async (plan) => {
        if (plan.pluginLifecycle && reject) {
          entered.resolve();
          await release.promise;
          throw error;
        }
        return plan.pluginLifecycle ? { status: "applied", runtime } : "applied";
      },
    });
    await harness.reloader.ready;
    const reload = (sourceConfig = config) =>
      withPluginLifecycleLease({}, () =>
        harness.reloader.applyPluginLifecycleChange({
          config: sourceConfig,
          pluginIds: ["notes"],
          reason: "reload",
        }),
      );
    await expect(reload()).resolves.toEqual(runtime);
    harness.onConfigAccepted.mockClear();
    if (event === "file-before") {
      snapshot = write.snapshot;
      harness.watcher.emit("change");
    }
    reject = true;
    const result = reload(snapshot.sourceConfig).catch((caught: unknown) => caught);
    try {
      await entered.promise;
      if (event === "file-during" || event === "write-during") {
        snapshot = write.snapshot;
        if (event === "write-during") {
          harness.emitWrite(write);
        } else {
          harness.watcher.emit("change");
        }
        await vi.advanceTimersByTimeAsync(0);
      }
      release.resolve();
      expect(await result).toBe(error);
      await flushReload(harness.reloader);
      expect(harness.onConfigAccepted).toHaveBeenCalledTimes(event === "none" ? 0 : 1);
      if (event !== "none") {
        expect(harness.onConfigAccepted.mock.calls[0]?.[2]).toEqual(write.sourceConfig);
      }
      // A later genuine observation remains admissible after either outcome.
      harness.onConfigAccepted.mockClear();
      harness.watcher.emit("change");
      await flushReload(harness.reloader);
      expect(harness.onConfigAccepted).toHaveBeenCalledOnce();
    } finally {
      release.resolve();
      await result;
    }
  },
);

it.each(["resolve", "reject"] as const)(
  "discards a late initial source read after manual failure: %s",
  async (outcome) => {
    const initialRead = createDeferred<ConfigFileSnapshot>();
    const config: OpenClawConfig = {};
    const snapshot = makeSnapshot({ config, hash: "same" });
    const readSnapshot = vi
      .fn<() => Promise<ConfigFileSnapshot>>()
      .mockImplementationOnce(() => initialRead.promise)
      .mockResolvedValue(snapshot);
    const error = failure();
    const harness = createReloaderHarness(readSnapshot, {
      initialConfig: config,
      onHotReload: async () => {
        throw error;
      },
    });
    await harness.reloader.ready;
    harness.watcher.emit("ready");
    await expect(
      withPluginLifecycleLease({}, () =>
        harness.reloader.applyPluginLifecycleChange({
          config,
          pluginIds: ["notes"],
          reason: "reload",
        }),
      ),
    ).rejects.toBe(error);
    if (outcome === "reject") {
      initialRead.reject(new Error("old read failed"));
    } else {
      initialRead.resolve(makeSnapshot({ exists: false, valid: false }));
    }
    await flushReload(harness.reloader);
    expect(readSnapshot).toHaveBeenCalledTimes(2);
    expect(harness.onConfigAccepted).not.toHaveBeenCalled();
  },
);
