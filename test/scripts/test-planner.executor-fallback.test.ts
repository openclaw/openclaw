import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { importFreshModule } from "../helpers/import-fresh.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("test planner executor", () => {
  it("falls back to child exit when close never arrives", async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const fakeChild = Object.assign(new EventEmitter(), {
      stdout,
      stderr,
      pid: 12345,
      kill: vi.fn(),
    });
    const spawnMock = vi.fn(() => {
      setTimeout(() => {
        fakeChild.emit("exit", 0, null);
      }, 0);
      return fakeChild;
    });
    vi.doMock("node:child_process", () => ({
      spawn: spawnMock,
    }));

    const { executePlan, createExecutionArtifacts } = await importFreshModule<
      typeof import("../../scripts/test-planner/executor.mjs")
    >(import.meta.url, "../../scripts/test-planner/executor.mjs?scope=exit-fallback");
    const artifacts = createExecutionArtifacts({ OPENCLAW_TEST_CLOSE_GRACE_MS: "10" });
    const executePromise = executePlan(
      {
        passthroughMetadataOnly: true,
        passthroughOptionArgs: [],
        runtimeCapabilities: { isWindowsCi: false, isCI: false, isWindows: false },
      },
      {
        env: { OPENCLAW_TEST_CLOSE_GRACE_MS: "10" },
        artifacts,
      },
    );

    await expect(executePromise).resolves.toBe(0);
    expect(spawnMock).toHaveBeenCalledTimes(1);

    artifacts.cleanupTempArtifacts();
  });
});
