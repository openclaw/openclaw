import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { UpdateCommandRecoveryPendingError } from "../cli/update-cli/update-command-recovery-error.js";
import { UpdateCommandFailure } from "../cli/update-cli/update-command-result.js";
import { withUpdateFailureTriage } from "../cli/update-cli/update-command-triage.js";
import type { DoctorMaintenance } from "../commands/doctor-maintenance-types.js";
import * as doctorMaintenance from "../commands/doctor-maintenance.js";
import { createDoctorPluginMetadataSnapshotScope } from "../commands/doctor/shared/plugin-metadata-snapshot-scope.js";
import { withTriageTerminal } from "../commands/triage.test-support.js";
import { transformConfigFile } from "../config/mutate.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RunGithubCli } from "../infra/github-issue.js";
import { DoctorStateMigrationRefusalError } from "../infra/state-migrations.messages.js";
import type { LegacyStateMigrationStepReceipt } from "../infra/state-migrations.types.js";
import * as temporaryState from "../infra/tmp-openclaw-dir.js";
import {
  consumeUpdatePostInstallDoctorResult,
  createUpdatePostInstallDoctorResultPath,
  UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV,
} from "../infra/update-doctor-result.js";
import type { UpdateRunResult } from "../infra/update-runner-types.js";
import { listPluginDoctorLegacyConfigRules } from "../plugins/doctor-contract-registry.js";
import {
  createPluginCache,
  getPluginCache,
  getPluginCacheRetirementSignal,
  retirePluginCache,
  withPluginCache,
} from "../plugins/plugin-cache.js";
import { loadPluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { createPluginManifestRecordFixture } from "../plugins/plugin-metadata.test-support.js";
import { defaultRuntime, ExitError } from "../runtime.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { DoctorHealthFlowContext } from "./doctor-health-contributions.js";
import { runDoctorHealthFlow } from "./doctor-health.js";

const mocks = vi.hoisted(() => ({
  offerUpdate: vi.fn<typeof import("../commands/doctor-update.js").maybeOfferUpdateBeforeDoctor>(),
  updateCommand: vi.fn<typeof import("../cli/update-cli/update-command.js").updateCommand>(),
  triageCommand: vi.fn(async () => undefined),
  outro: vi.fn(),
  select:
    vi.fn<(params: { options: Array<{ value: string; label: string }> }) => Promise<string>>(),
  confirmReport: vi.fn<() => Promise<boolean>>(),
  runGh: vi.fn<RunGithubCli>(),
  config: vi.fn<() => OpenClawConfig>(),
  configResources: vi.fn<() => Record<string, unknown>>(),
  runContributions: vi.fn<(ctx: DoctorHealthFlowContext) => Promise<void>>(),
  packageRoot: vi.fn<() => string | undefined>(),
  stateMigrationReceipts: [] as LegacyStateMigrationStepReceipt[],
}));

vi.mock("@clack/prompts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@clack/prompts")>()),
  intro: vi.fn(),
  note: vi.fn(),
  outro: mocks.outro,
}));

vi.mock("../commands/configure.shared.js", () => ({
  select: mocks.select,
  confirm: mocks.confirmReport,
}));
vi.mock("../infra/github-issue.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/github-issue.js")>();
  return {
    ...actual,
    submitGithubIssue: (
      issue: Parameters<typeof actual.submitGithubIssue>[0],
      _runGh: unknown,
      hooks: Parameters<typeof actual.submitGithubIssue>[2],
    ) => actual.submitGithubIssue(issue, mocks.runGh, hooks),
    reconcileGithubIssue: (
      issue: Parameters<typeof actual.reconcileGithubIssue>[0],
      _runGh: unknown,
      hooks: Parameters<typeof actual.reconcileGithubIssue>[2],
    ) => actual.reconcileGithubIssue(issue, mocks.runGh, hooks),
  };
});

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
    [Symbol.asyncDispose]: async () => {},
    ...mocks.configResources(),
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
    mocks.configResources.mockReset().mockReturnValue({});
    mocks.packageRoot.mockReturnValue(undefined);
    mocks.outro.mockClear();
    mocks.runContributions.mockReset().mockResolvedValue(undefined);
    mocks.stateMigrationReceipts = [];
  });

  it.each(["success", "contribution-failure", "finish-failure"] as const)(
    "retains plugin contracts through maintenance finalization and retires before release on %s",
    async (outcome) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const rootDir = state.path("plugins", "fixture");
        await fs.mkdir(rootDir, { recursive: true });
        await fs.writeFile(
          path.join(rootDir, "doctor-contract-api.cjs"),
          'module.exports = { legacyConfigRules: [{ path: ["fixture"], message: "retained fixture contract" }] };',
        );
        const borrowedCache = createPluginCache();
        let baseSnapshot: ReturnType<typeof loadPluginMetadataSnapshot> | undefined =
          withPluginCache(borrowedCache, () =>
            loadPluginMetadataSnapshot({ config: {}, env: process.env }),
          );
        await using metadata = createDoctorPluginMetadataSnapshotScope({
          getBaseSnapshot: () => baseSnapshot,
          env: process.env,
        });
        expect(metadata.run({ config: {} }, getPluginCache)).toBe(borrowedCache);
        baseSnapshot = undefined;
        metadata.invalidate();
        const ownedCache = metadata.run({ config: {} }, getPluginCache);
        const events: string[] = [];
        const failure = new Error(`fixture ${outcome}`);
        const readRules = () =>
          metadata.run({ config: {} }, () =>
            listPluginDoctorLegacyConfigRules({
              manifestRegistry: {
                plugins: [
                  createPluginManifestRecordFixture({ id: "fixture", rootDir, origin: "global" }),
                ],
                diagnostics: [],
              },
            }),
          );
        mocks.configResources.mockReturnValue({
          runWithPluginMetadataSnapshot: metadata.run,
          invalidatePluginMetadataSnapshot: metadata.invalidate,
          [Symbol.asyncDispose]: async () => {
            events.push("contracts-retired");
            await metadata[Symbol.asyncDispose]();
          },
        });
        mocks.runContributions.mockImplementation(async (ctx) => {
          events.push("contributions");
          expect(ctx.runWithPluginMetadataSnapshot!({ config: ctx.cfg }, readRules)).toEqual([
            { path: ["fixture"], message: "retained fixture contract" },
          ]);
          if (outcome === "contribution-failure") {
            throw failure;
          }
        });
        const maintenance: DoctorMaintenance = {
          run: (operation) => operation(),
          signal: new AbortController().signal,
          releaseState: async () => {},
          finish: async () => {
            events.push("finish");
            expect(getPluginCacheRetirementSignal(ownedCache).aborted).toBe(false);
            expect(readRules()).toEqual([
              { path: ["fixture"], message: "retained fixture contract" },
            ]);
            if (outcome === "finish-failure") {
              throw failure;
            }
          },
          release: async () => {
            events.push("release");
            expect(getPluginCacheRetirementSignal(ownedCache).aborted).toBe(true);
            expect(getPluginCacheRetirementSignal(borrowedCache).aborted).toBe(false);
          },
        };
        vi.spyOn(doctorMaintenance, "beginDoctorMaintenance").mockResolvedValue(maintenance);
        try {
          const operation = runDoctorHealthFlow(
            { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
            { nonInteractive: true },
          );
          if (outcome === "success") {
            await operation;
          } else {
            await expect(operation).rejects.toBe(failure);
          }
          expect(events).toEqual(["contributions", "finish", "contracts-retired", "release"]);
          expect(getPluginCacheRetirementSignal(ownedCache).aborted).toBe(true);
          expect(getPluginCacheRetirementSignal(borrowedCache).aborted).toBe(false);
        } finally {
          await Promise.all([retirePluginCache(ownedCache), retirePluginCache(borrowedCache)]);
        }
      });
    },
  );

  it("publishes the first include input and last Doctor write through result IPC", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
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
      const resultPath = createUpdatePostInstallDoctorResultPath();
      vi.stubEnv(UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV, resultPath);
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

      try {
        await runDoctorHealthFlow(
          { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
          { nonInteractive: true },
        );
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
      } finally {
        await consumeUpdatePostInstallDoctorResult(resultPath);
      }
    });
  });

  it.each([
    "authentication",
    "rejected",
    "uncertain",
    "thrown",
    "browser",
    "missing-cli-browser",
  ] as const)(
    "retains completed Doctor results across repeated %s uploads until success or explicit exit",
    async (failure) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        vi.stubEnv("OPENCLAW_UPDATE_RUN_HANDOFF", undefined);
        const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => undefined);
        vi.spyOn(defaultRuntime, "error").mockImplementation(() => undefined);
        vi.spyOn(defaultRuntime, "exit").mockImplementation((code) => {
          throw new ExitError(code);
        });
        const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
        const uncertain = failure === "uncertain" || failure === "thrown";
        const browser = failure === "browser" || failure === "missing-cli-browser";
        const actions = browser
          ? ["report", "browser"]
          : ["report", uncertain ? "status" : "report", uncertain ? "dismiss" : "report"];
        mocks.select.mockReset().mockImplementation(async () => {
          expect(mocks.runContributions).toHaveBeenCalledOnce();
          const savedMessage = log.mock.calls
            .map(([value]) => value)
            .findLast(
              (value): value is string =>
                typeof value === "string" && value.includes("Saved sanitized report:"),
            );
          if (savedMessage) {
            const savedPath = savedMessage.slice(
              savedMessage.indexOf("Saved sanitized report: ") + "Saved sanitized report: ".length,
            );
            expect(await fs.readFile(savedPath, "utf8")).toContain("doctor");
          }
          return actions.shift() ?? "dismiss";
        });
        mocks.confirmReport.mockReset().mockResolvedValue(true);
        let authCalls = 0;
        const uploads: string[] = [];
        mocks.runGh.mockReset().mockImplementation(async (args, options) => {
          if (args[0] === "auth") {
            authCalls += 1;
            if (failure === "missing-cli-browser") {
              return { started: false, status: null, errorCode: "ENOENT", stdout: Buffer.alloc(0) };
            }
            return {
              started: true,
              status: browser || (failure === "authentication" && authCalls < 3) ? 1 : 0,
              stdout: Buffer.alloc(0),
            };
          }
          if (args[0] === "issue") {
            return { started: true, status: 1, stdout: Buffer.alloc(0) };
          }
          uploads.push(options.input);
          if (failure === "thrown") {
            throw new Error("Lost upload response");
          }
          return {
            started: true,
            status:
              failure === "uncertain" || (failure === "rejected" && uploads.length < 3) ? 1 : 0,
            stdout: Buffer.from(
              failure === "uncertain"
                ? ""
                : failure === "rejected" && uploads.length < 3
                  ? "HTTP/2.0 422 Unprocessable Entity\n"
                  : "HTTP/2.0 201 Created\nhttps://github.com/openclaw/openclaw/issues/123",
            ),
          };
        });
        const run = vi.fn(async () => {
          await runDoctorHealthFlow(runtime, { nonInteractive: true });
          throw new UpdateCommandFailure({
            status: "error",
            mode: "npm",
            reason: "post-install-doctor-failed",
            durationMs: 1,
            steps: [
              {
                name: "doctor",
                command: "openclaw doctor",
                cwd: process.cwd(),
                durationMs: 1,
                exitCode: 1,
              },
            ],
          });
        });
        await withTriageTerminal(true, async () => {
          await expect(
            withUpdateFailureTriage({}, { env: process.env }, run),
          ).rejects.toMatchObject({ code: 1 });
        });
        expect(run).toHaveBeenCalledOnce();
        expect(mocks.runContributions).toHaveBeenCalledOnce();
        for (const [menuIndex, [menu]] of mocks.select.mock.calls.entries()) {
          expect(menu.options.some((option) => option.value === "browser")).toBe(
            menuIndex > 0 && !uncertain,
          );
          if (uncertain && menuIndex > 0) {
            expect(menu.options.find((option) => option.value === "status")?.label).toBe(
              "Check report status",
            );
            expect(menu.options.some((option) => option.value === "report")).toBe(false);
          }
        }
        expect(mocks.select).toHaveBeenCalledTimes(browser ? 2 : 3);
        const previews = log.mock.calls
          .map(([value]) => value)
          .filter(
            (value): value is string =>
              typeof value === "string" && value.startsWith("# OpenClaw update failure report"),
          );
        expect(previews).toHaveLength(uncertain || browser ? 2 : 3);
        expect(new Set(previews).size).toBe(1);
        expect(previews[0]).toContain("doctor");
        expect(uploads).toHaveLength(browser ? 0 : failure === "rejected" ? 3 : 1);
        expect(new Set(uploads).size).toBe(browser ? 0 : 1);
        if (browser) {
          expect(authCalls).toBe(1);
          expect(log).toHaveBeenCalledWith(
            expect.stringContaining(
              "Prefilled issue: https://github.com/openclaw/openclaw/issues/new?",
            ),
          );
        } else {
          expect(log).not.toHaveBeenCalledWith(expect.stringContaining("Prefilled issue:"));
        }
        if (uncertain || browser) {
          expect(log).not.toHaveBeenCalledWith(expect.stringContaining("Created GitHub issue:"));
        } else {
          expect(log).toHaveBeenCalledWith(
            "Created GitHub issue: https://github.com/openclaw/openclaw/issues/123",
          );
        }
      });
    },
  );

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
