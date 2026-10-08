import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
} from "../../../test/helpers/fixture-receipts.js";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { noteDiskSpace } from "../../commands/doctor-disk-space.js";
import * as diskSpace from "../../infra/disk-space.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { setLoggerOverride, resetLogger } from "../../logging/logger.js";
import { defaultRuntime } from "../../runtime.js";
import { createUpdateCliBaseSnapshot } from "./update-cli-config.test-support.js";
import { runUpdateFinalizationDoctorInFreshProcess } from "./update-command-fresh-doctor.js";
import { continueMigratedUpdateInFreshProcess } from "./update-command-migrated.js";

const observed = vi.hoisted(() => ({ chunk: vi.fn() }));
vi.mock("../../process/exec.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../process/exec.js")>();
  return {
    ...actual,
    runUtf8CommandWithTimeout: (
      argv: string[],
      options: import("../../process/exec.js").CommandOptions,
    ) =>
      actual.runUtf8CommandWithTimeout(argv, {
        ...options,
        onOutputChunk: (chunk, stream) => {
          options.onOutputChunk?.(chunk, stream);
          observed.chunk(chunk, stream);
        },
      }),
  };
});

const dirs = useAutoCleanupTempDirTracker(afterEach);
let receipts: FixtureReceiptChannel;
beforeAll(async () => {
  receipts = await openFixtureReceiptChannel();
});
afterAll(async () => {
  await receipts.close();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetLogger();
});

it("forwards held Doctor child progress before completion without replay or JSON stdout contamination", async ({
  signal,
}) => {
  const root = dirs.make("fresh-doctor-progress-");
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
  vi.stubEnv("OPENCLAW_LOG_LEVEL", "info");
  setLoggerOverride({ level: "silent", consoleLevel: "info", file: path.join(root, "log") });
  const entryPath = path.join(root, "doctor.mjs");
  // This real Doctor contribution renders a panel but does not add result warnings.
  vi.spyOn(diskSpace, "tryReadDiskSpace").mockReturnValue({
    availableBytes: 50 * 1024 * 1024,
    totalBytes: null,
    targetPath: path.join(root, "state"),
    checkedPath: root,
  });
  const panelWriter = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  noteDiskSpace();
  const panel = panelWriter.mock.calls.map(([chunk]) => String(chunk)).join("");
  panelWriter.mockRestore();
  expect(panel).toContain("CRITICAL: only 50 MB free");
  const heartbeat =
    "SQLite integrity check still running: /private/fixture/chat-store.sqlite (6.0 GiB, 10s elapsed, phase=checking).";
  await fs.writeFile(
    entryPath,
    [
      fixtureReceiptClientSource(receipts.endpoint),
      'const release = awaitRelease("doctor", "finish");',
      'process.stdout.write("password=fixture-private\\n");',
      "process.stdout.write(" + JSON.stringify(panel) + ");",
      "process.stderr.write(" + JSON.stringify(heartbeat + "\n") + ");",
      "await release;",
    ].join("\n"),
  );
  const ready = createDeferred();
  let raw = "";
  observed.chunk.mockImplementation((chunk: Buffer, stream: string) => {
    if (stream === "stderr") {
      raw += chunk.toString();
      if (raw.includes(heartbeat + "\n")) {
        ready.resolve();
      }
    }
  });
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
  const error = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
  const operation = runUpdateFinalizationDoctorInFreshProcess({
    phase: "pre-plugin",
    root,
    entryPath,
    nodeRunner: process.execPath,
    yes: true,
    json: true,
  });
  try {
    await withinTest(
      awaitGateBeforeSettlement(ready.promise, operation, "Doctor exited before its heartbeat"),
      signal,
    );
    expect(stderr.mock.calls.flat().join("")).toContain('"operation":"sqlite-integrity"');
    expect(stderr.mock.calls.flat().join("")).toContain('"elapsedMs":10000');
    expect(stdout).not.toHaveBeenCalled();
  } finally {
    receipts.release("doctor", "finish");
    await operation;
  }
  const emitted = stderr.mock.calls.flat().join("");
  expect(emitted.match(/"operation":"sqlite-integrity"/gu)).toHaveLength(1);
  expect(emitted).not.toContain("fixture-private");
  expect(emitted).not.toContain("chat-store");
  expect(emitted).toContain("CRITICAL: only 50 MB free");
  expect(emitted).toContain("Free up disk space immediately to avoid data loss.");
  expect(log.mock.calls.flat().join("\n")).not.toContain(heartbeat);
  expect(error.mock.calls.flat().join("\n")).not.toContain(heartbeat);
  expect(stdout).not.toHaveBeenCalled();
});

it("relays finalizer progress before settlement and publishes only its one terminal JSON", async ({
  signal,
}) => {
  const root = dirs.make("finalizer-progress-");
  const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") };
  vi.stubEnv("OPENCLAW_LOG_LEVEL", "info");
  setLoggerOverride({ level: "silent", consoleLevel: "info", file: path.join(root, "log") });
  const entryPath = path.join(
    root,
    "dist",
    runtimeProcessEntrypoints.updateMigratedFinalize.distWorkerPath,
  );
  await fs.mkdir(path.dirname(entryPath), { recursive: true });
  const progress =
    "[update progress] " +
    JSON.stringify({
      phase: "pre-plugin",
      stream: "stderr",
      operation: "sqlite-integrity",
      operationPhase: "checking",
      elapsedMs: 10_000,
      size: "6.0 GiB",
      cancellation: "available",
    });
  await fs.writeFile(
    entryPath,
    [
      fixtureReceiptClientSource(receipts.endpoint),
      'import { writeFile } from "node:fs/promises";',
      'let input = ""; for await (const chunk of process.stdin) input += chunk;',
      "const request = JSON.parse(input);",
      'const release = awaitRelease("finalizer", "finish");',
      "process.stderr.write(" + JSON.stringify(progress + "\n") + ");",
      "await release;",
      "const result = {...request.params.result, runId: request.params.opts.run.runId};",
      "await writeFile(request.resultPath, JSON.stringify({ result, terminalRunId: result.runId, exitCode: 0 }));",
      'process.stdout.write(JSON.stringify(result) + "\\n");',
    ].join("\n"),
  );
  const ready = createDeferred();
  let raw = "";
  observed.chunk.mockImplementation((chunk: Buffer, stream: string) => {
    if (stream === "stderr") {
      raw += chunk.toString();
      if (raw.includes(progress + "\n")) {
        ready.resolve();
      }
    }
  });
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const operation = continueMigratedUpdateInFreshProcess(
    {
      root,
      result: { status: "ok", mode: "npm", root, durationMs: 0, steps: [] },
      mutationStarted: false,
      installKindChanged: false,
      configSnapshot: createUpdateCliBaseSnapshot({}),
      requestedChannel: null,
      storedChannel: "stable",
      channel: "stable",
      downgradeRisk: false,
      shouldRestart: false,
      opts: { json: true, run: { runId: "fixture-run", env } },
      controlPlaneUpdateSentinelMeta: null,
      preUpdatePluginInstallRecords: {},
      startedAt: Date.now(),
      packageUpdateNodeRunner: process.execPath,
      updateStepTimeoutMs: 30_000,
    },
    [],
  );
  try {
    await withinTest(
      awaitGateBeforeSettlement(ready.promise, operation, "Finalizer exited before progress"),
      signal,
    );
    expect(stderr.mock.calls.flat().join("")).toContain('"operation":"sqlite-integrity"');
    expect(stdout).not.toHaveBeenCalled();
  } finally {
    receipts.release("finalizer", "finish");
    await operation;
  }
  expect(
    stderr.mock.calls
      .flat()
      .join("")
      .match(/"operation":"sqlite-integrity"/gu),
  ).toHaveLength(1);
  expect(stdout).toHaveBeenCalledTimes(1);
  expect(JSON.parse(stdout.mock.calls.flat().join(""))).toMatchObject({
    status: "ok",
    runId: "fixture-run",
  });
});
