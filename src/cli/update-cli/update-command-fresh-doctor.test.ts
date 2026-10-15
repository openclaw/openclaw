import { writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createConfigIO } from "../../config/io.js";
import type { readDeferredPluginMigrationsAsync } from "../../infra/deferred-plugin-migrations.js";
import * as tempRoot from "../../infra/tmp-openclaw-dir.js";
import {
  createDeferredConfiguredPluginRepairDoctorResult,
  UPDATE_POST_INSTALL_DOCTOR_ADVISORY_EXIT_CODE,
  UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV,
  writeUpdatePostInstallDoctorResult,
} from "../../infra/update-doctor-result.js";
import { createUpdateRun, recordUpdateRunStep } from "../../infra/update-run-ledger.js";
import { updateRunStepsFromResultStep } from "../../infra/update-run-step.js";
import { recordCommandProcessFailure } from "../../process/exec-result.js";
import type { CommandOptions } from "../../process/exec.js";
import { defaultRuntime } from "../../runtime.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { removePreparedWorkerOwnershipColumns } from "../../state/openclaw-state-schema-v17.test-support.js";
import type { UpdateCommandOptions } from "./shared.js";
import {
  createChangedPostCoreUpdateOptions,
  createConfigValidationFailure,
} from "./update-cli-config.test-support.js";
import { registerFreshDoctorDiagnosticTests } from "./update-command-fresh-doctor-diagnostics.test-support.js";
import { registerFreshDoctorOutcomeTests } from "./update-command-fresh-doctor-outcomes.test-support.js";

const mocks = vi.hoisted(() => ({
  readConfig: vi.fn(),
  resolveEntrypoint: vi.fn(),
  command: vi.fn(),
  runUtf8: vi.fn<typeof import("../../process/exec.js").runUtf8CommandWithTimeout>(),
  pendingMigrations: vi.fn<typeof readDeferredPluginMigrationsAsync>(),
}));

vi.mock("../../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/config.js")>()),
  readConfigFileSnapshot: mocks.readConfig,
}));

vi.mock("../../daemon/gateway-entrypoint.js", () => ({
  resolveGatewayInstallEntrypoint: mocks.resolveEntrypoint,
}));

vi.mock("../../infra/deferred-plugin-migrations.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/deferred-plugin-migrations.js")>()),
  readDeferredPluginMigrationsAsync: mocks.pendingMigrations,
}));

vi.mock("../../process/exec.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../process/exec.js")>();
  return {
    ...actual,
    runExec: (...args: Parameters<typeof actual.runExec>) =>
      args[1].includes("config") && args[1].includes("validate")
        ? mocks.command(...args)
        : actual.runExec(...args),
    runUtf8CommandWithTimeout: async (
      ...args: Parameters<typeof actual.runUtf8CommandWithTimeout>
    ) => {
      if (args[0].includes("doctor") && args[0].includes("--repair")) {
        const [command, ...argv] = args[0];
        return {
          ...(await mocks.command(command, argv, args[1]).catch((error: unknown) => {
            // The fixture performs no native spawn; preserve its diagnostic rejection.
            throw recordCommandProcessFailure(error, {
              code: 1,
              cleanup: "normal",
              termination: "exit",
            });
          })),
          code: 0,
          signal: null,
          killed: false,
          cleanup: "normal",
          termination: "exit",
        };
      }
      return args[0].includes("doctor") && args[0].includes("--lint")
        ? mocks.runUtf8(...args)
        : actual.runUtf8CommandWithTimeout(...args);
    },
  };
});

vi.mock("../../runtime.js", () => ({
  defaultRuntime: { error: vi.fn(), log: vi.fn() },
}));

vi.mock("./shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./shared.js")>()),
  resolveNodeRunner: vi.fn(() => "/usr/bin/node"),
}));

import {
  completePostCorePluginUpdate,
  runUpdateFinalizationDoctorInFreshProcess,
} from "./update-command-fresh-doctor.js";

const updateOptions = createChangedPostCoreUpdateOptions({
  root: "/opt/openclaw",
  timeoutMs: 5_000,
});
const pluginUpdate = updateOptions.pluginUpdate;
pluginUpdate.npm = { changed: false, outcomes: [] };

const validConfigSnapshot = {
  exists: true,
  valid: true as const,
  parsed: {},
  config: {},
  runtimeConfig: {},
  sourceConfig: {},
  warnings: [],
  issues: [],
  legacyIssues: [],
};

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let restoreTempRoot = () => {};
const readinessExit = {
  code: 0,
  signal: null,
  killed: false,
  termination: "exit",
  outputLimitExceeded: undefined,
  stderr: "",
} as const;

afterEach(() => {
  restoreTempRoot();
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
});

describe("post-plugin update readiness", () => {
  beforeEach(() => {
    const coordinator = vi
      .spyOn(tempRoot, "resolvePreferredOpenClawTmpDir")
      .mockReturnValue(tempDirs.make("fresh-doctor-coordinator-"));
    restoreTempRoot = () => coordinator.mockRestore();
    mocks.readConfig.mockReset().mockResolvedValue(validConfigSnapshot);
    mocks.resolveEntrypoint.mockReset().mockResolvedValue("/opt/openclaw/dist/index.js");
    mocks.command.mockReset().mockResolvedValue({ stdout: "", stderr: "" });
    mocks.pendingMigrations.mockReset().mockResolvedValue([]);
    mocks.runUtf8.mockReset().mockResolvedValue({
      ...readinessExit,
      stdout: JSON.stringify({ ok: true, checksRun: 1, checksSkipped: 0, findings: [] }),
    });
  });

  it.each([
    { phase: "post-plugin", kind: "deferred", reason: "coordinator-contention" },

    { phase: "post-plugin", kind: "data-at-risk", reason: "unreadable-state" },
  ] as const)("preserves $phase $kind maintenance refusal: $reason", async ({ kind, reason }) => {
    const refusal = { kind, reason };
    const warning =
      "Doctor maintenance is deferred; stop other OpenClaw processes and run openclaw doctor --fix.";
    const childFailure = Object.assign(new Error("Doctor exited with unsafe maintenance."), {
      exitCode: 1,
    });
    const onWarnings = vi.fn();
    mocks.command.mockImplementationOnce(async (_command, _args, options) => {
      await fs.writeFile(
        options.env[UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV],
        JSON.stringify(
          kind === "deferred"
            ? { status: "ok", warnings: [warning], maintenanceRefusal: refusal }
            : { status: "error", failureFacts: [], maintenanceRefusal: refusal },
        ),
      );
      if (kind === "data-at-risk") {
        throw childFailure;
      }
      return { stdout: "", stderr: "" };
    });
    const run = completePostCorePluginUpdate({ ...updateOptions, onWarnings });
    await expect(run).rejects.toMatchObject(
      kind === "deferred"
        ? { refusal, message: warning }
        : { name: "DoctorMaintenanceRefusalError", refusal, cause: childFailure },
    );
    if (kind === "deferred") {
      expect(onWarnings).toHaveBeenCalledExactlyOnceWith([warning]);
    }
    expect(mocks.command).toHaveBeenCalledOnce();
    expect(mocks.runUtf8).not.toHaveBeenCalled();
    expect(mocks.readConfig).not.toHaveBeenCalled();
  });

  it.each(["revoked", ""])(
    "refuses invalid Doctor authority %j without retrying",
    async (runId) => {
      const isCurrent = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
      const revoked = runId === "revoked";
      const opts: UpdateCommandOptions = {
        run: {
          runId: revoked ? "live-run" : runId,
          env: {},
          executorFence: { assertCurrent: vi.fn() },
          ...(revoked ? { requesterAuthority: { requester: {}, isCurrent } } : {}),
        },
      };
      await expect(
        revoked
          ? completePostCorePluginUpdate({ ...updateOptions, opts })
          : runUpdateFinalizationDoctorInFreshProcess({
              ...updateOptions,
              opts,
              phase: "post-plugin",
            }),
      ).rejects.toThrow(revoked ? "requester-revoked" : "original update executor");
      if (revoked) {
        expect(isCurrent).toHaveBeenCalledTimes(1);
      }
      expect(mocks.command).not.toHaveBeenCalled();
    },
  );

  it.each([
    { phase: "pre-plugin", operatorPolicy: undefined, timeout: "3", expected: 3_000 },
  ] as const)(
    "keeps parent service authority and the operator deadline in $phase Doctor ($operatorPolicy, $timeout)",
    async ({ phase, operatorPolicy, timeout, expected }) => {
      vi.stubEnv("OPENCLAW_SERVICE_REPAIR_POLICY", operatorPolicy);
      const { runExec } =
        await vi.importActual<typeof import("../../process/exec.js")>("../../process/exec.js");
      mocks.command.mockImplementationOnce(async (_command, _args, options) => {
        const result = await runExec(
          process.execPath,
          [
            "-e",
            "process.stdout.write(JSON.stringify({ policy: process.env.OPENCLAW_SERVICE_REPAIR_POLICY, repair: process.env.OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR, activation: process.env.OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION }))",
          ],
          options,
        );
        expect(JSON.parse(result.stdout)).toEqual({
          policy: "external",
          repair: "0",
          activation: "0",
        });
        return result;
      });
      await runUpdateFinalizationDoctorInFreshProcess({
        ...updateOptions,
        phase,
        opts: { timeout },
        root: tempDirs.make("fresh-doctor-policy-"),
      });
      expect(mocks.command).toHaveBeenCalledExactlyOnceWith(
        "/usr/bin/node",
        expect.arrayContaining(["doctor", "--repair"]),
        expect.objectContaining({ timeoutMs: expected }),
      );
    },
  );

  it.each([
    "advisory",

    "post-plugin-timeout",
  ] as const)(
    "records the fresh Doctor's traced sections without printing the trace (%s)",
    async (outcome) => {
      const phase = outcome.startsWith("post-plugin-") ? "post-plugin" : "pre-plugin";
      vi.stubEnv("OPENCLAW_GATEWAY_STARTUP_TRACE", undefined);
      vi.mocked(defaultRuntime.error).mockClear();
      const stderr = [
        "[gateway] startup trace: doctor.config-flow 4100.0ms total=4200.0ms start=100.0ms\n",
        "real Doctor warning\n",
        "[gateway] startup trace: doctor.contribution.doctor:plugins 2500.0ms total=6800.0ms start=4300.0ms\n",
        "[gateway] startup trace: doctor.contributions 2600.0ms total=6900.0ms start=4300.0ms",
      ].join("");
      let traceEnv: string | undefined;
      mocks.command.mockImplementationOnce(async (_command, _args, options: CommandOptions) => {
        traceEnv = options.env?.OPENCLAW_GATEWAY_STARTUP_TRACE;
        const bytes = Buffer.from(stderr);
        for (let offset = 0; offset < bytes.length; offset += 11) {
          options.onOutputChunk?.(bytes.subarray(offset, offset + 11), "stderr");
        }
        if (outcome === "advisory") {
          await writeUpdatePostInstallDoctorResult({
            resultPath: options.env![UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV]!,
            result: {
              ...createDeferredConfiguredPluginRepairDoctorResult(["Plugin repair deferred"]),
              deferredInspectionCheckIds: ["core/doctor/new-target-inspection"],
            },
          });
        }
        throw Object.assign(new Error("Doctor did not finish"), {
          failed: true,
          exitCode:
            outcome === "advisory"
              ? UPDATE_POST_INSTALL_DOCTOR_ADVISORY_EXIT_CODE
              : outcome.endsWith("exit")
                ? 23
                : undefined,
          timedOut: outcome.endsWith("timeout"),
          stderr,
        });
      });
      const onDoctorStep = vi.fn();
      const pending = runUpdateFinalizationDoctorInFreshProcess({
        ...updateOptions,
        phase,
        onDoctorStep,
        root: tempDirs.make("fresh-doctor-sections-"),
      });
      if (phase === "post-plugin") {
        await expect(pending).resolves.toMatchObject({ reason: "doctor-advisory" });
      } else {
        await pending;
      }

      expect(traceEnv).toBe("1");
      expect(onDoctorStep).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          name: `${phase} doctor`,
          deferredInspectionCheckIds:
            outcome === "advisory" ? ["core/doctor/new-target-inspection"] : null,
          exitCode: outcome === "advisory" ? UPDATE_POST_INSTALL_DOCTOR_ADVISORY_EXIT_CODE : null,
          durationMs: expect.any(Number),
          diagnostics: [
            "Doctor sections: config-flow 4.1 s, contributions 2.6 s; slowest contributions: plugins 2.5 s",
          ],
        }),
      );
      const step = onDoctorStep.mock.calls[0]![0];
      expect(updateRunStepsFromResultStep(step)[0]?.status).toBe(
        outcome === "advisory" || phase === "post-plugin" ? "completed" : "failed",
      );
      expect(defaultRuntime.error).toHaveBeenCalledExactlyOnceWith("real Doctor warning");
    },
  );

  it.each([{ name: "shared", shared: true, agent: undefined, budget: 2_860_000 }])(
    "budgets $name stores after migration without scanning unrelated agents",
    async ({ shared, agent, budget }) => {
      const stateDir = tempDirs.make("post-plugin-budget-");
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      const configured = agent === "configured";
      const agentsDir = path.join(stateDir, "agents");
      const databases = [
        ...(shared ? [resolveOpenClawStateSqlitePath(process.env)] : []),
        ...(agent ? [path.join(agentsDir, agent, "agent", "openclaw-agent.sqlite")] : []),
      ];
      const bytes = ((configured ? 2 : 1) * 1024 ** 3) / databases.length;
      for (const databasePath of databases) {
        await fs.mkdir(path.dirname(databasePath), { recursive: true });
        await fs.writeFile(databasePath, "");
        await fs.truncate(databasePath, bytes);
        if (!configured) {
          await fs.writeFile(`${databasePath}-wal`, "");
        }
      }
      if (configured) {
        mocks.readConfig.mockResolvedValue({
          ...validConfigSnapshot,
          sourceConfig: { agents: { entries: { configured: {} } } },
        });
      }
      mocks.command.mockImplementationOnce(async () => {
        if (!configured) {
          for (const databasePath of databases) {
            await fs.truncate(`${databasePath}-wal`, bytes);
          }
        }
        return { stdout: "", stderr: "" };
      });
      const readdir = fs.readdir;
      const enumeration = vi.spyOn(fs, "readdir").mockImplementation((...args) => {
        if (configured && args[0] === agentsDir) {
          return Promise.reject(
            Object.assign(new Error("agent enumeration denied"), { code: "EACCES" }),
          );
        }
        return readdir(...args);
      });
      try {
        const result = await completePostCorePluginUpdate({
          ...updateOptions,
          pluginUpdate: { ...pluginUpdate, changed: !configured },
          timeoutMs: undefined,
        });
        expect(result.pluginUpdate.status).toBe("ok");
        expect(mocks.command.mock.calls.map((call) => call[2].timeoutMs)).toEqual(
          configured ? [budget] : [undefined, budget],
        );
        expect(mocks.runUtf8.mock.calls[0]?.[1]).toMatchObject({ timeoutMs: budget });
        if (configured) {
          expect(enumeration).not.toHaveBeenCalledWith(agentsDir, { withFileTypes: true });
        }
      } finally {
        enumeration.mockRestore();
      }
    },
  );

  it("runs recorded deferred retirement when plugins are unchanged", async () => {
    await withTempHome(async () => {
      const run = createUpdateRun({ trigger: "cli" });
      vi.stubEnv("OPENCLAW_UPDATE_RUN_ID", run.runId);
      recordUpdateRunStep(run.runId, {
        step: "finalize:doctor:model-retirement",
        status: "skipped",
        detail: "Model retirement repair deferred until plugin convergence.",
      });
      const beforeDoctor = vi.fn(async () => undefined);

      await completePostCorePluginUpdate({
        ...updateOptions,
        pluginUpdate: { ...pluginUpdate, changed: false },
        beforeDoctor,
      });

      expect(beforeDoctor).toHaveBeenCalledOnce();
      expect(beforeDoctor.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.command.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
      );
      expect(mocks.command.mock.calls[0]?.[1]).toEqual([
        "/opt/openclaw/dist/index.js",
        "doctor",
        "--repair",
        "--non-interactive",
        "--no-workspace-suggestions",
        "--yes",
      ]);
      expect(mocks.command.mock.calls[0]?.[2]).toMatchObject({
        env: { OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: "1" },
      });
    });
  });

  it.each([{ changed: true, created: true }])(
    "validates only authored config after Doctor (plugins changed=$changed, created=$created)",
    async ({ changed, created }) => {
      await withTempHome(async (home) => {
        const configPath = path.join(home, ".openclaw", "openclaw.json");
        const io = createConfigIO({ configPath, observe: false });
        mocks.readConfig.mockImplementation(() => io.readConfigFileSnapshot());
        mocks.command.mockImplementation(async (_command, args: string[]) => {
          if (created && args.includes("--repair")) {
            await fs.mkdir(path.dirname(configPath), { recursive: true });
            await fs.writeFile(configPath, '{"gateway":{"mode":"invalid"}}');
          }
          if (args.includes("validate")) {
            if (!created) {
              throw new Error("Config file not found");
            }
            throw createConfigValidationFailure(
              [{ path: "gateway.mode", message: "Invalid gateway mode" }],
              "Config invalid",
            );
          }
          return { stdout: "", stderr: "" };
        });
        const result = await completePostCorePluginUpdate({
          ...updateOptions,
          pluginUpdate: { ...pluginUpdate, changed },
        });
        expect(result.configSnapshot).toMatchObject({ exists: created, valid: !created });
        if (created) {
          expect(result.pluginUpdate).toMatchObject({
            status: "error",
            reason: "post-plugin-doctor-invalid-config",
            failureFacts: [
              {
                check: "config",
                code: "candidate-config-failed",
                affectedKey: "gateway.mode",
                message: "Invalid gateway mode",
              },
            ],
          });
        } else {
          expect(result.pluginUpdate.status).toBe("ok");
          expect(mocks.runUtf8).toHaveBeenCalledOnce();
          await expect(fs.stat(configPath)).rejects.toMatchObject({ code: "ENOENT" });
        }
      });
    },
  );

  it.each([{ name: "signal", signal: "SIGTERM", isTerminated: true }])(
    "retains a config validation $name as an execution failure",
    async (failure) => {
      mocks.command.mockRejectedValueOnce(
        Object.assign(new Error("private argv must not be copied"), {
          failed: true,
          exitCode: 1,
          stdout: JSON.stringify({ valid: false, issues: [{ message: "Unconfirmed issue" }] }),
          ...failure,
        }),
      );
      vi.mocked(defaultRuntime.log).mockClear();
      vi.mocked(defaultRuntime.error).mockClear();

      const { pluginUpdate: result } = await completePostCorePluginUpdate({
        ...updateOptions,
        pluginUpdate: { ...pluginUpdate, changed: false },
      });

      expect(result).toMatchObject({
        status: "error",
        reason: "post-plugin-config-validation-execution-failed",
        warnings: [
          expect.objectContaining({
            message: "Config validation could not complete; refusing to restart.",
          }),
        ],
        failureFacts: [
          expect.objectContaining({ code: "post-plugin-config-validation-execution-failed" }),
          expect.objectContaining({ code: "command-failed" }),
        ],
      });
      expect(JSON.stringify(result)).not.toContain("private argv");
      expect(JSON.stringify(result)).not.toContain("doctor --fix");
      expect(mocks.runUtf8).not.toHaveBeenCalled();
      expect(defaultRuntime.log).not.toHaveBeenCalled();
      expect(defaultRuntime.error).not.toHaveBeenCalled();
    },
  );

  it.each(["entrypoint"] as const)(
    "preserves a Doctor %s failure before child repair",
    async (failure) => {
      const missing = failure === "entrypoint";
      const beforeDoctor = vi.fn(async () => {
        throw new Error("Gateway owner changed");
      });
      if (missing) {
        mocks.resolveEntrypoint.mockResolvedValue(undefined);
        mocks.readConfig.mockResolvedValue({ ...validConfigSnapshot, valid: false });
      }
      const { pluginUpdate: result } = await completePostCorePluginUpdate({
        ...updateOptions,
        beforeDoctor,
      });
      expect(result).toMatchObject({
        status: "error",
        reason: "post-plugin-doctor-execution-failed",
        warnings: [
          expect.objectContaining({
            reason: expect.stringContaining(
              missing ? "entrypoint not found" : "Gateway owner changed",
            ),
          }),
        ],
      });
      if (missing) {
        expect(JSON.stringify(result)).not.toContain("invalid-config");
        expect(mocks.command).not.toHaveBeenCalled();
        expect(mocks.runUtf8).not.toHaveBeenCalled();
      } else {
        expect(beforeDoctor).toHaveBeenCalledOnce();
        expect(mocks.command.mock.calls.some(([, args]) => args.includes("--repair"))).toBe(false);
      }
    },
  );

  registerFreshDoctorOutcomeTests(mocks, updateOptions);

  registerFreshDoctorDiagnosticTests({ mocks, tempDirs, updateOptions });

  it("preserves the older target database when reading post-update config context", async () => {
    const stateDir = tempDirs.make("openclaw-post-update-target-schema-");
    const configPath = path.join(stateDir, "openclaw.json");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
    writeFileSync(configPath, JSON.stringify({ gateway: { mode: "local" } }));
    const filename = openOpenClawStateDatabase({ env: process.env }).path;
    closeOpenClawStateDatabaseForTest();
    const db = new DatabaseSync(filename);
    try {
      removePreparedWorkerOwnershipColumns(db);
      db.exec(
        "PRAGMA user_version=16; UPDATE schema_meta SET schema_version=16, app_version='2026.9.2'",
      );
      const beforeSchema = db.prepare("SELECT * FROM sqlite_schema ORDER BY name").all();
      const beforeMeta = db.prepare("SELECT * FROM schema_meta").all();
      const configOwner =
        await vi.importActual<typeof import("../../config/config.js")>("../../config/config.js");
      mocks.readConfig.mockImplementation(configOwner.readConfigFileSnapshot);

      const result = await completePostCorePluginUpdate({
        ...updateOptions,
        pluginUpdate: { ...pluginUpdate, changed: false },
      });

      expect(result.pluginUpdate.status).toBe("ok");
      expect(result.configSnapshot.config.gateway?.mode).toBe("local");
      expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 16 });
      expect(db.prepare("SELECT * FROM schema_meta").all()).toEqual(beforeMeta);
      expect(db.prepare("SELECT * FROM sqlite_schema ORDER BY name").all()).toEqual(beforeSchema);
    } finally {
      db.close();
    }
  });

  it.each([
    {
      exists: false,
      source: "memory-core",
      checkId: "memory-core/managed-local-embedding-setup",
      message: "Managed local embeddings are unavailable.",
      fixHint: "Run `openclaw models --agent main auth login --provider llama-cpp --method local`.",
      severity: "error",
    },
  ] as const)(
    "preserves readiness $severity for $checkId (config exists: $exists)",
    async ({ exists, source, checkId, message, fixHint, severity }) => {
      const failed = severity === "error";
      mocks.readConfig.mockResolvedValue({ ...validConfigSnapshot, exists });
      const finding = { checkId, severity, ...(source ? { source } : {}), message, fixHint };
      mocks.runUtf8.mockResolvedValue({
        ...readinessExit,
        code: failed ? 1 : 0,
        stdout: JSON.stringify({
          ok: !failed,
          checksRun: 1,
          checksSkipped: 0,
          findings: failed ? [finding] : [],
          warnings: failed ? [] : [finding],
        }),
      });
      const result = await completePostCorePluginUpdate(updateOptions);
      expect(result.pluginUpdate).toMatchObject({
        status: severity,
        ...(failed
          ? { reason: "post-plugin-update-readiness-failed" }
          : { doctorLint: { exitCode: 0, termination: "exit", signal: null, killed: false } }),
        warnings: [
          {
            ...(source ? { pluginId: source } : {}),
            reason: failed ? checkId : "doctor-advisory",
            message,
            guidance: [fixHint],
          },
        ],
      });
    },
  );

  it.each([
    { label: "malformed output", stdout: "{not-json\n", code: 0, launch: false },
    {
      label: "no declared check",
      stdout: JSON.stringify({ ok: true, checksRun: 0, checksSkipped: 0, findings: [] }),
      code: 0,
      launch: false,
    },

    { label: "failed partial output", stdout: "{unfinished", code: 2, launch: false },
  ])("fails closed and retains diagnostics for $label", async ({ stdout, code, launch }) => {
    if (launch) {
      mocks.runUtf8.mockRejectedValue(new Error("Readiness executable unavailable"));
    } else {
      mocks.runUtf8.mockResolvedValue({
        ...readinessExit,
        code,
        stdout,
        stderr:
          code === 2
            ? "Earlier diagnostic line\n".repeat(100) +
              "Could not load readiness plugin https://example.test/diagnostic?token=fixture-secret"
            : "",
      });
    }
    const { pluginUpdate: result } = await completePostCorePluginUpdate(updateOptions);
    expect(result).toMatchObject({
      status: "error",
      reason: "post-plugin-update-readiness-execution-failed",
    });
    if (launch) {
      expect(result).toMatchObject({
        doctorLint: { exitCode: null },
        warnings: [expect.objectContaining({ reason: "Error: Readiness executable unavailable" })],
      });
    } else if (code === 0) {
      expect(result.warnings).toEqual([
        expect.objectContaining({
          message: "Updated plugin readiness checks could not be completed before restart.",
        }),
      ]);
    } else {
      const reason = result.warnings?.[0]?.reason;
      expect(reason).toContain("code=2");
      expect(reason).toContain("stderr:");
      expect(reason).toContain("Could not load readiness plugin");
      expect(reason).toContain("token=<redacted>");
      expect(reason).not.toContain("fixture-secret");
      expect(reason).not.toContain("/opt/openclaw/dist/index.js");
      expect(reason?.length).toBeLessThan(600);
      expect(result.doctorLint?.stderrTail).toContain("token=<redacted>");
      expect(result.doctorLint?.stderrTail).not.toContain("fixture-secret");
    }
  });

  it.each([
    { name: "policy exit", physical: { code: 1 }, accepted: true },

    {
      name: "overflow",
      physical: {
        code: 1,
        termination: "signal",
        signal: "SIGTERM",
        killed: true,
        outputLimitExceeded: true,
      },
      accepted: false,
    },
  ] as const)(
    "retains physical $name facts without accepting interrupted policy output",
    async ({ physical, accepted }) => {
      const finding = {
        checkId: "core/doctor/security",
        severity: "error",
        message: "Discord DMs are open.",
      };
      const execution = {
        ...readinessExit,
        ...physical,
        stdout: JSON.stringify({ ok: false, checksRun: 1, findings: [finding] }),
        stderr: "Readiness diagnostic",
      };
      mocks.runUtf8.mockResolvedValue(execution);

      const { pluginUpdate: result } = await completePostCorePluginUpdate(updateOptions);

      expect(result.status).toBe(accepted ? "warning" : "error");
      expect(result.doctorLint).toMatchObject({
        exitCode: execution.code,
        termination: execution.termination,
        signal: execution.signal,
        killed: execution.killed,
        outputLimitExceeded: execution.outputLimitExceeded,
        stderrTail: execution.stderr,
        doctorLintFindings: [{ ...finding, severity: "warning" }],
      });
      expect(result.doctorLint?.advisory?.kind).toBe(
        accepted ? "recoverable-maintenance" : undefined,
      );
    },
  );
});
