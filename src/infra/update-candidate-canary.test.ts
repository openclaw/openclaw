import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { formatCliFailureLines, formatCliJsonFailure } from "../cli/failure-output.js";
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
import { renderUpdateRunReport, updateRunReportInputFromResult } from "./update-run-report.js";
import { updateRunStepsFromResultStep } from "./update-run-step.js";

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
    [
      { runtime: "node", runtimeArgs: [] },
      { runtime: "bun", runtimeArgs: ["--no-install"] },
    ].filter(
      ({ runtime }) =>
        process.platform !== "win32" || runtime === (process.versions.bun ? "bun" : "node"),
    ),
  )(
    "keeps $runtime snapshot and validation source selection inside the candidate",
    async ({ runtime, runtimeArgs }) => {
      stubHealthyGateway();
      const warnings = ["Update checks could not inspect plugin esm-fixture: unsupported syntax."];
      mocks.snapshot.mockImplementation(async (_command, options: { input: string }) =>
        createCanarySnapshotResult(options.input, databasePath, warnings),
      );
      const servingRoot = path.join(root, "installed");
      const env = { OPENCLAW_DEV_SOURCE_ROOT: servingRoot };
      const nodeRunner = process.platform === "win32" ? process.execPath : path.join(root, runtime);
      if (process.platform !== "win32") {
        // The snapshot watchdog also launches this runtime for a real builtin-only I/O probe.
        await fs.symlink(process.execPath, nodeRunner);
      }
      const result = await validateUpdateCandidateCanary({
        ...canaryStateOptions(3000),
        env,
        nodeRunner,
      });
      expect(result.status).toBe("ok");
      expect(result.steps[0]?.warnings).toEqual(warnings);
      expect(mocks.snapshot.mock.calls[0]?.[0]).toEqual([
        nodeRunner,
        ...runtimeArgs,
        path.join(root, "dist", "infra", "update-candidate-state.worker.js"),
      ]);
      expect(mocks.snapshot.mock.calls[0]?.[1].baseEnv.OPENCLAW_DEV_SOURCE_ROOT).toBe(root);
      expect(mocks.spawn.mock.calls.length).toBeGreaterThan(0);
      for (const call of mocks.spawn.mock.calls) {
        expect(call[0]).toBe(nodeRunner);
        expect(call[1].slice(0, runtimeArgs.length)).toEqual(runtimeArgs);
        expect(call[1].includes("--no-install")).toBe(runtime === "bun");
        expect(call[2].env.OPENCLAW_DEV_SOURCE_ROOT).toBe(root);
      }
      expect(env.OPENCLAW_DEV_SOURCE_ROOT).toBe(servingRoot);
    },
  );

  registerCanaryProgressWorkerTests(() => root, mocks, admission);

  it.each([
    ["snapshot", 32 * 1024 ** 2, 30_000, 300_001, "ok"],
    ["doctor", 0, undefined, 31 * 60_000, "error"],
    ["doctor", 400 * 1024 ** 2, undefined, 400_000, "ok"],
    ["doctor", 2 * 1024 ** 3, undefined, 31 * 60_000, "ok"],
    ["doctor", 2 * 1024 ** 3, 30 * 60_000, 31 * 60_000, "error"],
  ] as const)(
    "keeps the %s budget separate for %i state bytes and an explicit %s deadline",
    async (stage, sqliteBytes, timeoutMs, elapsedMs, expectedStatus) => {
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
        if (expectedStatus === "error") {
          expect(result.logTail.join("\n")).toContain("deadline exceeded");
        } else {
          expect(result.steps).toContainEqual(
            expect.objectContaining({
              name: stage === "snapshot" ? "candidate-gateway-startup" : "candidate-doctor",
              exitCode: 0,
            }),
          );
          expect(result.logTail.join("\n")).toContain("readyz: ready");
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
    mocks.spawn.mockImplementationOnce(
      (_command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
        expect(args).toContain("doctor");
        const child = createChild(undefined, true);
        const configPath = options.env.OPENCLAW_CONFIG_PATH;
        if (!configPath) {
          throw new Error("Missing rehearsal config");
        }
        void fs
          .readFile(configPath, "utf8")
          .then(async (raw) => {
            const config: unknown = JSON.parse(raw);
            if (!isRecord(config)) {
              throw new Error("Invalid rehearsal fixture");
            }
            config.meta = { lastTouchedVersion: "2026.9.4" };
            config.wizard = { lastRunCommand: "doctor" };
            config.plugins = { entries: { openai: { enabled: true } } };
            await fs.writeFile(configPath, JSON.stringify(config));
            child.emit("close", 0);
          })
          .catch((error: unknown) => child.emit("error", error));
        return child;
      },
    );
    stubHealthyGateway();
    const result = await validateUpdateCandidateCanary(canaryStateOptions(3_000));
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
      mocks.spawn.mockImplementationOnce(
        (_command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
          expect(args).toContain("doctor");
          const child = createChild(undefined, true);
          const resultPath = options.env[UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV];
          if (!resultPath) {
            throw new Error("Missing candidate Doctor receipt");
          }
          void writeUpdatePostInstallDoctorResult({ resultPath, result: receipt }).then(
            () => child.emit("close", exitCode),
            (error: unknown) => child.emit("error", error),
          );
          return child;
        },
      );
      stubHealthyGateway();
      const result = await validateUpdateCandidateCanary(canaryStateOptions(3_000));
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
    ["primitive plugin inventory", "invalid", false, "invalid inventory"],
  ] as const)(
    "handles %s before proving core readiness",
    async (_label, inventory, proceeds, failureMessage) => {
      pluginInventory = inventory;
      stubHealthyGateway();

      const result = await validateUpdateCandidateCanary(canaryStateOptions(3_000));

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
      const result = await validateUpdateCandidateCanary({ ...canaryStateOptions(3000), onStep });
      expect(result.status).toBe("ok");
      expect(result.steps).toContainEqual(
        expect.objectContaining({ name: "candidate-gateway-startup", exitCode: 0 }),
      );
      expect(result.steps).toContainEqual(
        expect.objectContaining({
          name: "candidate-state-cleanup",
          advisory: expect.objectContaining({
            message: expect.stringContaining("synthetic cleanup permission denied"),
          }),
        }),
      );
      expect(onStep).toHaveBeenCalledWith(result.steps.at(-1));
      expect(result.steps.at(-1)?.advisory?.message).toContain(retained);
    } finally {
      denial.mockRestore();
      if (retained) {
        await remove(retained, { recursive: true, force: true });
      }
    }
  });
  it("rehearses private state, observes readiness, and joins child close after tree signals", async () => {
    runtimeContract = {
      state: 2,
      agent: 3,
      executorDelegation: "pid-start-v1",
      candidateMutation: "checkpoint-owned-v1",
    };
    const requests: string[] = [];
    const completed: Array<{ name: string; argv: string[] }> = [];
    let startupCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        requests.push(new URL(url).pathname);
        if (url.endsWith("startupz")) {
          startupCalls += 1;
          return Response.json({ status: startupCalls === 1 ? "starting" : "started" });
        }
        return Response.json({ ready: true });
      }),
    );
    const original = {
      gateway: { port: 18789 },
      mcp: { apps: { enabled: true, sandboxPort: 18790 } },
      cron: { enabled: true },
      agents: {
        entries: { main: { workspace: "/original/workspace", agentDir: "/original/agent" } },
      },
    };
    const result = await validateUpdateCandidateCanary({
      ...canaryStateOptions(3_000),
      config: original,
      env: {
        [CONTROL_PLANE_UPDATE_SENTINEL_META_ENV]: path.join(root, "live-sentinel.json"),
        [POST_CORE_UPDATE_RESULT_PATH_ENV]: path.join(root, "live-result.json"),
        [POST_CORE_UPDATE_SOURCE_CONFIG_PATH_ENV]: path.join(root, "live-config.json"),
        OPENCLAW_UPDATE_RUN_HANDOFF: "1",
        OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH: path.join(root, "live-doctor-result.json"),
        OPENCLAW_SYSTEMD_UNIT: "source-gateway.service",
        CUSTOM_PROVIDER_KEY: "synthetic-provider-credential",
      },
      onStep: (step) => {
        completed.push({ name: step.name, argv: [...(mocks.spawn.mock.calls.at(-1)?.[1] ?? [])] });
      },
    });
    expect(result.status).toBe("ok");
    expect(result.candidateSchemaVersions).toEqual({ state: 2, agent: 3 });
    expect(result.steps[0]?.snapshotCapacity).toMatchObject({
      sqliteBytes: 0,
      pluginBytes: 0,
      reason: "state-volume",
      selection: { kind: "state-volume" },
    });
    expect(result).not.toHaveProperty("checkpointContinuation");
    expect(result.steps.map((step) => step.name)).toEqual([
      "candidate-state-snapshot",
      "candidate-doctor",
      "candidate-doctor-lint",
      "candidate-config",
      "candidate-plugins",
      "candidate-recovery",
      "candidate-gateway-startup",
      "candidate-state-cleanup",
    ]);
    expect(completed.map((step) => step.name)).toEqual(result.steps.map((step) => step.name));
    // Copy, startup and cleanup are timed receipts for the update report.
    for (const name of [
      "candidate-state-snapshot",
      "candidate-gateway-startup",
      "candidate-state-cleanup",
    ]) {
      expect(result.steps.find((step) => step.name === name)).toMatchObject({
        exitCode: 0,
        durationMs: expect.any(Number),
      });
    }
    expect(completed.at(-2)?.argv.filter((arg) => arg === "--update-canary")).toHaveLength(2);
    expect(
      completed
        .slice(0, -1)
        .map((step) => step.argv.filter((arg) => arg !== "--no-install").slice(1, 3)),
    ).toEqual([
      [],
      ["doctor", "--fix"],
      ["doctor", "--lint"],
      ["config", "validate"],
      ["plugins", "list"],
      ["--check"],
      ["gateway", "run"],
    ]);
    expect(requests).toEqual(["/startupz", "/startupz", "/readyz"]);
    expect(childEnv.OPENCLAW_STATE_DIR).not.toBe(root);
    expect(childEnv).toMatchObject({
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_SKIP_PROVIDERS: "1",
      OPENCLAW_NO_AUTO_UPDATE: "1",
      CUSTOM_PROVIDER_KEY: "synthetic-provider-credential",
    });
    for (const key of [
      CONTROL_PLANE_UPDATE_SENTINEL_META_ENV,
      POST_CORE_UPDATE_RESULT_PATH_ENV,
      POST_CORE_UPDATE_SOURCE_CONFIG_PATH_ENV,
      "OPENCLAW_UPDATE_RUN_HANDOFF",
      "OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH",
      "OPENCLAW_SYSTEMD_UNIT",
    ]) {
      expect(childEnv[key]).toBeUndefined();
    }
    expect(mocks.spawn.mock.calls.find(([, args]) => args.includes("--check"))?.[1]).toEqual([
      ...(process.versions.bun ? ["--no-install"] : []),
      path.join(root, "dist", "infra", "update-migrated-finalize.worker.js"),
      "--check",
    ]);
    expect(candidateConfig).toMatchObject({
      cron: { enabled: false },
      gateway: { bind: "loopback" },
      mcp: { apps: { enabled: false } },
    });
    expect(result.listenerIsolation).toEqual({
      gateway: { host: "127.0.0.1", port: expect.any(Number) },
      mcpAppSandbox: "disabled",
    });
    expect(candidateConfig.gateway).toMatchObject({ port: result.listenerIsolation?.gateway.port });
    expect(original.mcp.apps).toEqual({ enabled: true, sandboxPort: 18790 });
    expect(original.cron.enabled).toBe(true);
    const gatewayPid = [...children.keys()].at(-1)!;
    expect(
      mocks.signal.mock.calls.filter(([pid]) => pid === gatewayPid).map(([, signal]) => signal),
    ).toEqual(["SIGTERM", "SIGKILL"]);
    expect(result.logTail.join("\n")).toContain("startupz: started");
    await expectRemoved(childEnv.OPENCLAW_STATE_DIR!);
  });

  it.each([
    "lint",
    "startup",
    "startup-multiline",
    "startup-tail",
    "config",
    "multiline",
    "envelope",
    "compact",
  ])("retains the failure reason when %s exits before its report", async (scenario) => {
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
          if (["envelope", "compact"].includes(scenario)) {
            child.stdout.write(
              JSON.stringify(
                formatCliJsonFailure(error, { argv: [], env: {} }),
                null,
                scenario === "compact" ? undefined : 2,
              ) + "\n",
            );
          }
          if (scenario === "startup-tail") {
            child.stderr.write("openclaw-update-canary-progress: cli.main.argv\nEarlier warning\n");
            child.stderr.write(`${"x".repeat(20_001)} ${error.message}\n`);
            child.stderr.write("openclaw-update-canary-progress: cli.main.gateway-run-bootstrap\n");
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
          if (["lint", "startup", "config"].includes(scenario)) {
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
    if (!["lint", "config"].includes(scenario)) {
      const output = renderSteps([failed]);
      if (scenario.endsWith("multiline")) {
        expect(output).toContain("gateway.port: invalid");
        expect(output).toContain("gateway.host: unknown");
        expect(updateRunStepsFromResultStep(failed).map((step) => step.detail)).toContainEqual(
          expect.stringContaining(
            scenario === "multiline" ? "gateway.port: invalid" : "Invalid config",
          ),
        );
      } else {
        const report = renderUpdateRunReport(
          updateRunReportInputFromResult({ ...result, mode: "git", root }),
        );
        for (const text of [output, report.markdown]) {
          expect(text).toContain("Unable to resolve health API");
          if (scenario !== "startup-tail") {
            expect(text.match(/Unable to resolve health API/gu)).toHaveLength(1);
          }
        }
        expect(result.logTail.join("\n")).toContain("Unable to resolve health API");
      }
    }
    if (phase === "config") {
      expect(failed.failureFacts?.[0]?.affectedKey).toBe("gateway.port");
    }
    expect(JSON.stringify(result)).not.toContain("synthetic-secret");
  });

  it.each(["snapshot", "readiness"] as const)(
    "records the %s outcome and cleans private state",
    async (failure) => {
      if (failure === "snapshot") {
        const snapshot = mocks.snapshot.getMockImplementation()!;
        mocks.snapshot.mockImplementation(async (command, options: { input: string }) => {
          const request: unknown = JSON.parse(options.input);
          if (isRecord(request) && request.mode === "inventory") {
            return snapshot(command, options);
          }
          const result = createCanarySnapshotResult(options.input, databasePath);
          return { ...result, code: 1, stdout: "", stderr: "snapshot rejected" };
        });
      }
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) =>
          Response.json({ status: "started" }, { status: url.endsWith("readyz") ? 503 : 200 }),
        ),
      );
      const result = await validateUpdateCandidateCanary(canaryStateOptions(250));
      expect(result).toMatchObject({ status: "error", phase: failure });
      if (failure === "readiness") {
        expect(canaryOutcomeStep(result.steps)).toMatchObject({
          exitCode: null,
          termination: "timeout",
          failureFacts: [
            {
              check: "startupz",
              code: "candidate-startup-failed",
              message: "readiness timeout",
            },
          ],
        });
        expect(canaryOutcomeStep(result.steps)?.advisory).toBeUndefined();
        expect(canaryOutcomeStep(result.steps)?.stderrTail).toContain("stalled");
      }
      expect(result.steps.some((step) => step.exitCode !== 0)).toBe(true);
      expect(result.logTail.length).toBeLessThanOrEqual(40);
      expect(result.durationMs).toBeLessThan(1_000);
      if (failure === "snapshot") {
        expect(mocks.spawn).not.toHaveBeenCalled();
      } else {
        expect(mocks.signal).toHaveBeenCalled();
      }
      await expectRemoved(harness.snapshotDirectory());
    },
  );

  it("refuses a candidate that cannot keep Doctor away from managed services", async () => {
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ version: "2026.4.1" }));
    const result = await validateUpdateCandidateCanary(canaryStateOptions());
    expect(result.status).toBe("error");
    expect(mocks.snapshot).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("drains a cancelled validation child before deleting its private state", async () => {
    const controller = new AbortController();
    mocks.spawn.mockImplementationOnce((_command, _args, options) => {
      const child = createChild(undefined, true);
      childEnv = options.env;
      queueMicrotask(() => controller.abort(new Error("repair deadline")));
      return child;
    });
    const options = { ...canaryStateOptions(3_000), signal: controller.signal };
    const result = await validateUpdateCandidateCanary(options);
    expect(result.status).toBe("error");
    expect(mocks.spawn).toHaveBeenCalledOnce();
    expect(mocks.signal.mock.calls.map(([, signal]) => signal)).toEqual(["SIGTERM", "SIGKILL"]);
    await expectRemoved(childEnv.OPENCLAW_STATE_DIR!);
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

  it.each(["sync", "async"])(
    "aborts further validation when %s step recording fails",
    async (mode) => {
      await expect(
        validateUpdateCandidateCanary({
          ...canaryStateOptions(3_000),
          onStep: () => {
            if (mode === "async") {
              return Promise.reject(new Error("ledger unavailable"));
            }
            throw new Error("ledger unavailable");
          },
        }),
      ).rejects.toThrow("ledger unavailable");
      expect(mocks.spawn).not.toHaveBeenCalled();
      const snapshotInput = JSON.parse(mocks.snapshot.mock.calls.at(-1)![1].input) as {
        targetStateDir: string;
      };
      await expect(fs.access(snapshotInput.targetStateDir)).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

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
    mocks.spawn.mockImplementationOnce(() => {
      return createChild((child) => {
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
      });
    });
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
    mocks.spawn.mockImplementationOnce(() => {
      return createChild((child) => {
        child.stderr.write("x".repeat(70_000));
        child.stderr.write("synthetic-sensitive-suffix\nfollowing-safe-line\n");
        child.emit("close", 1);
      });
    });
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
