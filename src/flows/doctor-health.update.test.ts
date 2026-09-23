import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { UpdateCommandRecoveryPendingError } from "../cli/update-cli/update-command-recovery-error.js";
import { UpdateCommandFailure } from "../cli/update-cli/update-command-result.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { DoctorStateMigrationRefusalError } from "../infra/state-migrations.messages.js";
import type { LegacyStateMigrationStepReceipt } from "../infra/state-migrations.types.js";
import * as temporaryState from "../infra/tmp-openclaw-dir.js";
import {
  consumeUpdatePostInstallDoctorResult,
  createUpdatePostInstallDoctorResultPath,
  UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV,
} from "../infra/update-doctor-result.js";
import type { UpdateRunResult } from "../infra/update-runner-types.js";
import { ExitError } from "../runtime.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { DoctorHealthFlowContext } from "./doctor-health-contributions.js";
import { runDoctorHealthFlow } from "./doctor-health.js";

const mocks = vi.hoisted(() => ({
  offerUpdate: vi.fn<typeof import("../commands/doctor-update.js").maybeOfferUpdateBeforeDoctor>(),
  updateCommand: vi.fn<typeof import("../cli/update-cli/update-command.js").updateCommand>(),
  triageCommand: vi.fn(async () => undefined),
  outro: vi.fn(),
  config: vi.fn<() => OpenClawConfig>(),
  runContributions: vi.fn<(ctx: DoctorHealthFlowContext) => Promise<void>>(),
  packageRoot: vi.fn<() => string | undefined>(),
  stateMigrationReceipts: [] as LegacyStateMigrationStepReceipt[],
}));

vi.mock("@clack/prompts", () => ({
  intro: vi.fn(),
  note: vi.fn(),
  outro: mocks.outro,
}));

vi.mock("../commands/doctor-prompter.js", () => ({
  createDoctorPrompter: () => ({ confirm: async () => true }),
}));

vi.mock("../infra/openclaw-root.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/openclaw-root.js")>()),
  resolveOpenClawPackageRoot: async () => mocks.packageRoot(),
}));

vi.mock("../cli/update-cli/update-command.js", () => ({
  updateCommand: mocks.updateCommand,
}));

vi.mock("../commands/doctor-update.js", () => ({
  maybeOfferUpdateBeforeDoctor: mocks.offerUpdate,
}));

vi.mock("../commands/triage.js", () => ({
  triageCommand: mocks.triageCommand,
}));

vi.mock("../commands/doctor-ui.js", () => ({
  maybeRepairUiProtocolFreshness: async () => undefined,
}));

vi.mock("../commands/doctor-install.js", () => ({
  noteSourceInstallIssues: () => undefined,
}));

vi.mock("../commands/doctor/shared/plugin-runtime-symlinks.js", () => ({
  noteStalePluginRuntimeSymlinks: async () => undefined,
}));

vi.mock("../commands/doctor-platform-notes.js", () => ({
  noteStartupOptimizationHints: () => undefined,
}));

vi.mock("../commands/doctor-config-flow.js", () => ({
  loadAndMaybeMigrateDoctorConfig: async () => ({
    cfg: mocks.config(),
    shouldWriteConfig: true,
    stateMigrationStepReceipts: mocks.stateMigrationReceipts,
  }),
}));

vi.mock("../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config.js")>()),
  CONFIG_PATH: "/tmp/openclaw.json",
}));

vi.mock("./doctor-health-contributions.js", () => ({
  runDoctorHealthContributions: mocks.runContributions,
}));

describe("runDoctorHealthFlow update outcomes", () => {
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
    mocks.offerUpdate.mockReset().mockResolvedValue({ updated: false });
    mocks.updateCommand.mockReset();
    mocks.triageCommand.mockReset().mockResolvedValue(undefined);
    mocks.config.mockReset().mockReturnValue({});
    mocks.packageRoot.mockReturnValue(undefined);
    mocks.outro.mockClear();
    mocks.runContributions.mockReset().mockResolvedValue(undefined);
    mocks.stateMigrationReceipts = [];
  });

  it.each([
    { refused: false, noisy: false },
    { refused: false, noisy: true },
    { refused: true, noisy: false },
  ])(
    "retains deferred inspection warnings in update IPC (refused=$refused, noisy=$noisy)",
    async ({ refused, noisy }) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const resultPath = createUpdatePostInstallDoctorResultPath();
        vi.stubEnv(UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV, resultPath);
        const receipt = (
          id: string,
          outcome: "warning" | "skipped" | "refused",
        ): LegacyStateMigrationStepReceipt => ({
          id,
          phase: "final",
          source: [],
          target: [],
          requiredness: "required",
          reversibility: "checkpoint-required",
          outcome,
          changes: [],
          warnings: [`${id}: run openclaw doctor --fix`],
        });
        mocks.stateMigrationReceipts.push(receipt("preflight cleanup", "warning"));
        mocks.stateMigrationReceipts.push(receipt("skipped audit recovery", "skipped"));
        if (noisy) {
          mocks.stateMigrationReceipts.push(
            ...Array.from({ length: 30 }, (_, index) =>
              receipt(`prior migration ${index}`, "warning"),
            ),
          );
        }
        const deferred = receipt("deferred cleanup", refused ? "refused" : "warning");
        const refusalFact = {
          check: "plugin-doctor-post-session-state",
          code: "blocked-by-session-repair-failure",
          message:
            "Post-session plugin repair was blocked because prerequisite session repair failed.",
        };
        if (refused) {
          deferred.id = refusalFact.check;
          deferred.refusal = refusalFact;
        }
        const refusalWarning = `Failing check ${refusalFact.check} (${refusalFact.code}): ${refusalFact.message}`;
        const refusal = new DoctorStateMigrationRefusalError([deferred]);
        const inspectionWarning =
          "core/doctor/auth-profiles [update-inspection-deferred]: Run openclaw doctor after activation.";
        mocks.runContributions.mockImplementation(async (ctx) => {
          ctx.updateWarnings = [inspectionWarning];
          ctx.updateBudget = {
            agentCount: 480,
            inspectionDeadlineMs: Date.now(),
            phase: "activation",
            source: "activation-policy",
            deferred: new Map([
              [
                "core/doctor/auth-profiles",
                {
                  checkId: "core/doctor/auth-profiles",
                  severity: "warning",
                  errorCode: "update-inspection-deferred",
                  requirement: "update-validation-budget",
                  message: "Run openclaw doctor after activation.",
                },
              ],
            ]),
          };
          ctx.configResult.stateMigrationStepReceipts?.push(deferred);
          if (refused) {
            throw refusal;
          }
        });
        const runtime = {
          log: vi.fn(),
          error: vi.fn(),
          exit: vi.fn((code: number) => {
            throw new ExitError(code);
          }),
        };

        try {
          if (refused) {
            await expect(runDoctorHealthFlow(runtime, { nonInteractive: true })).rejects.toBe(
              refusal,
            );
          } else {
            await runDoctorHealthFlow(runtime, { nonInteractive: true });
          }
          const result = await consumeUpdatePostInstallDoctorResult(resultPath);
          expect(result?.status).toBe(refused ? "error" : "ok");
          expect(result?.warnings).toHaveLength(refused ? 2 : noisy ? 32 : 4);
          expect(result?.warnings).toContain(inspectionWarning);
          if (refused) {
            expect(refusal.message).toContain(refusalWarning);
            expect(result?.failureFacts).toEqual([refusalFact]);
            expect(result?.warnings).toContain(refusalWarning);
            expect(mocks.runContributions.mock.calls[0]?.[0].updateWarnings).toContain(
              refusalWarning,
            );
          } else {
            expect(result?.warnings).toContain("preflight cleanup: run openclaw doctor --fix");
            if (!noisy) {
              expect(result?.warnings).toEqual(
                expect.arrayContaining([
                  "skipped audit recovery: run openclaw doctor --fix",
                  "deferred cleanup: run openclaw doctor --fix",
                ]),
              );
            }
          }
        } finally {
          await consumeUpdatePostInstallDoctorResult(resultPath);
        }
      });
    },
  );

  it.each(["ok", "skipped", "failed", "pending"] as const)(
    "preserves the canonical %s update outcome before further Doctor checks",
    async (outcome) => {
      const { maybeOfferUpdateBeforeDoctor } = await vi.importActual<
        typeof import("../commands/doctor-update.js")
      >("../commands/doctor-update.js");
      mocks.offerUpdate.mockImplementation(maybeOfferUpdateBeforeDoctor);
      const stdinIsTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
      Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
      try {
        await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
          const cfg: OpenClawConfig = { gateway: { mode: "local" } };
          await state.writeConfig(cfg);
          mocks.config.mockReturnValue(cfg);
          mocks.packageRoot.mockReturnValue(process.cwd());
          const updateResult: UpdateRunResult = {
            status: outcome === "failed" || outcome === "pending" ? "error" : outcome,
            mode: "git",
            root: process.cwd(),
            reason: outcome,
            steps: [],
            durationMs: 1,
          };
          const failure =
            outcome === "pending"
              ? new UpdateCommandRecoveryPendingError("native settlement remains pending")
              : new UpdateCommandFailure(updateResult);
          mocks.updateCommand.mockImplementation(async ({ onResult }) => {
            onResult?.(updateResult);
            if (outcome === "failed" || outcome === "pending") {
              throw failure;
            }
          });
          const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
          const doctor = runDoctorHealthFlow(runtime);
          if (outcome === "failed" || outcome === "pending") {
            await expect(doctor).rejects.toBe(failure);
          } else {
            await doctor;
          }
          expect(mocks.updateCommand).toHaveBeenCalledOnce();
          expect(mocks.config).toHaveBeenCalledTimes(outcome === "skipped" ? 1 : 0);
          expect(mocks.runContributions).toHaveBeenCalledTimes(outcome === "skipped" ? 1 : 0);
          if (outcome === "skipped") {
            expect(mocks.outro).toHaveBeenCalledWith("Doctor complete.");
          } else {
            expect(mocks.outro).not.toHaveBeenCalledWith("Doctor complete.");
          }
          if (outcome === "ok") {
            expect(mocks.outro).toHaveBeenCalledWith(
              "Update completed (doctor already ran as part of the update).",
            );
          }
          expect(mocks.triageCommand).not.toHaveBeenCalled();
        });
      } finally {
        if (stdinIsTty) {
          Object.defineProperty(process.stdin, "isTTY", stdinIsTty);
        } else {
          delete (process.stdin as Partial<typeof process.stdin>).isTTY;
        }
      }
    },
  );
});
