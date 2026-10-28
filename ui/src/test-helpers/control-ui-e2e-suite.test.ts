// Exercise the harness through native Vitest forks, including its real hook ordering.
import type { ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it, type TestContext } from "vitest";
import type { JsonTestResults } from "vitest/node";
import { hasErrnoCode } from "../../../src/infra/errno.ts";
import { runVitestShutdownCommand } from "../../../test/helpers/vitest-shutdown-command.ts";
import { fixtureSource, type FixtureMode } from "./control-ui-e2e-suite.fixture.test-support.ts";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, "../../..");

const healthyFixtureModes: [FixtureMode, ...FixtureMode[]] = [
  "page-concurrent",
  "held-route-drain",
  "concurrent-close",
  "late-context",
  "tracked-close-success",
  "scenario-root-drain",
  "resources-root-drain",
  "scenario-timeout",
  "resources-success",
];

type FixtureJournal = {
  closeCalls: number;
  arrived: boolean;
  published: boolean;
  browserAcquired: boolean;
  browserClosed: boolean;
  serverAcquired: boolean;
  serverClosed: boolean;
  events: string[];
  nativeAbortObserved: boolean;
  firstCleanupEvent: string;
  pendingCloseCalls: number;
  fulfilledBeforeFetchRelease: string[];
  heldBodyErrorRetained: boolean;
  contextCleanupEvent: string;
  callbackOutcomes: { label: string; status: string; disposed: boolean }[];
};

let fixtureRoot: string;
let hasUnjoinedFixture = false;
const readJson = async <T>(file: string): Promise<T> => JSON.parse(await fs.readFile(file, "utf8"));

beforeAll(async () => {
  // openclaw-temp-dir: allow retain native-fork state if process-tree shutdown fails.
  fixtureRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ui-lifetime-forks-")));
  await fs.symlink(
    path.join(repoRoot, "node_modules"),
    path.join(fixtureRoot, "node_modules"),
    "junction",
  );
  await fs.writeFile(
    path.join(fixtureRoot, "vitest.config.ts"),
    `
import { defineConfig } from "vitest/config";
import { createVitestResolveConfig } from ${JSON.stringify(path.join(repoRoot, "test/vitest/vitest.resolve.ts"))};
if (process.versions.bun) {
  await import(${JSON.stringify(path.join(repoRoot, "test/vitest/vitest.sqlite-preload.mts"))});
}
const hookTimeout = Number(process.env.UI_LIFETIME_HOOK_TIMEOUT_MS);
export default defineConfig({
  cacheDir: ${JSON.stringify(path.join(fixtureRoot, ".vite"))},
  resolve: createVitestResolveConfig(${JSON.stringify(repoRoot)}),
  test: { pool: "forks", isolate: true, maxWorkers: 1, fileParallelism: false,
    fsModuleCache: true,
    fsModuleCachePath: ${JSON.stringify(path.join(fixtureRoot, "transforms"))},
    testTimeout: 1000, hookTimeout,
    provide: {
      controlUiE2eChromium: { available: true, executablePath: "/synthetic/chromium", wsEndpoint: "ws://synthetic/chromium" },
      controlUiE2eCleanup: { timeoutMs: hookTimeout, pool: "forks", isolate: true },
    },
  },
});
`,
  );
});

afterAll(async () => {
  if (!hasUnjoinedFixture) {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  }
});

async function startNativeFixtures(modes: [FixtureMode, ...FixtureMode[]], signal: AbortSignal) {
  const invocationRoot = path.join(fixtureRoot, modes.length === 1 ? modes[0] : "healthy-run");
  const files: string[] = [];
  for (const mode of modes) {
    const root = path.join(fixtureRoot, mode);
    await fs.mkdir(path.join(root, "home"), { recursive: true });
    await fs.mkdir(path.join(root, "tmp"));
    const file = path.join(root, "fixture.test.ts");
    await fs.writeFile(file, fixtureSource(mode, root));
    files.push(file);
  }
  await fs.mkdir(path.join(invocationRoot, "home"), { recursive: true });
  await fs.mkdir(path.join(invocationRoot, "tmp"), { recursive: true });
  const hookTimeout = modes.some((mode) => mode === "late-setup" || mode === "resources-late-setup")
    ? 50
    : 500;
  const report = path.join(invocationRoot, "report.json");
  let child!: ChildProcess;
  const output = await runVitestShutdownCommand({
    args: [
      path.join(path.dirname(require.resolve("vitest/package.json")), "vitest.mjs"),
      "run",
      ...files,
      "--root",
      fixtureRoot,
      "--config",
      path.join(fixtureRoot, "vitest.config.ts"),
      "--configLoader",
      "runner",
      "--reporter=verbose",
      "--reporter=json",
      `--outputFile=${report}`,
    ],
    cwd: repoRoot,
    signal,
    timeoutMs: 90_000,
    maxBytes: 4 * 1024 * 1024,
    env: {
      PATH: process.env.PATH,
      UI_LIFETIME_HOOK_TIMEOUT_MS: String(hookTimeout),
      HOME: path.join(invocationRoot, "home"),
      USERPROFILE: path.join(invocationRoot, "home"),
      OPENCLAW_HOME: path.join(invocationRoot, "home"),
      OPENCLAW_STATE_DIR: path.join(invocationRoot, "home/.openclaw"),
      OPENCLAW_CONFIG_PATH: path.join(invocationRoot, "home/.openclaw/openclaw.json"),
      OPENCLAW_UI_E2E_DIAGNOSTIC_DIR: path.join(invocationRoot, "diagnostics"),
      TMPDIR: path.join(invocationRoot, "tmp"),
      TMP: path.join(invocationRoot, "tmp"),
      TEMP: path.join(invocationRoot, "tmp"),
      CI: "1",
      NO_COLOR: "1",
    },
    onReady(owned) {
      child = owned;
    },
  });
  expect(child.signalCode, `${output.stdout}\n${output.stderr}`).toBeNull();
  expect(child.killed).toBe(false);
  const nativeReport = await readJson<JsonTestResults>(report);
  expect(nativeReport.testResults, `${output.stdout}\n${output.stderr}`).toHaveLength(modes.length);
  return { child, output, nativeReport };
}

let healthyRun: ReturnType<typeof startNativeFixtures> | undefined;

async function runFixture(mode: FixtureMode, signal: AbortSignal) {
  if (hasUnjoinedFixture) {
    throw new Error("Cannot reuse transforms while a native UI fixture remains unjoined");
  }
  const root = path.join(fixtureRoot, mode);
  let completed = false;
  try {
    // Healthy files share CLI setup, but each still gets a native isolated fork.
    // Poisoned-fork cases retain their own invocation and teardown boundary.
    const { child, output, nativeReport } = await (healthyFixtureModes.includes(mode)
      ? (healthyRun ??= startNativeFixtures(healthyFixtureModes, signal))
      : startNativeFixtures([mode], signal));
    const pid = Number(await fs.readFile(path.join(root, "worker.pid"), "utf8"));
    expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
    let workerStopped = false;
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (!hasErrnoCode(error, "ESRCH")) {
        throw error;
      }
      workerStopped = true;
    }
    expect(workerStopped, "native fixture worker must be joined before removing its files").toBe(
      true,
    );
    completed = true;
    const fileReport = nativeReport.testResults.find(
      (result) => path.resolve(result.name) === path.join(root, "fixture.test.ts"),
    );
    if (!fileReport) {
      throw new Error(`Missing native fixture report: ${mode}`);
    }
    let retainedExists = false;
    if (mode === "resources-browser-failure") {
      await expect(fs.stat(path.join(root, "retained-root.txt"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } else if (mode.startsWith("scenario-") || mode.startsWith("resources-")) {
      const retainedRoot = await fs.readFile(path.join(root, "retained-root.txt"), "utf8");
      expect(path.relative(root, retainedRoot).startsWith("..")).toBe(false);
      retainedExists = await fs.stat(retainedRoot).then(
        () => true,
        () => false,
      );
    }
    type Capture = {
      public: {
        hostBeforeRead: { pageClosed: boolean };
        rendererRead: string;
        gatewayRpc: Array<{ method: string; outcome: string }>;
      };
      private: { failure: { message: string } };
    };
    const captures: Capture[] = [];
    if (mode.startsWith("diagnostic-")) {
      for (const entry of await fs.readdir(path.join(root, "diagnostics"))) {
        captures.push({
          public: await readJson<Capture["public"]>(
            path.join(root, "diagnostics", entry, "failure.public.json"),
          ),
          private: await readJson<Capture["private"]>(
            path.join(root, "diagnostics", entry, "failure.private.json"),
          ),
        });
      }
    }
    return {
      captures,
      code: child.exitCode,
      output: `${output.stdout}\n${output.stderr}`,
      report: {
        success: fileReport.status === "passed",
        numPassedTests: fileReport.assertionResults.filter((test) => test.status === "passed")
          .length,
        numFailedTests: fileReport.assertionResults.filter((test) => test.status === "failed")
          .length,
      },
      journal: await readJson<FixtureJournal>(path.join(root, "journal.json")),
      retainedExists,
      successorStarted: await fs.stat(path.join(root, "successor.txt")).then(
        () => true,
        () => false,
      ),
    };
  } finally {
    if (completed) {
      await fs.rm(root, { recursive: true, force: true });
    } else {
      hasUnjoinedFixture = true;
      console.warn(`Retained unjoined native UI fixture: ${root}`);
    }
  }
}

function runJoinedFixture(
  mode: FixtureMode,
  context: TestContext,
  check: (result: Awaited<ReturnType<typeof runFixture>>) => void,
) {
  // Register before the body starts: native timeout does not join its callback.
  const run = Promise.resolve().then(() => {
    context.signal.throwIfAborted();
    return runFixture(mode, context.signal).then(check);
  });
  context.onTestFinished(() => run);
  return run;
}

type FixtureResult = Awaited<ReturnType<typeof runFixture>>;

function expectTestCounts(result: FixtureResult, passed: number, failed: number) {
  expect(result.report, result.output).toMatchObject({
    numPassedTests: passed,
    numFailedTests: failed,
  });
}

function expectClosed(result: FixtureResult, closeCalls: number, closed = true) {
  expect(result.journal).toMatchObject({
    closeCalls,
    browserClosed: closed,
    serverClosed: closed,
  });
}

it.for(["page-concurrent", "page-concurrent-timeout"] as const)(
  "owns every concurrent page callback: %s",
  (mode, context) =>
    runJoinedFixture(mode, context, (result) => {
      const timedOut = mode === "page-concurrent-timeout";
      expect(result.code, result.output).toBe(timedOut ? 1 : 0);
      expect(result.journal.closeCalls).toBe(2);
      if (timedOut) {
        expect(result.output).toContain("Test timed out in 50ms");
        expect(result.output).toContain("retiring owned fork");
        expect(result.successorStarted).toBe(false);
      } else {
        expectTestCounts(result, 1, 0);
      }
    }),
);

it.for([
  "diagnostic-page-timeout",
  "diagnostic-tracked-timeout",
  "diagnostic-scenario-timeout",
] as const)("captures a native timeout before its context closes: %s", (mode, context) =>
  runJoinedFixture(mode, context, (result) => {
    expect(result.code, result.output).toBe(1);
    expectTestCounts(result, 1, 1);
    expect(result.output).toContain("Test timed out in 50ms");
    expect(result.successorStarted).toBe(true);
    expect(result.journal.events).toEqual(["capture live page", "drain", "close", "successor"]);
    expect(result.captures).toHaveLength(1);
    expect(result.captures[0]?.public).toMatchObject({
      hostBeforeRead: { pageClosed: false },
      rendererRead: "completed",
    });
    expect(result.captures[0]?.public.gatewayRpc).toEqual(
      [
        "agents.files.get",
        "chat.history",
        "chat.startup",
        "sessions.list",
        "sessions.subscribe",
        "sessions.unsubscribe",
        "sessions.messages.subscribe",
        "sessions.messages.unsubscribe",
      ].flatMap((method) => [
        { method, outcome: "sent" },
        { method, outcome: "ok" },
        { method, outcome: "sent" },
        { method, outcome: "error" },
      ]),
    );
    expect(JSON.stringify(result.captures[0]?.public)).not.toContain("private-");
    expect(result.captures[0]?.private.failure.message).toContain("Test timed out in 50ms");
    expectClosed(result, 1);
  }),
);

it("drains held modules and cancels unrequested observations during cleanup", (context) =>
  runJoinedFixture("held-route-drain", context, (result) => {
    expect(result.code, result.output).toBe(0);
    expectTestCounts(result, 2, 0);
    expect(result.journal.callbackOutcomes).toEqual(
      ["first", "other", "later", "context", "late"].map((label) => ({
        label,
        status: "fulfilled",
        disposed: false,
      })),
    );
    expect(result.journal.events).toContain("fulfilled later");
    expect(result.journal.events).toContain("fell through late");
    expect(result.journal.events).not.toContain("fetched late");
    for (const event of ["drain", "close"]) {
      expect(result.journal.events.indexOf("fulfilled later")).toBeLessThan(
        result.journal.events.indexOf(event),
      );
    }
    expect(result.journal.events).toContain("held request settled");
    expect(result.journal.events.at(-1)).toBe("held callback joined");
    expect(result.journal).toMatchObject({
      firstCleanupEvent: "drain",
      contextCleanupEvent: "drain",
      pendingCloseCalls: 0,
      fulfilledBeforeFetchRelease: ["fulfilled first", "fulfilled other"],
      heldBodyErrorRetained: true,
    });
    expectClosed(result, 2);
  }));

it("reports settled held route failures through context cleanup", (context) =>
  runJoinedFixture("held-route-failure", context, (result) => {
    expect(result.code, result.output).toBe(1);
    expect(result.output).toContain("synthetic held module route failure");
    expect(result.output).not.toContain("Unhandled Rejection");
    expect(result.journal.events).toContain("aborted fault");
  }));

it.for([
  ["concurrent-close", true, 1],
  ["close-failure", false, 1],
  ["late-context", true, 1],
  ["tracked-close-success", true, 2],
  ["tracked-close-failure", false, 1],
] as const)(
  "preserves native browser resource ownership: %s",
  ([mode, success, closeCalls], context) =>
    runJoinedFixture(mode, context, (result) => {
      const tracked = mode.startsWith("tracked-");
      expect(result.code, result.output).toBe(success ? 0 : 1);
      expectClosed(result, closeCalls, success);
      if (!tracked) {
        expectTestCounts(result, success ? 1 : 0, success ? 0 : 2);
        expect(result.journal).toMatchObject({ arrived: true, published: false });
      }
      if (tracked || !success) {
        expect(result.successorStarted, result.output).toBe(success);
      }
      if (!success) {
        expect(result.output).toContain("synthetic context close failure");
        expect(result.output).toContain("retiring owned fork");
      }
      if (mode === "close-failure") {
        expect(result.journal.heldBodyErrorRetained).toBe(true);
      }
    }),
);

it("joins late suite setup before closing its acquired server", (context) =>
  runJoinedFixture("late-setup", context, (result) => {
    expect(result.code, result.output).toBe(1);
    expect(result.output).toContain("Hook timed out");
    expect(result.journal).toMatchObject({
      serverAcquired: true,
      serverClosed: true,
      browserAcquired: false,
      published: false,
    });
  }));

it.for(["scenario-root-drain", "resources-root-drain", "scenario-root-leak"] as const)(
  "drains Gateway requests at the owner close boundary: %s",
  (mode, context) =>
    runJoinedFixture(mode, context, (result) => {
      const leaked = mode === "scenario-root-leak";
      expect(result.code, result.output).toBe(leaked ? 1 : 0);
      expect(result.retainedExists).toBe(leaked);
      expect(result.journal.events).toContain(
        mode.startsWith("resources-") ? "resource closed" : "gateway closed",
      );
      expect(result.journal.events.includes("released")).toBe(!leaked);
    }),
);

it.for([
  ["scenario-timeout", undefined],
  ["scenario-noncooperative", "scenario cleanup did not settle within 500ms"],
  ["scenario-late-close", "scenario cleanup did not settle within 500ms"],
  ["scenario-close-failure", "synthetic gateway close failure"],
] as const)(
  "joins scenario cleanup or retires the unsafe fork and retains its state: %s",
  ([mode, failure], context) =>
    runJoinedFixture(mode, context, (result) => {
      expect(result.code, result.output).toBe(failure ? 1 : 0);
      expect(result.retainedExists).toBe(Boolean(failure));
      expect(result.successorStarted).toBe(!failure);
      if (failure) {
        expect(result.report.numFailedTests, result.output).toBeGreaterThan(0);
        expect(result.output).toContain("retiring owned fork");
        expect(result.output).toContain(failure);
        expect(result.journal.events).not.toContain("released");
      } else {
        expectTestCounts(result, 2, 0);
        expect(result.journal.events).toEqual(["acquired", "gateway closed", "released"]);
      }
      if (mode === "scenario-late-close") {
        expect(result.journal.events).toContain("late close settled");
      }
    }),
);

it.for([
  ["resources-success", false, undefined],
  ["resources-close-failure", true, "synthetic shared resource close failure"],
  ["resources-late-setup", true, "Hook timed out"],
  ["resources-browser-failure", false, "synthetic browser startup failure"],
] as const)(
  "owns shared state through native suite cleanup: %s",
  ([mode, retained, failure], context) =>
    runJoinedFixture(mode, context, (result) => {
      expect(result.code, result.output).toBe(failure ? 1 : 0);
      expect(result.retainedExists).toBe(retained);
      if (failure) {
        expect(result.output).toContain(failure);
      }
      if (mode === "resources-browser-failure") {
        expect(result.journal.events).toEqual([]);
        return;
      }
      expect(result.report.success, result.output).toBe(!failure);
      if (mode === "resources-late-setup") {
        expect(result.journal.events).toEqual(["resource acquired", "resource closed"]);
      } else {
        expect(result.report.numPassedTests, result.output).toBe(2);
        expect(result.journal.events).toEqual([
          "resource acquired",
          "first",
          "second",
          "resource closed",
          ...(failure ? [] : ["released"]),
        ]);
      }
    }),
);
