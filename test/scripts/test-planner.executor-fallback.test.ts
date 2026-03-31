import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createExecutionArtifacts, executePlan } from "../../scripts/test-planner/executor.mjs";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("test planner executor", () => {
  it("falls back to child exit when close never arrives", async () => {
    vi.useRealTimers();
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
    const artifacts = createExecutionArtifacts({ OPENCLAW_TEST_CLOSE_GRACE_MS: "10" });
    const executePromise = executePlan(
      {
        failurePolicy: "fail-fast",
        passthroughMetadataOnly: true,
        passthroughOptionArgs: [],
        runtimeCapabilities: { isWindowsCi: false, isCI: false, isWindows: false },
      },
      {
        env: { OPENCLAW_TEST_CLOSE_GRACE_MS: "10" },
        artifacts,
        spawn: spawnMock,
      },
    );

    await expect(executePromise).resolves.toMatchObject({
      exitCode: 0,
      summary: {
        failedRunCount: 0,
      },
    });
    expect(spawnMock).toHaveBeenCalledTimes(1);

    artifacts.cleanupTempArtifacts();
  });

  it("collects failures across planned units when failure policy is collect-all", async () => {
    vi.useRealTimers();
    const children = [1, 2].map((pid, index) => {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      return Object.assign(new EventEmitter(), {
        stdout,
        stderr,
        pid,
        kill: vi.fn(),
        index,
      });
    });
    let childIndex = 0;
    const spawnMock = vi.fn(() => {
      const child = children[childIndex];
      childIndex += 1;
      setTimeout(() => {
        child.stdout.write(
          child.index === 0
            ? " ❯ src/alpha.test.ts (1 test | 1 failed)\n"
            : " ❯ src/beta.test.ts (1 test | 1 failed)\n",
        );
        child.emit("exit", 1, null);
        child.emit("close", 1, null);
      }, 0);
      return child;
    });
    const artifacts = createExecutionArtifacts({});
    const report = await executePlan(
      {
        failurePolicy: "collect-all",
        passthroughMetadataOnly: false,
        passthroughOptionArgs: [],
        targetedUnits: [],
        parallelUnits: [
          { id: "unit-a", args: ["vitest", "run", "src/alpha.test.ts"] },
          { id: "unit-b", args: ["vitest", "run", "src/beta.test.ts"] },
        ],
        serialUnits: [],
        serialPrefixUnits: [],
        shardCount: 1,
        shardIndexOverride: null,
        topLevelSingleShardAssignments: new Map(),
        runtimeCapabilities: { isWindowsCi: false, isCI: false, isWindows: false },
        topLevelParallelEnabled: false,
        topLevelParallelLimit: 1,
        deferredRunConcurrency: 1,
        passthroughRequiresSingleRun: false,
      },
      {
        env: {},
        artifacts,
        spawn: spawnMock,
      },
    );

    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(report.exitCode).toBe(1);
    expect(report.summary.failedRunCount).toBe(2);
    expect(report.summary.failedTestFileCount).toBe(2);
    expect(report.results.map((result) => result.classification)).toEqual([
      "test-failure",
      "test-failure",
    ]);

    artifacts.cleanupTempArtifacts();
  });

  it("injects a valid localstorage file path into child NODE_OPTIONS", async () => {
    vi.useRealTimers();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const fakeChild = Object.assign(new EventEmitter(), {
      stdout,
      stderr,
      pid: 123,
      kill: vi.fn(),
    });
    let capturedEnv;
    const spawnMock = vi.fn((_command, _args, options) => {
      capturedEnv = options?.env;
      setTimeout(() => {
        fakeChild.emit("exit", 0, null);
        fakeChild.emit("close", 0, null);
      }, 0);
      return fakeChild;
    });
    const artifacts = createExecutionArtifacts({
      NODE_OPTIONS: "--max_old_space_size=4096 --localstorage-file",
    });
    await expect(
      executePlan(
        {
          failurePolicy: "fail-fast",
          passthroughMetadataOnly: false,
          passthroughOptionArgs: [],
          targetedUnits: [],
          parallelUnits: [{ id: "unit-a", args: ["vitest", "run", "src/alpha.test.ts"] }],
          serialUnits: [],
          serialPrefixUnits: [],
          shardCount: 1,
          shardIndexOverride: null,
          topLevelSingleShardAssignments: new Map(),
          runtimeCapabilities: { isWindowsCi: false, isCI: false, isWindows: false },
          topLevelParallelEnabled: false,
          topLevelParallelLimit: 1,
          deferredRunConcurrency: 1,
          passthroughRequiresSingleRun: false,
        },
        {
          env: {
            NODE_OPTIONS: "--max_old_space_size=4096 --localstorage-file",
          },
          artifacts,
          spawn: spawnMock,
        },
      ),
    ).resolves.toMatchObject({
      exitCode: 0,
    });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(capturedEnv?.NODE_OPTIONS).toContain("--max_old_space_size=4096");
    expect(capturedEnv?.NODE_OPTIONS).toMatch(
      /--localstorage-file=[^\s]+\.localstorage\.json(?:\s|$)/u,
    );
    expect(capturedEnv?.NODE_OPTIONS).not.toMatch(/(^|\s)--localstorage-file(?=\s|$)/u);

    artifacts.cleanupTempArtifacts();
  });
});
