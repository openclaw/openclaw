import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { formatCliFailureLines } from "../cli/failure-output.js";
import { createInvalidConfigError } from "../config/io.invalid-config.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import * as diskSpace from "./disk-space.js";
import { registerCanaryMigrationPolicyTests } from "./update-candidate-canary-migration.test-support.js";
import {
  registerCanaryProgressWorkerTests,
  registerCanaryUncertainReceiptTests,
} from "./update-candidate-canary-progress.test-support.js";
import * as readiness from "./update-candidate-canary-readiness.test-support.js";
import { validateUpdateCandidateCanary } from "./update-candidate-canary.js";
import {
  registerCanarySnapshotCapacityTests,
  createCanarySnapshotResult,
  type FakeChild,
  renderSteps,
  canaryOutcomeStep,
  stubHealthyGateway,
} from "./update-candidate-canary.test-support.js";
import { createCanaryHarness } from "./update-candidate-harness.test-support.js";
import { CONTROL_PLANE_UPDATE_SENTINEL_META_ENV } from "./update-control-plane-sentinel.js";
import {
  createDeferredConfiguredPluginRepairDoctorResult,
  writeUpdatePostInstallDoctorResult,
  UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV,
} from "./update-doctor-result.js";
import {
  POST_CORE_UPDATE_RESULT_PATH_ENV,
  POST_CORE_UPDATE_SOURCE_CONFIG_PATH_ENV,
} from "./update-post-core-context.js";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), snapshot: vi.fn(), signal: vi.fn() }));
// Readiness tests spy on timer exports, which native ESM namespaces cannot replace.
vi.mock("node:timers/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:timers/promises")>()),
}));
vi.mock("node:child_process", async (importOriginal) =>
  (await import("./update-candidate-canary-mocks.test-support.js")).mockCanaryChildProcesses(
    await importOriginal<typeof import("node:child_process")>(),
    mocks.spawn,
  ),
);
vi.mock("../process/exec.js", async (importOriginal) => {
  const { mockCanarySnapshotCommands } =
    await import("./update-candidate-canary-mocks.test-support.js");
  return mockCanarySnapshotCommands(
    await importOriginal<typeof import("../process/exec.js")>(),
    mocks.snapshot,
  );
});
vi.mock("../process/kill-tree.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../process/kill-tree.js")>()),
  signalProcessTree: mocks.signal,
}));

const admission = vi.hoisted(
  (): {
    active: boolean;
    beforeGrant?: (stage: string) => void;
  } => ({ active: false }),
);
vi.mock("./sqlite-worker-operation-admission.js", async (importOriginal) =>
  (
    await import("./update-candidate-canary-mocks.test-support.js")
  ).mockCanarySqliteOperationAdmission(
    await importOriginal<typeof import("./sqlite-worker-operation-admission.js")>(),
    admission,
  ),
);
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    admission.beforeGrant = undefined;
    await closeStateDatabaseForTest();
    cleanup();
  }),
);
let root: string;
let candidateConfig: Record<string, unknown>;
let childEnv: NodeJS.ProcessEnv;
let pluginInventory: unknown;
let runtimeError = false;
let runtimeContract: unknown;
let databasePath: string | undefined;

const harness = createCanaryHarness(mocks, {
  databasePath: () => databasePath,
  readFixture: () => ({ pluginInventory, runtimeContract, runtimeError }),
  onSpawn: (args, options) => {
    childEnv = options.env;
    if (args.includes("gateway")) {
      candidateConfig = JSON.parse(readFileSync(options.env.OPENCLAW_CONFIG_PATH!, "utf8"));
    }
  },
});
const { children, options: canaryStateOptions } = harness;
function createChild(write?: (child: FakeChild) => void, tracked = false) {
  const child = harness.child(tracked);
  if (write) {
    queueMicrotask(() => write(child));
  }
  return child;
}

async function expectRemoved(directory: string) {
  await expect(fs.access(directory)).rejects.toMatchObject({ code: "ENOENT" });
}

function registryFailure(message: string, pluginId?: string) {
  return {
    plugins: [],
    registry: { diagnostics: [{ level: "error", message, ...(pluginId ? { pluginId } : {}) }] },
  };
}

function validate(overrides: Partial<Parameters<typeof validateUpdateCandidateCanary>[0]> = {}) {
  return validateUpdateCandidateCanary({ ...canaryStateOptions(3_000), ...overrides });
}

function doctorWrites(write: (env: NodeJS.ProcessEnv) => Promise<void>, exitCode = 0) {
  mocks.spawn.mockImplementationOnce(
    (_command, args: string[], options: { env: NodeJS.ProcessEnv }) => {
      expect(args).toContain("doctor");
      const child = createChild(undefined, true);
      void write(options.env).then(
        () => child.emit("close", exitCode),
        (error: unknown) => child.emit("error", error),
      );
      return child;
    },
  );
}

beforeEach(async () => {
  pluginInventory = undefined;
  runtimeError = false;
  runtimeContract = { state: 2, agent: 3 };
  databasePath = undefined;
  root = await harness.reset(tempDirs.make("canary-unit-"));
});

afterEach(() => {
  vi.unstubAllGlobals();
  children.clear();
});

describe("update candidate canary", () => {
  readiness.registerCanaryReadinessBudgetTests(() => root, mocks);
  registerCanaryMigrationPolicyTests({ mocks, canaryStateOptions, getChildEnv: () => childEnv });
  registerCanarySnapshotCapacityTests({ canaryStateOptions, getRoot: () => root, mocks });

  it.each(
    ["node", "bun"].filter(
      (runtime) =>
        process.platform !== "win32" || runtime === (process.versions.bun ? "bun" : "node"),
    ),
  )(
    "isolates %s candidate state, configuration, service environment, and source selection",
    async (runtime) => {
      stubHealthyGateway();
      const warnings = ["Update checks could not inspect plugin esm-fixture: unsupported syntax."];
      mocks.snapshot.mockImplementation(async (_command, options: { input: string }) =>
        createCanarySnapshotResult(options.input, databasePath, warnings),
      );
      const servingRoot = path.join(root, "installed");
      const excluded = {
        [CONTROL_PLANE_UPDATE_SENTINEL_META_ENV]: path.join(root, "live-sentinel.json"),
        [POST_CORE_UPDATE_RESULT_PATH_ENV]: path.join(root, "live-result.json"),
        [POST_CORE_UPDATE_SOURCE_CONFIG_PATH_ENV]: path.join(root, "live-config.json"),
        OPENCLAW_UPDATE_RUN_HANDOFF: "1",
        OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH: path.join(root, "live-doctor-result.json"),
        OPENCLAW_SYSTEMD_UNIT: "source-gateway.service",
      };
      const env = {
        ...excluded,
        OPENCLAW_DEV_SOURCE_ROOT: servingRoot,
        CUSTOM_PROVIDER_KEY: "synthetic-provider-credential",
      };
      const config = {
        gateway: { port: 18789 },
        mcp: { apps: { enabled: true, sandboxPort: 18790 } },
        cron: { enabled: true },
      };
      const nodeRunner = process.platform === "win32" ? process.execPath : path.join(root, runtime);
      if (process.platform !== "win32") {
        // The snapshot watchdog also launches this runtime for a real builtin-only I/O probe.
        await fs.symlink(process.execPath, nodeRunner);
      }
      const result = await validate({ env, nodeRunner, config });
      expect(result.status).toBe("ok");
      expect(result.candidateSchemaVersions).toEqual({ state: 2, agent: 3 });
      expect(result.steps[0]?.warnings).toEqual([
        ...warnings,
        expect.stringContaining("deadline allows at most 3 s"),
      ]);
      expect(mocks.snapshot.mock.calls[0]?.[0]).toEqual([
        nodeRunner,
        ...(runtime === "bun" ? ["--no-install"] : []),
        path.join(root, "dist", "infra", "update-candidate-state.worker.js"),
      ]);
      expect(mocks.snapshot.mock.calls[0]?.[1].baseEnv.OPENCLAW_DEV_SOURCE_ROOT).toBe(root);
      expect(mocks.spawn.mock.calls.length).toBeGreaterThan(0);
      for (const call of mocks.spawn.mock.calls) {
        expect(call[0]).toBe(nodeRunner);
        expect(call[1].includes("--no-install")).toBe(runtime === "bun");
        expect(call[2].env.OPENCLAW_DEV_SOURCE_ROOT).toBe(root);
      }
      expect(env.OPENCLAW_DEV_SOURCE_ROOT).toBe(servingRoot);
      expect(childEnv.OPENCLAW_STATE_DIR).not.toBe(root);
      expect(childEnv).toMatchObject({
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_PROVIDERS: "1",
        OPENCLAW_NO_AUTO_UPDATE: "1",
        CUSTOM_PROVIDER_KEY: "synthetic-provider-credential",
      });
      for (const key of Object.keys(excluded)) {
        expect(childEnv[key]).toBeUndefined();
      }
      expect(candidateConfig).toMatchObject({
        cron: { enabled: false },
        gateway: { bind: "loopback", port: expect.any(Number) },
        mcp: { apps: { enabled: false } },
      });
      expect(candidateConfig.gateway).not.toMatchObject({ port: config.gateway.port });
      expect(config).toEqual({
        gateway: { port: 18789 },
        mcp: { apps: { enabled: true, sandboxPort: 18790 } },
        cron: { enabled: true },
      });
      await expectRemoved(childEnv.OPENCLAW_STATE_DIR!);
    },
  );

  registerCanaryProgressWorkerTests(() => root, mocks, admission);

  it.each([
    ["snapshot", 32 * 1024 ** 2, 30_000, 300_001, "ok", "30 s", "340 s"],
    ["doctor", 0, undefined, 31 * 60_000, "error", undefined, undefined],
    ["doctor", 400 * 1024 ** 2, undefined, 400_000, "ok", undefined, undefined],
    ["doctor", 2 * 1024 ** 3, undefined, 31 * 60_000, "ok", undefined, undefined],
    ["doctor", 2 * 1024 ** 3, 30 * 60_000, 31 * 60_000, "error", "1800 s", "2860 s"],
    ["doctor", 2 * 1024 ** 3, 2_860_000, 31 * 60_000, "ok", undefined, undefined],
  ] as const)(
    "keeps the %s budget separate for %i state bytes and an explicit %s deadline",
    async (stage, sqliteBytes, timeoutMs, elapsedMs, expectedStatus, limit, allowance) => {
      databasePath = path.join(root, "budget.sqlite");
      await fs.writeFile(databasePath, "");
      await fs.truncate(databasePath, sqliteBytes);
      // Sparse state models validation cost, not the host's free disk space.
      const capacity =
        stage === "doctor"
          ? vi.spyOn(diskSpace, "tryReadDiskSpace").mockImplementation((targetPath) => ({
              targetPath,
              checkedPath: targetPath,
              availableBytes: 16 * 1024 ** 3,
              totalBytes: 32 * 1024 ** 3,
            }))
          : undefined;
      const now = Date.now.bind(Date);
      let elapsed = 0;
      const clock = vi.spyOn(Date, "now").mockImplementation(() => now() + elapsed);
      if (stage === "snapshot") {
        const snapshot = mocks.snapshot.getMockImplementation()!;
        mocks.snapshot.mockImplementation(async (command, options: { input: string }) => {
          const request: unknown = JSON.parse(options.input);
          if (isRecord(request) && request.mode === "snapshot") {
            elapsed = elapsedMs;
          }
          return snapshot(command, options);
        });
      } else {
        mocks.spawn.mockImplementationOnce((_command, _args, options) => {
          childEnv = options.env;
          elapsed = elapsedMs;
          return createChild((child) => child.emit("close", 0), true);
        });
      }
      stubHealthyGateway();
      try {
        const result = await validateUpdateCandidateCanary(canaryStateOptions(timeoutMs));
        expect(result.steps[0]?.snapshotCapacity?.sqliteBytes).toBe(sqliteBytes);
        expect(result, result.logTail.join("\n")).toMatchObject({
          status: expectedStatus,
          phase: expectedStatus === "ok" ? "readiness" : "doctor",
        });
        const warnings = result.steps[0]?.warnings?.join("\n") ?? "";
        if (limit) {
          expect(warnings).toContain(`allows at most ${limit}`);
          expect(warnings).toContain(`automatic ${allowance} allowance`);
        } else {
          expect(warnings).not.toContain("Checks may time out early");
        }
        if (expectedStatus === "error") {
          expect(result.logTail.join("\n")).toContain("deadline exceeded");
        }
        if (stage === "snapshot") {
          expect(result.durationMs).toBeGreaterThanOrEqual(elapsedMs);
          await expectRemoved(childEnv.OPENCLAW_STATE_DIR!);
        }
      } finally {
        clock.mockRestore();
        capacity?.mockRestore();
      }
    },
  );

  it("identifies legacy Doctor writes even if later validation fails", async () => {
    runtimeError = true;
    doctorWrites(async (env) => {
      const configPath = env.OPENCLAW_CONFIG_PATH;
      if (!configPath) {
        throw new Error("Missing rehearsal config");
      }
      const config: unknown = JSON.parse(await fs.readFile(configPath, "utf8"));
      if (!isRecord(config)) {
        throw new Error("Invalid rehearsal fixture");
      }
      Object.assign(config, {
        meta: { lastTouchedVersion: "2026.9.4" },
        wizard: { lastRunCommand: "doctor" },
        plugins: { entries: { openai: { enabled: true } } },
      });
      await fs.writeFile(configPath, JSON.stringify(config));
    });
    stubHealthyGateway();
    const result = await validate();
    expect(result).toMatchObject({ status: "error", phase: "runtime" });
    await expectRemoved(childEnv.OPENCLAW_STATE_DIR!);
    expect(mocks.signal).toHaveBeenCalled();
    expect(result.doctorConfigWrites).not.toBe(true);
    expect(result.doctorConfigChanges).toEqual(
      ["meta", "plugins", "wizard"].map((key) => ({ kind: "key", key })),
    );
  });
  it.each([
    {
      label: "advisory",
      receipt: createDeferredConfiguredPluginRepairDoctorResult([
        "Deferred configured plugin repair.",
      ]),
      exitCode: 86,
      expectedStatus: "ok",
    },
    {
      label: "error",
      receipt: {
        status: "error" as const,
        failureFacts: [
          {
            check: "core/doctor/runtime-tool-schemas",
            code: "doctor-failed",
            affectedKey: "mcp.servers",
            message: "connect ECONNREFUSED",
          },
        ],
      },
      exitCode: 1,
      expectedStatus: "error",
    },
  ])(
    "preserves classified Doctor $label and its receipt evidence",
    async ({ receipt, exitCode, expectedStatus }) => {
      doctorWrites((env) => {
        const resultPath = env[UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV];
        if (!resultPath) {
          throw new Error("Missing candidate Doctor receipt");
        }
        return writeUpdatePostInstallDoctorResult({ resultPath, result: receipt });
      }, exitCode);
      stubHealthyGateway();
      const result = await validate();
      expect(result.status).toBe(expectedStatus);
      const step = result.steps.find((entry) => entry.name === "candidate-doctor");
      expect(step?.exitCode).toBe(exitCode);
      if (receipt.status === "advisory") {
        expect(step?.advisory).toEqual({
          kind: "recoverable-maintenance",
          message: receipt.advisory.details.join("\n"),
        });
      } else {
        expect(step?.advisory).toBeUndefined();
      }
      expect(step?.failureFacts).toEqual(receipt.failureFacts);
    },
  );
  it.each([
    ["plugin load failure", { plugins: [{ id: "fixture", status: "error" }] }, true, undefined],
    [
      "attributed registry failure",
      registryFailure("Plugin unavailable", "fixture"),
      true,
      undefined,
    ],
    [
      "unattributed registry failure",
      registryFailure("Duplicate plugin registration"),
      false,
      "Duplicate plugin registration",
    ],
    ["malformed plugin inventory", { plugins: [{ status: "error" }] }, false, "invalid inventory"],
    ["array plugin inventory", [], false, "invalid inventory"],
  ] as const)(
    "handles %s before proving core readiness",
    async (_label, inventory, proceeds, failureMessage) => {
      pluginInventory = inventory;
      stubHealthyGateway();

      const result = await validate();

      expect(result).toMatchObject({
        status: proceeds ? "ok" : "error",
        phase: proceeds ? "readiness" : "plugins",
      });
      if (failureMessage) {
        expect(canaryOutcomeStep(result.steps)?.failureFacts?.[0]?.message).toContain(
          failureMessage,
        );
        expect(renderSteps(result.steps)).toContain(failureMessage);
      }
      expect(mocks.spawn.mock.calls.some(([, args]) => args.includes("gateway"))).toBe(proceeds);
      if (proceeds) {
        expect(result.steps).toContainEqual(
          expect.objectContaining({
            name: "candidate-plugins",
            exitCode: 0,
            stdoutTail: 'Plugin "fixture" could not be loaded during the update preview.',
          }),
        );
      }
    },
  );

  it("keeps verified readiness and records a warning when rehearsal cleanup fails", async () => {
    stubHealthyGateway();
    const remove = fs.rm.bind(fs);
    let retained: string | undefined;
    const denial = vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
      if (
        typeof target === "string" &&
        path.basename(target).startsWith("openclaw-update-canary-")
      ) {
        retained = target;
        throw new Error("synthetic cleanup permission denied");
      }
      return remove(target, options);
    });
    const onStep = vi.fn();
    try {
      const result = await validate({ onStep });
      expect(result.status).toBe("ok");
      const cleanup = result.steps.at(-1);
      expect(cleanup?.name).toBe("candidate-state-cleanup");
      expect(cleanup?.advisory?.message).toContain("synthetic cleanup permission denied");
      expect(cleanup?.advisory?.message).toContain(retained);
      expect(onStep).toHaveBeenCalledWith(cleanup);
    } finally {
      denial.mockRestore();
      if (retained) {
        await remove(retained, { recursive: true, force: true });
      }
    }
  });
  it.each(["lint", "startup-multiline", "startup-tail", "config", "multiline"])(
    "retains the failure reason when %s exits before its report",
    async (scenario) => {
      const phase = scenario.startsWith("startup")
        ? "startup"
        : scenario === "config"
          ? "config"
          : "lint";
      harness.overrideSpawn(
        { lint: "--lint", startup: "--update-canary", config: "validate" }[phase],
        (args, options) => {
          const error = scenario.endsWith("multiline")
            ? createInvalidConfigError(
                "/fixture/openclaw.json",
                `- gateway.port: invalid ${"x".repeat(160)} token=synthetic-secret\n- gateway.host: unknown`,
              )
            : new Error("Unable to resolve health API token=synthetic-secret");
          if (scenario === "startup-multiline") {
            throw error;
          }
          return createChild((child) => {
            if (phase === "config") {
              child.stdout.write(
                JSON.stringify({
                  ok: false,
                  error: { message: "OpenClaw config is invalid" },
                  valid: false,
                  issues: [
                    { path: "gateway.port", message: "Expected number; token=synthetic-secret" },
                  ],
                }),
              );
            }
            if (scenario === "startup-tail") {
              child.stderr.write(
                "openclaw-update-canary-progress: cli.main.argv\nEarlier warning\n",
              );
              child.stderr.write(`${"x".repeat(20_001)} ${error.message}\n`);
              child.stderr.write(
                "openclaw-update-canary-progress: cli.main.gateway-run-bootstrap\n",
              );
            } else {
              child.stderr.write(
                formatCliFailureLines({
                  title: "The CLI command failed.",
                  error,
                  argv: args,
                  env: options.env,
                }).join("\n") + "\n",
              );
            }
            if (["lint", "config"].includes(scenario)) {
              child.stderr.write(
                Array.from({ length: 60 }, (_, index) => `cleanup ${index}\n`).join(""),
              );
            }
            child.emit("close", 1);
          });
        },
      );
      const env = { API_TOKEN: "synthetic-secret" };
      const result = await validateUpdateCandidateCanary({ ...canaryStateOptions(3_000), env });
      expect(result).toMatchObject({ status: "error", phase });
      const failed = canaryOutcomeStep(result.steps)!;
      if (scenario === "startup-tail") {
        expect.soft(failed.stderrTail).toContain("Unable to resolve health API");
      }
      expect(failed.failureFacts?.[0]?.message).toContain(
        phase === "config"
          ? "Expected number"
          : scenario.endsWith("multiline")
            ? "Invalid config"
            : "Unable to resolve health API",
      );
      const output = renderSteps([failed]);
      if (scenario.endsWith("multiline")) {
        expect(output).toContain("gateway.port: invalid");
        expect(output).toContain("gateway.host: unknown");
      } else if (scenario !== "config") {
        expect(output).toContain("Unable to resolve health API");
        if (scenario !== "startup-tail") {
          expect(output.match(/Unable to resolve health API/gu)).toHaveLength(1);
        }
      }
      if (phase === "config") {
        expect(failed.failureFacts?.[0]?.affectedKey).toBe("gateway.port");
      }
      expect(JSON.stringify(result)).not.toContain("synthetic-secret");
    },
  );

  it("records snapshot failure and cleans private state before boot", async () => {
    const snapshot = mocks.snapshot.getMockImplementation()!;
    mocks.snapshot.mockImplementation(async (command, options: { input: string }) => {
      const request: unknown = JSON.parse(options.input);
      if (isRecord(request) && request.mode === "inventory") {
        return snapshot(command, options);
      }
      return {
        ...createCanarySnapshotResult(options.input, databasePath),
        code: 1,
        stdout: "",
        stderr: "snapshot rejected",
      };
    });
    const result = await validate();
    expect(result).toMatchObject({ status: "error", phase: "snapshot" });
    expect(mocks.spawn).not.toHaveBeenCalled();
    await expectRemoved(harness.snapshotDirectory());
  });

  it("refuses a candidate that cannot keep Doctor away from managed services", async () => {
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ version: "2026.4.1" }));
    const result = await validateUpdateCandidateCanary(canaryStateOptions());
    expect(result.status).toBe("error");
    expect(mocks.snapshot).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("rejects a zero-exit continuation worker without its compiled schema contract before boot", async () => {
    runtimeContract = null;
    const result = await validateUpdateCandidateCanary(canaryStateOptions(3_000));
    expect(result).toMatchObject({ status: "error", phase: "runtime" });
    expect(canaryOutcomeStep(result.steps)).toMatchObject({
      name: "candidate-recovery",
      exitCode: 1,
    });
    expect(mocks.spawn.mock.calls.some(([, args]) => args.includes("--update-canary"))).toBe(false);
  });

  registerCanaryUncertainReceiptTests({
    mocks,
    canaryStateOptions,
    setRuntimeError: (value) => {
      runtimeError = value;
    },
  });

  it.each(["candidate-state-snapshot", "candidate-doctor"])(
    "joins %s recording before starting the next child or observing cancellation",
    async (name) => {
      stubHealthyGateway();
      const entered = createDeferredCore();
      const receipt = createDeferredCore();
      const controller = new AbortController();
      const pending = validateUpdateCandidateCanary({
        ...canaryStateOptions(3_000),
        signal: controller.signal,
        onStep: (step) => {
          if (step.name === name && step.exitCode === 0) {
            entered.resolve();
            return receipt.promise;
          }
          return undefined;
        },
      });
      await entered.promise;
      const expectedChildren = name === "candidate-doctor" ? 1 : 0;
      expect(mocks.spawn).toHaveBeenCalledTimes(expectedChildren);
      controller.abort(new Error("cancelled during step recording"));
      receipt.resolve();
      const result = await pending;
      expect(result.status).toBe("error");
      expect(canaryOutcomeStep(result.steps)?.failureFacts?.[0]?.message).toContain(
        "cancelled during step recording",
      );
      expect(mocks.spawn).toHaveBeenCalledTimes(expectedChildren);
      await expectRemoved(harness.snapshotDirectory());
    },
  );

  it.each([0, 1])("bounds multibyte stdout at the byte ceiling plus %i", async (overflow) => {
    runtimeError = true;
    harness.overrideSpawn("plugins", () => {
      const child = harness.child();
      const json = JSON.stringify({ plugins: [], padding: "é".repeat(500_000) });
      const bytes = Buffer.from(
        json + " ".repeat(1024 * 1024 + overflow - Buffer.byteLength(json)),
      );
      queueMicrotask(() => {
        child.stdout.write(bytes.subarray(0, 600_000));
        child.stdout.end(bytes.subarray(600_000));
        child.emit("close", 0);
      });
      return child;
    });
    const result = await validateUpdateCandidateCanary(canaryStateOptions(3_000));
    expect(result).toMatchObject({ status: "error", phase: overflow ? "plugins" : "runtime" });
  });

  it("preserves split UTF-8 diagnostics and final unterminated lines on both pipes", async () => {
    const expected = ["stdout 診断: café 🦞", "stderr 診断: café 🦞"];
    mocks.spawn.mockImplementationOnce(() =>
      createChild((child) => {
        child.stdout.write(Array.from({ length: 60 }, (_, index) => `line ${index}\n`).join(""));
        for (const [index, stream] of [child.stdout, child.stderr].entries()) {
          // Real pipe chunks may end inside a code point; EOF need not follow a newline.
          const bytes = Buffer.from(`${expected[index]}\r\n${expected[index]} final`);
          for (const byte of bytes) {
            stream.write(Buffer.from([byte]));
          }
          stream.end();
        }
        child.emit("close", 1);
      }),
    );
    const result = await validateUpdateCandidateCanary(canaryStateOptions(3_000));
    expect(result).toMatchObject({ status: "error", phase: "doctor" });
    expect(result.logTail.length).toBeLessThanOrEqual(40);
    expect(mocks.signal).toHaveBeenCalled();
    await expectRemoved(childEnv.OPENCLAW_STATE_DIR!);
    for (const line of expected) {
      expect(result.logTail).toContain(line);
      expect(result.logTail).toContain(`${line} final`);
      expect(canaryOutcomeStep(result.steps)?.stderrTail).toContain(`${line}\n`);
      expect(canaryOutcomeStep(result.steps)?.stderrTail).toContain(`${line} final`);
    }
  });

  it("omits the entire oversized log line across chunks while preserving following diagnostics", async () => {
    mocks.spawn.mockImplementationOnce(() =>
      createChild((child) => {
        child.stderr.write("x".repeat(70_000));
        child.stderr.write("synthetic-sensitive-suffix\nfollowing-safe-line\n");
        child.emit("close", 1);
      }),
    );
    const result = await validateUpdateCandidateCanary(canaryStateOptions(3_000));
    expect(result.status).toBe("error");
    expect(result.logTail.join("\n")).not.toContain("synthetic-sensitive-suffix");
    expect(result.logTail).toContain("following-safe-line");
    expect(canaryOutcomeStep(result.steps)?.stderrTail).toContain("following-safe-line");
  });

  it("records the rehearsal Doctor's traced sections without logging the trace", async () => {
    stubHealthyGateway();
    const spawnDefault = mocks.spawn.getMockImplementation()!;
    const traceEnv: Record<string, string | undefined> = {};
    mocks.spawn.mockImplementation(
      (command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
        const child = spawnDefault(command, args, options) as FakeChild;
        const key = args.includes("--fix") ? "doctor" : args.includes("gateway") ? "gateway" : "";
        traceEnv[key] = options.env.OPENCLAW_GATEWAY_STARTUP_TRACE;
        if (args.includes("--fix")) {
          child.stderr.write(
            "[gateway] startup trace: doctor.database-preflight 1200.0ms total=1300.0ms start=100.0ms\n" +
              "[gateway] startup trace: doctor.contributions 3400.0ms total=4800.0ms start=1400.0ms\n",
          );
        }
        return child;
      },
    );
    const result = await validateUpdateCandidateCanary(canaryStateOptions(3_000));
    expect(result.status).toBe("ok");
    expect(result.steps.find((step) => step.name === "candidate-doctor")?.diagnostics).toEqual([
      "Doctor sections: database-preflight 1.2 s, contributions 3.4 s",
    ]);
    expect(result.logTail.join("\n")).not.toContain("startup trace");
    expect(traceEnv.doctor).toBe("1");
    expect(traceEnv.gateway).toBeUndefined();
  });
});
