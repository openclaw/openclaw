import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../helpers/promise.ts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.ts";
import { testRunnerFixtureEnv } from "./prepared-script-wrapper.test-support.js";

const lifecycle = vi.hoisted(() => ({
  prepare: vi.fn(),
  prepareE2e: vi.fn(),
  prepareWorkers: vi.fn(),
  dispose: vi.fn(),
  spawn: vi.fn(),
  reports: vi.fn(),
  timings: vi.fn(),
}));
vi.mock("../../scripts/lib/vitest-build-prerequisites.mts", async (original) => ({
  ...(await original<typeof import("../../scripts/lib/vitest-build-prerequisites.mts")>()),
  prepareVitestRuntime: lifecycle.prepare,
  prepareE2eVitestRuntime: lifecycle.prepareE2e,
}));
vi.mock("../../scripts/lib/vitest-runtime-selection.mts", async (original) => ({
  ...(await original<typeof import("../../scripts/lib/vitest-runtime-selection.mts")>()),
  shouldPrepareVitestCoreWorkers: () => true,
}));
vi.mock("../../scripts/lib/vitest-worker-run.mts", async (original) => ({
  ...(await original<typeof import("../../scripts/lib/vitest-worker-run.mts")>()),
  createVitestWorkerRun: () => ({
    descriptor: { directory: "/fixture/workers" },
    prepare: lifecycle.prepareWorkers,
    borrow: (_child: unknown, completion: Promise<unknown>) => completion,
    dispose: lifecycle.dispose,
  }),
}));
vi.mock("../../scripts/lib/vitest-process.mts", async (original) => ({
  ...(await original<typeof import("../../scripts/lib/vitest-process.mts")>()),
  spawnOwnedVitestProcess: lifecycle.spawn,
}));
vi.mock("../../scripts/lib/vitest-report-owner.mts", async (original) => ({
  ...(await original<typeof import("../../scripts/lib/vitest-report-owner.mts")>()),
  createVitestReportOwner: lifecycle.reports,
}));
vi.mock("../../scripts/lib/vitest-shard-timings.mts", async (original) => ({
  ...(await original<typeof import("../../scripts/lib/vitest-shard-timings.mts")>()),
  readShardTimings: () => new Map(),
  writeShardTimings: lifecycle.timings,
}));

const { runVitest } = await import("../../scripts/run-vitest.mts");
const { runVitestCli } = await import("../../scripts/lib/vitest-process.mts");
const target = "test/scripts/run-vitest.test.ts";
const environment = testRunnerFixtureEnv({
  OPENCLAW_TEST_PROJECTS_SERIAL: "1",
  OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS: "0",
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let originalExitCode: typeof process.exitCode;
let outcome: { code: number | null; signal: NodeJS.Signals | null; groupJoined: boolean };

beforeEach(() => {
  originalExitCode = process.exitCode;
  process.exitCode = 0;
  outcome = { code: 1, signal: null, groupJoined: true };
  lifecycle.prepare.mockReset().mockResolvedValue(0);
  lifecycle.prepareE2e.mockReset().mockResolvedValue({ OPENCLAW_E2E_USE_PREBUILT_DIST: "1" });
  lifecycle.prepareWorkers.mockReset().mockResolvedValue(undefined);
  lifecycle.dispose.mockReset().mockResolvedValue(undefined);
  lifecycle.reports.mockReset().mockResolvedValue(null);
  lifecycle.timings.mockReset();
  lifecycle.spawn.mockReset().mockImplementation(() => ({
    child: new EventEmitter(),
    completion: Promise.resolve(outcome),
  }));
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  process.exitCode = originalExitCode ?? 0;
  vi.restoreAllMocks();
});

it("settles a single E2E runtime before shared assets and readers", async () => {
  const started = createDeferred();
  const prepared = createDeferred<NodeJS.ProcessEnv>();
  lifecycle.prepareE2e.mockImplementation(() => {
    started.resolve();
    return prepared.promise;
  });
  const running = runVitestCli("test", (exit) =>
    runVitest(
      exit,
      [
        "run",
        "--config",
        "test/vitest/vitest.e2e.config.ts",
        "test/e2e/line-doctor-group-allowlist.built-cli.e2e.test.ts",
      ],
      environment,
    ),
  );
  try {
    await Promise.race([started.promise, running]);
    expect(lifecycle.prepareE2e).toHaveBeenCalledOnce();
    expect(lifecycle.prepare).not.toHaveBeenCalled();
    expect(lifecycle.spawn).not.toHaveBeenCalled();
  } finally {
    prepared.resolve({ OPENCLAW_E2E_USE_PREBUILT_DIST: "1" });
    await running;
  }
  expect(lifecycle.prepare).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ OPENCLAW_E2E_USE_PREBUILT_DIST: "1" }),
  );
  expect(lifecycle.prepare).toHaveBeenCalledOnce();
  expect(lifecycle.spawn).toHaveBeenCalledOnce();
});

// Both public dispatch paths must reserve assertion exit 1 for a settled runner.
// The process/worker mocks inject infrastructure failures, not assertion results.
describe.each(["direct", "delegated"])("Vitest %s terminal classification", (entry) => {
  const args =
    entry === "direct"
      ? ["run", "--config", "test/vitest/vitest.tooling.config.ts", target]
      : [target];
  const run = () => runVitestCli("test", (exit) => runVitest(exit, args, environment));

  it.each([
    ["clean assertion", 1],
    ["success", 0],
    ["assertion and disposal", 2],
    ["success and disposal", 2],
    ["preparation exit 1", 2],
    ["preparation rejection", 2],
    ["worker preparation", 2],
    ["child join", 2],
    ["missing child outcome", 2],
  ] as const)("reports %s as exit %s", async (failure, expected) => {
    if (failure.startsWith("success")) {
      outcome.code = 0;
    }
    if (failure.endsWith("disposal")) {
      lifecycle.dispose.mockRejectedValue(new Error("dispose failed"));
    }
    if (failure === "preparation exit 1") {
      lifecycle.prepare.mockResolvedValue(1);
    }
    if (failure === "preparation rejection") {
      lifecycle.prepare.mockRejectedValue(new Error("prepare failed"));
    }
    if (failure === "worker preparation") {
      lifecycle.prepareWorkers.mockRejectedValue(new Error("compiler failed"));
    }
    if (failure === "child join") {
      lifecycle.spawn.mockImplementation(() => ({
        child: new EventEmitter(),
        completion: Promise.reject(new Error("join failed")),
      }));
    }
    if (failure === "missing child outcome") {
      outcome.code = null;
    }
    await run();
    expect(process.exitCode).toBe(expected);
    if (failure.startsWith("preparation") || failure === "worker preparation") {
      expect(lifecycle.spawn).not.toHaveBeenCalled();
    }
  });

  it.each([7, 143])("retains native exit %s when disposal fails", async (code) => {
    outcome.code = code;
    lifecycle.dispose.mockRejectedValue(new Error("dispose failed"));
    await run();
    expect(process.exitCode).toBe(code);
  });

  it.each([false, true])(
    "joins disposal before interruption (disposal failure=%s)",
    async (fails) => {
      const disposing = createDeferred();
      const release = createDeferred();
      lifecycle.dispose.mockImplementation(() => {
        disposing.resolve();
        return release.promise.then(() => {
          if (fails) {
            throw new Error("dispose failed");
          }
        });
      });
      outcome.signal = "SIGTERM";
      outcome.code = null;
      const exit = vi.fn(async () => {});
      let settled = false;
      const running = runVitest(exit, args, environment).finally(() => {
        settled = true;
      });
      try {
        await Promise.race([disposing.promise, running]);
        expect(lifecycle.dispose).toHaveBeenCalled();
        expect(settled).toBe(false);
        expect(exit).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        await running;
      }
      expect(exit).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    },
  );

  if (entry === "delegated") {
    it.each(
      [1, 7, 143].flatMap((code) =>
        ["failure code", "rejection", "attempt rejection"].map((failure) => ({ code, failure })),
      ),
    )("preserves exit $code through publication $failure", async ({ code, failure }) => {
      outcome.code = code;
      lifecycle.reports.mockResolvedValue({
        attempt: (_index: number, attemptArgs: string[]) => ({
          args: attemptArgs,
          complete() {
            if (failure === "attempt rejection") {
              throw new Error("attempt publication failed");
            }
          },
          fail() {},
        }),
        finish:
          failure === "rejection"
            ? async () => {
                throw new Error("publication failed");
              }
            : async () => 2,
      });
      await run();
      expect(process.exitCode).toBe(code === 1 ? 2 : code);
    });

    it("does not hide a later infrastructure exit behind the first assertion failure", async () => {
      lifecycle.spawn.mockImplementationOnce(() => ({
        child: new EventEmitter(),
        completion: Promise.resolve(outcome),
      }));
      lifecycle.spawn.mockImplementation(() => ({
        child: new EventEmitter(),
        completion: Promise.resolve({ ...outcome, code: 2 }),
      }));
      await runVitestCli("test", (exit) =>
        runVitest(
          exit,
          ["test/vitest/vitest.unit-fast.config.ts", "test/vitest/vitest.cli.config.ts"],
          { ...environment, OPENCLAW_TEST_PROJECTS_PARALLEL: "2" },
        ),
      );
      expect(lifecycle.spawn).toHaveBeenCalledTimes(2);
      expect(process.exitCode).toBe(2);
    });
  }
});

describe("delegated numeric admission and first-native precedence", () => {
  const configs = [
    "test/vitest/vitest.unit-fast.config.ts",
    "test/vitest/vitest.unit-fast-fake-timers.config.ts",
    "test/vitest/vitest.cli.config.ts",
  ];

  it.each([1, 2])("serial continueOnFailure admits only assertion red (exit %s)", async (code) => {
    const planner = await import("../../scripts/test-projects.test-support.mts");
    vi.spyOn(planner, "buildFullSuiteVitestRunPlans").mockReturnValue(
      configs.map((config) => ({
        config,
        forwardedArgs: [],
        timingTargets: [],
        includePatterns: null,
        watchMode: false,
      })),
    );
    outcome.code = code;
    const { runTestProjects } = await import("../../scripts/test-projects-run.mts");
    await runVitestCli("test", (exit) =>
      runTestProjects(exit, [], {
        ...environment,
        OPENCLAW_TEST_PROJECTS_PARALLEL: "1",
      }),
    );
    expect(lifecycle.spawn).toHaveBeenCalledTimes(code === 1 ? 3 : 1);
    expect(process.exitCode).toBe(code);
  });

  it.each([
    [2, 7, 7],
    [7, 2, 7],
    [7, 143, 7],
    [143, 7, 143],
  ] as const)(
    "joins active peers and keeps first native status: %s then %s -> %s",
    async (firstCode, secondCode, expected) => {
      const first = createDeferred<typeof outcome>();
      const second = createDeferred<typeof outcome>();
      const admitted = createDeferred();
      lifecycle.spawn.mockImplementation(() => {
        const index = lifecycle.spawn.mock.calls.length;
        if (index === 2) {
          admitted.resolve();
        }
        return {
          child: new EventEmitter(),
          completion:
            index === 1 ? first.promise : index === 2 ? second.promise : Promise.resolve(outcome),
        };
      });
      let settled = false;
      const running = runVitestCli("test", (exit) =>
        runVitest(exit, configs, {
          ...environment,
          OPENCLAW_TEST_PROJECTS_PARALLEL: "2",
        }),
      ).finally(() => {
        settled = true;
      });
      try {
        await Promise.race([admitted.promise, running]);
        expect(lifecycle.spawn).toHaveBeenCalledTimes(2);
        first.resolve({ ...outcome, code: firstCode });
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(lifecycle.spawn).toHaveBeenCalledTimes(2);
        expect(settled).toBe(false);
      } finally {
        first.resolve({ ...outcome, code: firstCode });
        second.resolve({ ...outcome, code: secondCode });
        await running;
      }
      expect(lifecycle.spawn).toHaveBeenCalledTimes(2);
      expect(process.exitCode).toBe(expected);
    },
  );
});

describe("native Bun terminal classification", () => {
  beforeEach(() => {
    // Mocked child completions do not own the Vitest worker's live IPC channel.
    if (process.channel) {
      vi.spyOn(process.channel, "unref").mockImplementation(() => {});
    }
  });

  it.each([
    [0, 0],
    [1, 1],
    [null, 2],
  ] as const)(
    "preserves completed exit %s and classifies missing completion as %s",
    async (code, expected) => {
      outcome.code = code;
      await runVitestCli("test", (exit) =>
        runVitest(exit, ["--native-bun", `./${target}`], environment),
      );
      expect(lifecycle.spawn).toHaveBeenCalledOnce();
      expect(process.exitCode).toBe(expected);
    },
  );
});

describe("batch terminal classification", () => {
  it.each([0, 1, 7, 143])("classifies disposal after batch exit %s", async (code) => {
    const { runVitestBatch } = await import("../../scripts/lib/vitest-batch-runner.mts");
    outcome.code = code;
    lifecycle.dispose.mockRejectedValue(new Error("batch dispose failed"));
    const complete = vi.fn();
    const result = await runVitestBatch({
      config: "test/vitest/vitest.tooling.config.ts",
      args: [],
      targets: [target],
      env: environment,
      onComplete: complete,
    });
    expect(result).toBe(code <= 1 ? 2 : code);
    expect(complete).toHaveBeenCalledExactlyOnceWith({ code: result, signal: null });
  });

  it.each([1, 7, 143])("preserves batch exit %s through publication failure", async (code) => {
    const { runExtensionBatchPlan } = await import("../../scripts/test-extension-batch-run.mts");
    lifecycle.reports.mockResolvedValue({
      attempt: (_index: number, args: string[]) => ({ args, complete() {}, fail() {} }),
      finish: async () => 2,
    });
    const result = await runExtensionBatchPlan(
      {
        extensionCount: 2,
        extensionIds: ["alpha", "beta"],
        estimatedCost: 2,
        hasTests: true,
        testFileCount: 2,
        noTestExtensionIds: [],
        planGroups: ["alpha", "beta"].map((name) => ({
          config: `${name}.config.ts`,
          estimatedCost: 1,
          extensionIds: [name],
          roots: [target],
          testFileCount: 1,
        })),
      },
      { env: environment, runGroup: async () => code },
    );
    expect(result).toBe(code === 1 ? 2 : code);
  });
});

const parallelConfigs = [
  "test/vitest/vitest.unit-fast.config.ts",
  "test/vitest/vitest.unit-fast-fake-timers.config.ts",
  "test/vitest/vitest.cli.config.ts",
];
const threeGroupPlan = {
  extensionCount: 3,
  extensionIds: ["alpha", "beta", "gamma"],
  estimatedCost: 3,
  hasTests: true,
  testFileCount: 3,
  noTestExtensionIds: [],
  planGroups: ["alpha", "beta", "gamma"].map((name, index) => ({
    config: `${name}.config.ts`,
    estimatedCost: 3 - index,
    extensionIds: [name],
    roots: [target],
    testFileCount: 1,
  })),
};

describe.each(["delegated", "batch"])("%s scheduler exception outcomes", (entry) => {
  it.each([7, 143].flatMap((code) => [true, false].map((nativeFirst) => ({ code, nativeFirst }))))(
    "retains native $code across peer rejection (native first=$nativeFirst)",
    async ({ code, nativeFirst }) => {
      const first = createDeferred<typeof outcome>();
      const second = createDeferred<typeof outcome>();
      const admitted = createDeferred();
      let calls = 0;
      const next = () => {
        calls++;
        if (calls === 2) {
          admitted.resolve();
        }
        return calls === 1
          ? first.promise
          : calls === 2
            ? second.promise
            : Promise.resolve(outcome);
      };
      lifecycle.spawn.mockImplementation(() => ({ child: new EventEmitter(), completion: next() }));
      const { runExtensionBatchPlan } = await import("../../scripts/test-extension-batch-run.mts");
      let settled = false;
      const running = runVitestCli("test", async (exit) => {
        if (entry === "delegated") {
          await runVitest(exit, parallelConfigs, {
            ...environment,
            OPENCLAW_TEST_PROJECTS_PARALLEL: "2",
          });
        } else {
          process.exitCode = await runExtensionBatchPlan(threeGroupPlan, {
            env: { ...environment, OPENCLAW_EXTENSION_BATCH_PARALLEL: "2" },
            runGroup: async () => (await next()).code!,
          });
        }
      }).finally(() => {
        settled = true;
      });
      try {
        await Promise.race([admitted.promise, running]);
        expect(calls).toBe(2);
        if (nativeFirst) {
          first.resolve({ ...outcome, code });
        } else {
          first.reject(new Error("owned peer completion failure"));
        }
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(calls).toBe(2);
        expect(settled).toBe(false);
      } finally {
        first.resolve({ ...outcome, code });
        if (nativeFirst) {
          second.reject(new Error("owned peer completion failure"));
        } else {
          second.resolve({ ...outcome, code });
        }
        await running;
      }
      expect(calls).toBe(2);
      expect(process.exitCode).toBe(code);
    },
  );
});

it.each([7, 143])("retains native %s when shard timing publication throws", async (code) => {
  outcome.code = code;
  lifecycle.timings.mockImplementation(() => {
    throw new Error("owned timing write failure");
  });
  await runVitestCli("test", (exit) =>
    runVitest(exit, parallelConfigs, {
      ...environment,
      OPENCLAW_TEST_PROJECTS_PARALLEL: "2",
    }),
  );
  expect(lifecycle.timings).toHaveBeenCalledOnce();
  expect(process.exitCode).toBe(code);
});

it.each(["mkdir", "index save"])(
  "stops batch admission and joins peers after attempt %s fails",
  async (fault) => {
    const root = tempDirs.make("oc-report-attempt-");
    const original = await vi.importActual<
      typeof import("../../scripts/lib/vitest-report-owner.mts")
    >("../../scripts/lib/vitest-report-owner.mts");
    lifecycle.reports.mockImplementation(original.createVitestReportOwner);
    const failed = createDeferred();
    const peer = createDeferred<number>();
    const runGroup = vi.fn(() => peer.promise);
    let injected = false;
    let indexFile = "";
    const fail = () => {
      injected = true;
      failed.resolve();
      throw new Error("owned report attempt allocation failure");
    };
    const mkdir = fs.mkdirSync;
    vi.spyOn(fs, "mkdirSync").mockImplementation((directory, options) => {
      const name = String(directory);
      if (
        !injected &&
        fault === "mkdir" &&
        name.startsWith(root) &&
        name.endsWith(path.join("2", "1"))
      ) {
        fail();
      }
      return mkdir(directory, options);
    });
    const write = fs.writeFileSync;
    vi.spyOn(fs, "writeFileSync").mockImplementation((file, data, options) => {
      if (String(file).startsWith(root) && path.basename(String(file)) === "index.json") {
        indexFile = String(file);
        if (typeof data !== "string") {
          throw new Error("Expected report index JSON text");
        }
        const index = JSON.parse(data);
        if (!injected && fault === "index save" && index.entries[1].state === "started") {
          fail();
        }
      }
      return write(file, data, options);
    });
    const { runExtensionBatchPlan } = await import("../../scripts/test-extension-batch-run.mts");
    let settled = false;
    const running = runVitestCli("test", async () => {
      process.exitCode = await runExtensionBatchPlan(threeGroupPlan, {
        env: { ...environment, OPENCLAW_EXTENSION_BATCH_PARALLEL: "2" },
        runGroup,
        vitestArgs: ["--reporter=json", `--outputFile=${path.join(root, "result.json")}`],
      });
    }).finally(() => {
      settled = true;
    });
    try {
      await Promise.race([failed.promise, running]);
      expect(injected).toBe(true);
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(runGroup).toHaveBeenCalledOnce();
      expect(settled).toBe(false);
    } finally {
      peer.resolve(0);
      await running;
    }
    expect(runGroup).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(2);
    const index = JSON.parse(fs.readFileSync(indexFile, "utf8"));
    expect(index.complete).toBe(false);
    expect(index.entries[0].attempts[0].outcome.code).toBe(0);
    expect(index.entries[2].state).toBe("unstarted");
  },
);
