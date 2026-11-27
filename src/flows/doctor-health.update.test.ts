import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createCliTtyMock } from "../cli/test-runtime-capture.js";
import { UpdateCommandRecoveryPendingError } from "../cli/update-cli/update-command-recovery-error.js";
import { transformConfigFile } from "../config/mutate.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatDeferredPluginMigration } from "../infra/deferred-plugin-migrations.js";
import { DoctorStateMigrationRefusalError } from "../infra/state-migrations.messages.js";
import type { LegacyStateMigrationStepReceipt } from "../infra/state-migrations.types.js";
import * as temporaryState from "../infra/tmp-openclaw-dir.js";
import { DEFERRED_UPDATE_MODEL_RETIREMENT_WARNING } from "../infra/update-deferred-model-retirement.js";
import {
  consumeUpdatePostInstallDoctorResult,
  createUpdatePostInstallDoctorResultPath,
  UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV,
} from "../infra/update-doctor-result.js";
import { createUpdateRunRecordFixture } from "../infra/update-run-record.test-support.js";
import type { UpdateRunResult } from "../infra/update-runner-types.js";
import { ExitError } from "../runtime.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import type { DoctorHealthFlowContext } from "./doctor-health-contributions.js";
import { runDoctorHealthFlow } from "./doctor-health.js";

const mocks = vi.hoisted(() => {
  const handles = {
    offerUpdate:
      vi.fn<typeof import("../commands/doctor-update.js").maybeOfferUpdateBeforeDoctor>(),
    updateCommand: vi.fn<typeof import("../cli/update-cli/update-command.js").updateCommand>(),
    triageCommand: vi.fn(async () => undefined),
    outro: vi.fn(),
    confirmCustody: vi.fn<() => Promise<boolean>>(),
    config: vi.fn<() => OpenClawConfig>(),
    disposeConfig: vi.fn<() => Promise<void>>(async () => undefined),
    runContributions: vi.fn<(ctx: DoctorHealthFlowContext) => Promise<void>>(),
    packageRoot: vi.fn<() => string | undefined>(),
    pendingPluginMigrations:
      vi.fn<
        typeof import("../infra/deferred-plugin-migrations.js").readDeferredPluginMigrationsAsync
      >(),
    doctorUpdateRun:
      vi.fn<typeof import("../infra/update-deferred-model-retirement.js").resolveDoctorUpdateRun>(),
    stateMigrationReceipts: [] as LegacyStateMigrationStepReceipt[],
  };
  const partials = {
    "@clack/prompts": { intro: vi.fn(), note: vi.fn(), outro: handles.outro },
    "../infra/openclaw-root.js": { resolveOpenClawPackageRoot: async () => handles.packageRoot() },
    // This worker-thread lane lacks the shared-state ledger's host broker.
    "../infra/deferred-plugin-migrations.js": {
      readDeferredPluginMigrationsAsync: handles.pendingPluginMigrations,
    },
    "../infra/update-deferred-model-retirement.js": {
      resolveDoctorUpdateRun: handles.doctorUpdateRun,
    },
    "../config/config.js": { CONFIG_PATH: "/tmp/openclaw.json" },
  };
  for (const [module, overrides] of Object.entries(partials)) {
    vi.doMock(module, async (original) => ({ ...(await original<object>()), ...overrides }));
  }
  const replacements = {
    // mock-isolation: dispatch must not execute the updater or external triage agents.
    "../cli/update-cli/update-command.js": { updateCommand: handles.updateCommand },
    "../commands/doctor-update.js": { maybeOfferUpdateBeforeDoctor: handles.offerUpdate },
    "../commands/triage.js": { triageCommand: handles.triageCommand },
    "../commands/doctor/shared/plugin-runtime-symlinks.js": {
      noteStalePluginRuntimeSymlinks: async () => undefined,
    },
    "../commands/doctor-platform-notes.js": { noteStartupOptimizationHints: () => undefined },
    // mock-isolation: outcomes do not need config preparation or plugin resources.
    "../commands/doctor-config-flow.js": {
      loadAndMaybeMigrateDoctorConfig: async () => ({
        [Symbol.asyncDispose]: handles.disposeConfig,
        cfg: handles.config(),
        shouldWriteConfig: true,
        stateMigrationStepReceipts: handles.stateMigrationReceipts,
      }),
    },
    "./doctor-health-contributions.js": { runDoctorHealthContributions: handles.runContributions },
  };
  for (const [module, replacement] of Object.entries(replacements)) {
    vi.doMock(module, () => replacement);
  }
  return handles;
});

vi.mock("../commands/doctor-prompter.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../commands/doctor-prompter.js")>();
  return {
    ...actual,
    createDoctorPrompter: (params: Parameters<typeof actual.createDoctorPrompter>[0]) => ({
      ...actual.createDoctorPrompter(params),
      confirm: async () => true,
      confirmRuntimeRepair: mocks.confirmCustody,
    }),
  };
});

async function withResult(run: (state: OpenClawTestState, resultPath: string) => Promise<void>) {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const resultPath = createUpdatePostInstallDoctorResultPath();
    vi.stubEnv(UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV, resultPath);
    try {
      await run(state, resultPath);
    } finally {
      await consumeUpdatePostInstallDoctorResult(resultPath);
    }
  });
}

function migrationReceipt(
  id: string,
  outcome: LegacyStateMigrationStepReceipt["outcome"],
  overrides: Partial<LegacyStateMigrationStepReceipt> = {},
): LegacyStateMigrationStepReceipt {
  return {
    id,
    outcome,
    phase: "final",
    source: [],
    target: [],
    requiredness: "required",
    reversibility: "checkpoint-required",
    changes: [],
    warnings: [`${id}: run openclaw doctor --fix`],
    ...overrides,
  };
}
const createRuntime = () => ({
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn<(code: number) => void>(),
});
const runDoctor = () => runDoctorHealthFlow(createRuntime(), { nonInteractive: true });

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

beforeEach(async () => {
  // Keep Doctor IPC artifacts and diagnostics in test-owned temporary storage.
  const control = path.join(dirs.make("doctor-update-coordinator-"), "control");
  await fs.mkdir(control, { mode: 0o700 });
  vi.spyOn(temporaryState, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
  // Exercise the adapter independently of the host supervisor policy.
  vi.stubEnv("OPENCLAW_SERVICE_REPAIR_POLICY", undefined);
  vi.stubEnv("OPENCLAW_SUPERVISOR_MODE", undefined);
  vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", undefined);
  mocks.offerUpdate.mockReset().mockResolvedValue(false);
  mocks.confirmCustody.mockReset().mockResolvedValue(true);
  mocks.updateCommand.mockReset();
  mocks.triageCommand.mockReset().mockResolvedValue(undefined);
  mocks.config.mockReset().mockReturnValue({});
  mocks.disposeConfig.mockClear();
  mocks.packageRoot.mockReturnValue(undefined);
  mocks.outro.mockClear();
  mocks.runContributions.mockReset().mockResolvedValue(undefined);
  mocks.pendingPluginMigrations.mockReset().mockResolvedValue([]);
  mocks.doctorUpdateRun.mockReset();
  mocks.stateMigrationReceipts = [];
});

it.each(["completed", "skipped"] as const)(
  "publishes warnings against the Doctor run's retirement receipt (%s)",
  async (status) => {
    await withResult(async (_state, resultPath) => {
      const env = { ...process.env, OPENCLAW_UPDATE_RUN_ID: "selected-update" };
      const warnings = [DEFERRED_UPDATE_MODEL_RETIREMENT_WARNING, "Unrelated advisory"];
      mocks.doctorUpdateRun.mockReturnValue(
        createUpdateRunRecordFixture("selected-update", {
          status: "running",
          steps: [{ step: "finalize:doctor:model-retirement", status }],
        }),
      );
      mocks.runContributions.mockImplementation(async (ctx) => {
        ctx.env = env;
        ctx.updateWarnings = warnings;
      });

      await runDoctor();

      const result = await consumeUpdatePostInstallDoctorResult(resultPath);
      expect(result?.warnings).toEqual(status === "completed" ? warnings.slice(1) : warnings);
      expect(mocks.doctorUpdateRun).toHaveBeenCalledWith(env);
    });
  },
);

it("publishes include input and final write hashes", async () => {
  await withResult(async (state, resultPath) => {
    const includePath = path.join(path.dirname(state.configPath), "logging.json");
    const originalInclude = '{"level":"info"}\n';
    const finalInclude = '{\n  "level": "error"\n}\n';
    await state.writeConfig({
      gateway: { mode: "local" },
      logging: { $include: "./logging.json" },
    });
    await fs.writeFile(includePath, originalInclude);
    const originalRoot = await fs.readFile(state.configPath, "utf8");
    const resolvedInclude = await fs.realpath(includePath);
    mocks.runContributions.mockImplementation(async () => {
      for (const level of ["warn", "error"] as const) {
        await transformConfigFile({
          transform: (config) => ({
            nextConfig: { ...config, logging: { ...config.logging, level } },
          }),
          writeOptions: { skipPluginValidation: true, auditOrigin: "doctor" },
        });
      }
    });

    await runDoctor();
    const result = await consumeUpdatePostInstallDoctorResult(resultPath);
    expect(result).toMatchObject({ status: "ok", configHash: "unchanged" });
    expect(result?.configInputHash).toBeUndefined();
    expect(result?.configFileWrites).toEqual({
      [resolvedInclude]: {
        inputHash: createHash("sha256").update(originalInclude).digest("hex"),
        hash: createHash("sha256").update(finalInclude).digest("hex"),
      },
    });
    await expect(fs.readFile(state.configPath, "utf8")).resolves.toBe(originalRoot);
    await expect(fs.readFile(includePath, "utf8")).resolves.toBe(finalInclude);
  });
});

it.each(["warnings", "refused", "partial", "all", "unreadable"] as const)(
  "publishes current warnings (%s)",
  async (outcome) => {
    await withResult(async (_state, resultPath) => {
      const refused = outcome === "refused";
      const inspecting = refused || outcome === "warnings";
      const refusalFact = {
        check: "plugin-doctor-post-session-state",
        code: "blocked-by-session-repair-failure",
        message:
          "Post-session plugin repair was blocked because prerequisite session repair failed.",
      };
      const deferred = migrationReceipt(
        "deferred cleanup",
        refused ? "refused" : "warning",
        refused ? { id: refusalFact.check, refusal: refusalFact } : {},
      );
      const refusalWarning = `Failing check ${refusalFact.check} (${refusalFact.code}): ${refusalFact.message}`;
      const refusal = new DoctorStateMigrationRefusalError([deferred]);
      const inspectionWarning =
        "core/doctor/auth-profiles [update-inspection-deferred]: Run openclaw doctor after activation.";
      const finding = {
        checkId: "core/doctor/auth-profiles",
        severity: "warning" as const,
        errorCode: "update-inspection-deferred",
        requirement: "update-validation-budget",
        message: "Run openclaw doctor after activation.",
      };
      const plugins = ["acpx", "codex"].map((pluginId) => ({
        pluginId,
        reason: "The installed plugin has not confirmed its saved data and settings.",
        command: "openclaw doctor --fix",
      }));
      if (inspecting) {
        mocks.stateMigrationReceipts.push(
          migrationReceipt("preflight cleanup", "warning"),
          migrationReceipt("skipped audit recovery", "skipped"),
          ...Array.from({ length: refused ? 0 : 30 }, (_, index) =>
            migrationReceipt(`prior migration ${index}`, "warning"),
          ),
        );
        mocks.runContributions.mockImplementation(async (ctx) => {
          expect(mocks.disposeConfig).not.toHaveBeenCalled();
          ctx.updateWarnings = [inspectionWarning];
          ctx.updateBudget = {
            agentCount: 480,
            inspectionDeadlineMs: Date.now(),
            phase: "activation",
            source: "activation-policy",
            deferred: new Map([[finding.checkId, finding]]),
          };
          ctx.configResult.stateMigrationStepReceipts?.push(deferred);
          if (refused) {
            throw refusal;
          }
        });
      } else {
        for (const plugin of plugins) {
          mocks.stateMigrationReceipts.push(
            migrationReceipt(`plugin:${plugin.pluginId}`, "deferred", {
              source: [{ kind: "owner", id: plugin.pluginId }],
              target: [{ kind: "owner", id: plugin.pluginId }],
              requiredness: "conditional",
              warnings: [formatDeferredPluginMigration(plugin)],
            }),
          );
        }
        if (outcome === "unreadable") {
          mocks.pendingPluginMigrations.mockRejectedValue(
            new Error("migration ledger unavailable"),
          );
        } else {
          mocks.pendingPluginMigrations.mockResolvedValue(
            outcome === "all" ? [] : plugins.slice(1),
          );
        }
      }
      const runtime = createRuntime();
      if (inspecting) {
        runtime.exit.mockImplementation((code: number) => {
          throw new ExitError(code);
        });
      }

      if (refused) {
        await expect(runDoctorHealthFlow(runtime, { nonInteractive: true })).rejects.toBe(refusal);
      } else {
        await runDoctorHealthFlow(runtime, { nonInteractive: true });
      }
      if (inspecting) {
        expect(mocks.disposeConfig).toHaveBeenCalledOnce();
      }
      const result = await consumeUpdatePostInstallDoctorResult(resultPath);
      expect(result?.status).toBe(refused ? "error" : "ok");
      if (inspecting) {
        expect(result?.warnings).toHaveLength(refused ? 2 : 32);
        expect(result?.warnings).toContain(inspectionWarning);
      } else {
        const pending =
          outcome === "unreadable" ? plugins : outcome === "all" ? [] : plugins.slice(1);
        expect(result?.warnings ?? []).toEqual(
          pending.map((plugin) => formatDeferredPluginMigration(plugin)),
        );
      }
      if (refused) {
        expect(refusal.message).toContain(refusalWarning);
        expect(result?.failureFacts).toEqual([refusalFact]);
        expect(result?.warnings).toContain(refusalWarning);
        expect(mocks.runContributions.mock.calls[0]?.[0].updateWarnings).toContain(refusalWarning);
      } else if (inspecting) {
        expect(result?.warnings).toContain("preflight cleanup: run openclaw doctor --fix");
      }
    });
  },
);

it.each(["ok", "pending"] as const)("preserves update handoff (%s)", async (outcome) => {
  const { maybeOfferUpdateBeforeDoctor } = await vi.importActual<
    typeof import("../commands/doctor-update.js")
  >("../commands/doctor-update.js");
  mocks.offerUpdate.mockImplementation(maybeOfferUpdateBeforeDoctor);
  // Custody and real SQLite settlement are covered by the managed flow fixture.
  // This owner exercises update handoff and consent ordering without another repair boot.
  const maintenance = await import("../commands/doctor-maintenance.js");
  const beginMaintenance = vi
    .spyOn(maintenance, "beginDoctorMaintenance")
    .mockResolvedValue(undefined);
  const ttyMock = createCliTtyMock([process.stdin]);
  ttyMock.set(true);
  try {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const cfg: OpenClawConfig = { gateway: { mode: "local" } };
      await state.writeConfig(cfg);
      mocks.config.mockReturnValue(cfg);
      mocks.packageRoot.mockReturnValue(process.cwd());
      const updateResult: UpdateRunResult = {
        status: outcome === "pending" ? "error" : outcome,
        mode: "git",
        root: process.cwd(),
        reason: outcome,
        steps: [],
        durationMs: 1,
      };
      const failure = new UpdateCommandRecoveryPendingError("native settlement remains pending");
      mocks.updateCommand.mockImplementation(async ({ onResult }) => {
        onResult?.(updateResult);
        if (outcome === "pending") {
          throw failure;
        }
      });
      const doctor = runDoctorHealthFlow(createRuntime());
      if (outcome === "pending") {
        await expect(doctor).rejects.toBe(failure);
      } else {
        await doctor;
      }
      expect(mocks.updateCommand).toHaveBeenCalledOnce();
      expect(mocks.offerUpdate).toHaveBeenCalledOnce();
      for (const check of [
        mocks.confirmCustody,
        beginMaintenance,
        mocks.config,
        mocks.runContributions,
        mocks.triageCommand,
      ]) {
        expect(check).not.toHaveBeenCalled();
      }
      expect(mocks.outro).not.toHaveBeenCalledWith("Doctor complete.");
      if (outcome === "ok") {
        expect(mocks.outro).toHaveBeenCalledWith(
          "Update completed (doctor already ran as part of the update).",
        );
      }
    });
  } finally {
    ttyMock.restore();
  }
});
