import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { recordDeferredPluginMigrations } from "../infra/deferred-plugin-migrations.js";
import { resolveInstallationTarget } from "../infra/installation-target-context.js";
import { readPackageVersion } from "../infra/package-json.js";
import { readRestartSentinelReadOnly, writeRestartSentinel } from "../infra/restart-sentinel.js";
import {
  acknowledgeAbandonedUpdateRun,
  createUpdateRun,
  finishUpdateRun,
  getUpdateRun,
  recordUpdateRunStep,
} from "../infra/update-run-ledger.js";
import { triageCommand } from "./triage.js";
import { createTriageRuntime, withTriageTerminal } from "./triage.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
vi.mock("@clack/prompts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@clack/prompts")>()),
  confirm: mocks.confirm,
}));
const mocks = vi.hoisted(() => ({
  confirm: vi.fn(),
  collectDoctorFindings: vi.fn(),
  runUpdateRepairLoop: vi.fn(),
  runUtf8CommandWithTimeout: vi.fn(),
  resolveGatewayInstallEntrypoint: vi.fn(),
  prepareUpdateRepairInference: vi.fn(),
  runUpdateRepairTurn: vi.fn(),
}));
vi.mock("./doctor-lint-runner.js", () => ({ collectDoctorFindings: mocks.collectDoctorFindings }));
vi.mock("../infra/update-repair-agent.js", () => ({
  runUpdateRepairLoop: mocks.runUpdateRepairLoop,
}));
vi.mock("../infra/update-repair-agent.runtime.js", () => ({
  prepareUpdateRepairInference: mocks.prepareUpdateRepairInference,
  runUpdateRepairTurn: mocks.runUpdateRepairTurn,
  withUpdateRepairEnvironment: <T>(_target: unknown, run: () => Promise<T>) => run(),
}));
vi.mock("../infra/executable-path.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/executable-path.js")>()),
  resolveExecutablePath: () => undefined,
}));
vi.mock("../process/exec.js", () => ({
  runUtf8CommandWithTimeout: mocks.runUtf8CommandWithTimeout,
}));
vi.mock("../daemon/gateway-entrypoint.js", () => ({
  resolveGatewayInstallEntrypoint: mocks.resolveGatewayInstallEntrypoint,
}));

describe("triage --run", () => {
  let stateDir: string;
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.confirm.mockResolvedValue(true);
    stateDir = tempDirs.make("openclaw-triage-run-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", undefined);
    vi.stubEnv("OPENCLAW_WORKSPACE_DIR", undefined);
    mocks.collectDoctorFindings.mockResolvedValue([]);
    mocks.resolveGatewayInstallEntrypoint.mockImplementation(async (root) =>
      path.join(root, "dist/index.js"),
    );
    mocks.runUtf8CommandWithTimeout.mockReset().mockResolvedValue({
      code: 0,
      termination: "exit",
      stdout: JSON.stringify({ ok: true, findings: [] }),
    });
    mocks.runUpdateRepairLoop.mockResolvedValue({
      status: "repaired",
      attempts: [],
      finalValidation: { ok: true, score: 0, summary: "Doctor lint reports no errors." },
    });
    mocks.prepareUpdateRepairInference.mockResolvedValue({
      ok: true,
      route: {
        runner: "embedded",
        agentId: "owner",
        provider: "fixture",
        model: "repair",
        modelLabel: "fixture/repair",
        agentDir: "/fixture/agent",
        runConfig: {},
      },
      modelFallbacks: [],
    });
    mocks.runUpdateRepairTurn.mockResolvedValue({
      toolCalls: 1,
      exitCode: 0,
      envelope: {
        status: "ok",
        provider: "fixture",
        model: "repair",
        final: "Doctor repair attempted.",
      },
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("keeps plain Doctor triage successful without update history", async () => {
    const real = await vi.importActual<typeof import("../infra/update-repair-agent.js")>(
      "../infra/update-repair-agent.js",
    );
    mocks.runUpdateRepairLoop.mockImplementation(real.runUpdateRepairLoop);
    const runtime = createTriageRuntime();
    await withTriageTerminal(true, () => triageCommand(runtime, { run: true, noExport: true }));
    expect(runtime.log).toHaveBeenCalledWith(
      "Embedded repair already resolved: Doctor lint reports no errors.",
    );
    expect(mocks.runUpdateRepairTurn).not.toHaveBeenCalled();
  });

  it("keeps an uncorrelated update failure unresolved despite clean Doctor lint", async () => {
    const saved = await writeRestartSentinel({
      kind: "update",
      status: "error",
      ts: Date.UTC(2026, 8, 8),
      stats: { mode: "npm", reason: "global-install-failed" },
    });
    const real = await vi.importActual<typeof import("../infra/update-repair-agent.js")>(
      "../infra/update-repair-agent.js",
    );
    mocks.runUpdateRepairLoop.mockImplementation(real.runUpdateRepairLoop);
    const runtime = createTriageRuntime();
    await expect(
      withTriageTerminal(true, () => triageCommand(runtime, { run: true, noExport: true })),
    ).rejects.toMatchObject({ code: 1 });
    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringMatching(/Embedded repair unrepaired: .*Cannot establish the update target\./),
    );
    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining("openclaw update repair"));
    expect(mocks.runUpdateRepairTurn).not.toHaveBeenCalled();
    expect(await readRestartSentinelReadOnly()).toEqual(saved);
  });

  it.each([
    "failed",
    "failed with migration",
    "succeeded with migration",
    "preview",
    "101 previews",
  ])("keeps update recovery unresolved without a restart sentinel: %s", async (outcome) => {
    const pendingMigration = outcome.includes("migration");
    const targetVersion = await readPackageVersion(path.resolve(import.meta.dirname, "../.."));
    if (!targetVersion) {
      throw new Error("Fixture installation version missing");
    }
    const run = createUpdateRun({
      trigger: "cli",
      target: { kind: "package", version: targetVersion },
    });
    recordUpdateRunStep(run.runId, {
      step: "finalize:doctor",
      status: "failed",
      exitCode: 1,
      detail: "Doctor could not enter maintenance.",
    });
    finishUpdateRun(run.runId, { status: "failed", reason: "finalize:doctor" });
    if (pendingMigration) {
      recordDeferredPluginMigrations({
        pending: [
          {
            pluginId: "codex",
            reason: "The plugin has not reported completion of its retained state migration.",
            command: "openclaw doctor --fix",
            requiresStateMigration: true,
          },
        ],
      });
    }
    if (outcome === "succeeded with migration") {
      const completed = createUpdateRun({
        trigger: "cli",
        target: { kind: "package", version: targetVersion },
      });
      finishUpdateRun(completed.runId, {
        status: "succeeded",
        after: { version: targetVersion },
      });
    }
    if (outcome === "preview" || outcome === "101 previews") {
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 1);
      for (let index = 0; index < (outcome === "preview" ? 1 : 101); index += 1) {
        const preview = createUpdateRun({ trigger: "cli", preview: true });
        finishUpdateRun(preview.runId, { status: "skipped", reason: "dry-run" });
      }
    }
    const real = await vi.importActual<typeof import("../infra/update-repair-agent.js")>(
      "../infra/update-repair-agent.js",
    );
    mocks.runUpdateRepairLoop.mockImplementation(real.runUpdateRepairLoop);
    const runtime = createTriageRuntime();
    await expect(
      withTriageTerminal(true, () => triageCommand(runtime, { run: true, noExport: true })),
    ).rejects.toMatchObject({ code: 1 });
    const output = runtime.log.mock.calls.flat().join("\n");
    expect(output).toContain("Embedded repair unrepaired:");
    expect(output).toContain("openclaw update repair");
    expect(output).not.toContain("already resolved");
    if (pendingMigration) {
      expect(output).toContain('Plugin "codex" data/settings upgrade is unfinished');
    }
    expect(getUpdateRun(run.runId)?.status).toBe("failed");
    expect(await readRestartSentinelReadOnly()).toBeNull();
    expect(mocks.runUpdateRepairTurn).not.toHaveBeenCalled();
  });

  it("reports unavailable update history instead of a healthy Doctor verdict", async () => {
    const ledger = await import("../infra/update-run-reader.js");
    vi.spyOn(ledger, "readUpdateRunResolutionHistory").mockImplementationOnce(() => {
      throw new Error("Ledger snapshot unavailable");
    });
    const real = await vi.importActual<typeof import("../infra/update-repair-agent.js")>(
      "../infra/update-repair-agent.js",
    );
    mocks.runUpdateRepairLoop.mockImplementation(real.runUpdateRepairLoop);
    const runtime = createTriageRuntime();
    await expect(
      withTriageTerminal(true, () => triageCommand(runtime, { run: true, noExport: true })),
    ).rejects.toMatchObject({ code: 1 });
    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringMatching(/Embedded repair unrepaired: .*Update history is unavailable/),
    );
    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining("openclaw update repair"));
    expect(mocks.runUpdateRepairTurn).not.toHaveBeenCalled();
  });

  it.each([
    "preview",
    "acknowledged abandonment",
    "upgrade",
    "upgrade with generic failure",
    "upgrade from git",
    "explicit upgrade",
    "rollback",
    "rollback without restoration",
    "rollback with mismatched restoration",
    "explicit rollback",
  ])("preserves recorded resolution behind a newer %s", async (newer) => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now++);
    const version = await readPackageVersion(path.resolve(import.meta.dirname, "../.."));
    if (!version) {
      throw new Error("Fixture installation version missing");
    }
    const upgrade = newer.includes("upgrade");
    const rollback = newer.includes("rollback");
    const target = {
      kind: newer === "upgrade from git" ? ("git" as const) : ("package" as const),
      version: upgrade ? "2026.9.1" : version,
    };
    const failed = createUpdateRun({
      trigger: "cli",
      target,
      before: { version: "2026.9.1" },
    });
    finishUpdateRun(failed.runId, {
      status: "failed",
      reason: newer === "upgrade with generic failure" ? "update-failed" : "finalize:doctor",
    });
    const completed = createUpdateRun({ trigger: "cli", target });
    finishUpdateRun(completed.runId, { status: "succeeded", after: { version: target.version } });
    const extra = createUpdateRun({
      trigger: "cli",
      preview: newer === "preview",
      ...(upgrade ? { target: { kind: "package", version } } : {}),
      ...(rollback
        ? {
            target: { kind: "package", version: "2099.1.0" },
            before: {
              version: newer === "rollback with mismatched restoration" ? "2026.9.1" : version,
            },
          }
        : {}),
    });
    if (rollback && newer !== "rollback without restoration") {
      recordUpdateRunStep(extra.runId, { step: "package rollback", status: "completed" });
    }
    finishUpdateRun(extra.runId, {
      status: rollback
        ? "rolled-back"
        : upgrade
          ? "succeeded"
          : newer === "preview"
            ? "skipped"
            : "failed",
      ...(upgrade || rollback
        ? { after: { version } }
        : { reason: newer === "preview" ? "dry-run" : "abandoned" }),
    });
    if (newer === "acknowledged abandonment") {
      acknowledgeAbandonedUpdateRun(extra.runId);
    }
    const packages = await import("../infra/update-global.js");
    const inventory = await import("../infra/package-dist-inventory.js");
    const probe = await import("../cli/daemon-cli/restart-health-probe.js");
    const verification = await import("../cli/update-cli/update-command-verification.js");
    vi.spyOn(packages, "collectInstalledGlobalPackageErrors").mockResolvedValue([]);
    vi.spyOn(inventory, "collectPackageDistContentInventoryErrors").mockResolvedValue([]);
    vi.spyOn(probe, "resolveGatewayRestartProbeContext").mockResolvedValue({
      config: {},
      auth: undefined,
    });
    const verified = vi
      .spyOn(verification, "verifyPreviousGatewayForUpdate")
      .mockResolvedValue(true);
    const real = await vi.importActual<typeof import("../infra/update-repair-agent.js")>(
      "../infra/update-repair-agent.js",
    );
    mocks.runUpdateRepairLoop.mockImplementation(real.runUpdateRepairLoop);
    const runtime = createTriageRuntime();
    let updateResult: string | undefined;
    if (newer.startsWith("explicit")) {
      updateResult = path.join(stateDir, "explicit-failure.json");
      await fs.writeFile(
        updateResult,
        JSON.stringify({
          result: {
            runId: failed.runId,
            status: "error",
            mode: "npm",
            reason: "finalize:doctor",
            steps: [],
          },
        }),
      );
    }
    const command = withTriageTerminal(true, () =>
      triageCommand(runtime, { run: true, noExport: true, updateResult }),
    );
    if (updateResult || newer.includes("restoration")) {
      await expect(command).rejects.toMatchObject({ code: 1 });
      expect(verified).not.toHaveBeenCalled();
      expect(runtime.log.mock.calls.flat().join("\n")).not.toContain("already resolved");
      return;
    }
    await command;
    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining(
        `Embedded repair already resolved: ${rollback ? "Rollback" : "Update"} to ${version}`,
      ),
    );
    expect(verified).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ expectedVersion: version }),
    );
    expect(getUpdateRun(failed.runId)?.status).toBe("failed");
  });

  it.each([
    { notification: false, doctorErrors: false },
    { notification: true, doctorErrors: false },
    { notification: true, doctorErrors: true },
  ])(
    "honors abandonment without hiding current Doctor errors (notification: $notification, errors: $doctorErrors)",
    async ({ notification, doctorErrors }) => {
      const run = createUpdateRun({ trigger: "cli" });
      finishUpdateRun(run.runId, { status: "failed", reason: "abandoned" });
      acknowledgeAbandonedUpdateRun(run.runId);
      if (notification) {
        await writeRestartSentinel({
          kind: "update",
          status: "error",
          ts: Date.now(),
          stats: { runId: run.runId, reason: "abandoned" },
        });
      }
      const real = await vi.importActual<typeof import("../infra/update-repair-agent.js")>(
        "../infra/update-repair-agent.js",
      );
      mocks.runUpdateRepairLoop.mockImplementation(real.runUpdateRepairLoop);
      if (doctorErrors) {
        mocks.runUtf8CommandWithTimeout.mockResolvedValue({
          code: 1,
          termination: "exit",
          stdout: JSON.stringify({
            ok: false,
            findings: [{ severity: "error", message: "Current configuration is invalid." }],
          }),
        });
      }
      const runtime = createTriageRuntime();
      const command = withTriageTerminal(true, () =>
        triageCommand(runtime, { run: true, noExport: true }),
      );
      if (doctorErrors) {
        await expect(command).rejects.toMatchObject({ code: 1 });
        const output = runtime.log.mock.calls.flat().join("\n");
        expect(output).toContain("Current configuration is invalid.");
        expect(output).not.toContain("already resolved");
        return;
      }
      await command;
      expect(runtime.log).toHaveBeenCalledWith(
        expect.stringContaining("Embedded repair already resolved:"),
      );
      expect(mocks.runUpdateRepairTurn).not.toHaveBeenCalled();
      expect(getUpdateRun(run.runId)?.status).toBe("failed");
    },
  );

  it.each(["missing run", "missing target", "recorded target"])(
    "requires updater completion for an attributed Doctor failure: %s",
    async (identity) => {
      const targetVersion = await readPackageVersion(path.resolve(import.meta.dirname, "../.."));
      if (!targetVersion) {
        throw new Error("Fixture installation version missing");
      }
      const run =
        identity === "missing run"
          ? undefined
          : createUpdateRun({
              trigger: "cli",
              target:
                identity === "recorded target" ? { kind: "package", version: targetVersion } : {},
            });
      if (run) {
        recordUpdateRunStep(run.runId, {
          step: "finalize:doctor",
          status: "failed",
          exitCode: 1,
          failureFacts: [{ check: "doctor", code: "doctor-failed" }],
        });
        finishUpdateRun(run.runId, { status: "failed", reason: "post-update-failed" });
      }
      const saved = JSON.stringify({
        result: {
          ...(run ? { runId: run.runId } : {}),
          status: "error",
          mode: "npm",
          reason: "post-update-failed",
          steps: [{ name: "doctor", exitCode: 1 }],
        },
      });
      const failurePath = path.join(stateDir, "doctor-failure.json");
      await fs.writeFile(failurePath, saved);
      const real = await vi.importActual<typeof import("../infra/update-repair-agent.js")>(
        "../infra/update-repair-agent.js",
      );
      mocks.runUpdateRepairLoop.mockImplementation(real.runUpdateRepairLoop);
      const runtime = createTriageRuntime();
      const command = withTriageTerminal(true, () =>
        triageCommand(runtime, { run: true, noExport: true, updateResult: failurePath }),
      );
      await expect(command).rejects.toMatchObject({ code: 1 });
      const result = await mocks.runUpdateRepairLoop.mock.results[0]?.value;
      expect(result).toMatchObject({ status: "unrepaired", finalValidation: { ok: false } });
      expect(runtime.log).toHaveBeenCalledWith(
        expect.stringContaining(
          identity === "recorded target"
            ? "The updater has not recorded a completed resolution"
            : "Cannot establish the update target.",
        ),
      );
      expect(mocks.runUpdateRepairTurn).not.toHaveBeenCalled();
      expect(await fs.readFile(failurePath, "utf8")).toBe(saved);
    },
  );

  it("keeps a correlated implicit package failure on the update resolution path", async () => {
    const targetVersion = await readPackageVersion(path.resolve(import.meta.dirname, "../.."));
    if (!targetVersion) {
      throw new Error("Fixture installation version missing");
    }
    const run = createUpdateRun({
      trigger: "cli",
      target: { kind: "package", version: targetVersion },
    });
    finishUpdateRun(run.runId, { status: "failed", reason: "global-install-failed" });
    const saved = await writeRestartSentinel({
      kind: "update",
      status: "error",
      ts: Date.UTC(2026, 8, 8),
      stats: { runId: run.runId, mode: "npm", reason: "global-install-failed" },
    });
    const real = await vi.importActual<typeof import("../infra/update-repair-agent.js")>(
      "../infra/update-repair-agent.js",
    );
    mocks.runUpdateRepairLoop.mockImplementation(real.runUpdateRepairLoop);
    const runtime = createTriageRuntime();
    await expect(
      withTriageTerminal(true, () => triageCommand(runtime, { run: true, noExport: true })),
    ).rejects.toMatchObject({ code: 1 });
    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("Embedded repair unrepaired:"),
    );
    expect(runtime.log).not.toHaveBeenCalledWith(
      expect.stringContaining("could not be correlated"),
    );
    expect(await readRestartSentinelReadOnly()).toEqual(saved);
  });

  it("does not report a saved unresolved global install failure as repaired when Doctor passes", async () => {
    const failure = {
      result: {
        status: "error",
        mode: "npm",
        reason: "global-install-failed",
        before: { version: "2026.9.3" },
        after: { version: "2026.9.3" },
        recovery: { serviceRestartSafe: false, packageRollbackVerified: false },
        steps: [
          {
            name: "global install swap",
            exitCode: 1,
            stderrTail: "retained package tree changed; Installation recovery is unverified",
          },
        ],
      },
    };
    const failurePath = path.join(stateDir, "failure.json");
    const failureJson = JSON.stringify(failure);
    await fs.writeFile(failurePath, failureJson);
    const { runUpdateRepairLoop } = await vi.importActual<
      typeof import("../infra/update-repair-agent.js")
    >("../infra/update-repair-agent.js");
    mocks.runUpdateRepairLoop.mockImplementation(runUpdateRepairLoop);
    const runtime = createTriageRuntime();
    let exitCode = 0;
    try {
      await withTriageTerminal(true, () =>
        triageCommand(runtime, { run: true, noExport: true, updateResult: failurePath }),
      );
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || typeof error.code !== "number") {
        throw error;
      }
      exitCode = error.code;
    }
    expect(await fs.readFile(failurePath, "utf8")).toBe(failureJson);
    const result = await mocks.runUpdateRepairLoop.mock.results[0]?.value;
    expect({ exitCode, result, output: runtime.log.mock.calls.flat().join("\n") }).toMatchObject({
      exitCode: 1,
      result: { status: "unrepaired", finalValidation: { ok: false } },
      output: expect.stringContaining("Next step"),
    });
  });

  it("confirms an interactive owned update continuation before embedded execution", async () => {
    await fs.writeFile(
      path.join(stateDir, "openclaw.json"),
      JSON.stringify({ agents: { defaults: { model: "openai/gpt-5.6-luna" } } }),
    );
    mocks.confirm.mockResolvedValue(false);
    const runtime = createTriageRuntime();
    await withTriageTerminal(true, () =>
      triageCommand(
        runtime,
        { noExport: true },
        {
          signal: new AbortController().signal,
          assertCurrent: vi.fn(),
          failure: { kind: "update", phase: "build", error: "install failed", gateway: "preserve" },
        },
      ),
    );
    expect(mocks.confirm).toHaveBeenCalledOnce();
    expect(mocks.prepareUpdateRepairInference).not.toHaveBeenCalled();
    expect(mocks.runUpdateRepairTurn).not.toHaveBeenCalled();
    expect(runtime.log.mock.calls.flat().join("\n")).toContain(
      "the embedded OpenClaw agent using your configured model",
    );
    expect(runtime.log.mock.calls.flat().join("\n")).not.toContain("gpt-5.6-luna");
    expect(runtime.log).toHaveBeenCalledWith("No repair agent was started.");
  });

  it("labels an evidence-backed zero-attempt repair as already resolved", async () => {
    const summary =
      "Update to 2026.9.4 recorded by the updater; installed runtime and managed Gateway readiness verified.";
    mocks.runUpdateRepairLoop.mockResolvedValue({
      status: "repaired",
      attempts: [],
      finalValidation: { ok: true, score: 0, summary },
    });
    const runtime = createTriageRuntime();
    await withTriageTerminal(true, () => triageCommand(runtime, { run: true, noExport: true }));
    expect(runtime.log).toHaveBeenCalledWith(`Embedded repair already resolved: ${summary}`);
  });

  it("keeps the onboarding hint when embedded repair has no usable inference", async () => {
    mocks.runUpdateRepairLoop.mockResolvedValue({
      status: "unavailable",
      attempts: [],
      finalValidation: { ok: false, score: -1, summary: "Doctor lint found an error." },
      reason: "The configured model is unavailable",
    });
    const runtime = createTriageRuntime();

    await withTriageTerminal(true, async () => {
      await expect(triageCommand(runtime, { noExport: true, run: true })).rejects.toThrow(
        "Run `openclaw onboard` or use a suggested handoff command.",
      );
    });
    expect(mocks.runUpdateRepairLoop).toHaveBeenCalledOnce();
  });

  it("runs one shared repair turn with fresh Doctor severity validation and the captured target", async () => {
    const runtime = createTriageRuntime();
    const signal = new AbortController().signal;
    mocks.runUtf8CommandWithTimeout
      .mockResolvedValueOnce({
        code: 1,
        termination: "exit",
        stdout: JSON.stringify({
          ok: false,
          findings: [{ severity: "error", message: "Broken installation" }],
        }),
      })
      .mockResolvedValueOnce({
        code: 0,
        termination: "exit",
        stdout: JSON.stringify({
          ok: true,
          findings: [{ severity: "warning", message: "Optional improvement" }],
        }),
      });
    mocks.runUpdateRepairLoop.mockImplementation(async ({ validate }) => {
      expect(await validate(signal)).toEqual({
        ok: false,
        score: -1,
        summary: "1 Doctor lint error(s): Broken installation",
      });
      const finalValidation = await validate(signal);
      expect(finalValidation).toEqual({
        ok: true,
        score: 0,
        summary: "Doctor lint reports no errors.",
      });
      return {
        status: "repaired",
        attempts: [{ summary: "Doctor errors repaired." }],
        finalValidation,
      };
    });

    await withTriageTerminal(true, () =>
      triageCommand(runtime, {
        noExport: true,
        run: true,
      }),
    );

    expect(mocks.runUpdateRepairLoop).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        target: {
          stateDir,
          configPath: path.join(stateDir, "openclaw.json"),
          workspaceDir: path.join(stateDir, "workspace"),
          installRoot: path.resolve(import.meta.dirname, "../.."),
        },
        context: expect.objectContaining({
          error: "Operator requested installation triage",
          phase: "verifying",
        }),
        budget: { maxTurns: 1 },
      }),
    );
    expect(mocks.collectDoctorFindings).toHaveBeenCalledOnce();
    expect(mocks.runUtf8CommandWithTimeout).toHaveBeenCalledTimes(2);
    expect(mocks.runUtf8CommandWithTimeout).toHaveBeenCalledWith(
      [
        process.execPath,
        path.resolve(import.meta.dirname, "../../dist/index.js"),
        "doctor",
        "--lint",
        "--json",
        "--severity-min",
        "error",
      ],
      expect.objectContaining({
        cwd: path.resolve(import.meta.dirname, "../.."),
        baseEnv: {},
        env: expect.objectContaining({
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
          OPENCLAW_WORKSPACE_DIR: path.join(stateDir, "workspace"),
        }),
        signal,
        input: "",
        killProcessTree: true,
        terminateOnOutputLimit: true,
      }),
    );
    expect(runtime.log).toHaveBeenCalledWith(
      "Embedded repair repaired: Doctor lint reports no errors.",
    );
  });

  it("explains policy-denied repair and points to the external handoff", async () => {
    mocks.runUpdateRepairLoop.mockResolvedValue({
      status: "unavailable",
      reason: "exec-denied-by-policy",
      attempts: [],
      finalValidation: { ok: false, score: -1, summary: "Broken installation" },
    });
    await expect(
      withTriageTerminal(true, () =>
        triageCommand(createTriageRuntime(), { noExport: true, run: true }),
      ),
    ).rejects.toThrow(
      "The operator's policy denies unattended repair (exec-denied-by-policy). Use `openclaw triage` for an external handoff.",
    );
  });

  it("reports Doctor collection failures to the repair oracle with secrets redacted", async () => {
    const secret = "sk-test-triage-oracle-secret-1234567890";
    mocks.runUtf8CommandWithTimeout.mockRejectedValue(
      new Error(`Doctor unavailable; token=${secret}`),
    );
    mocks.runUpdateRepairLoop.mockImplementation(async ({ validate }) => {
      const finalValidation = await validate(new AbortController().signal);
      expect(finalValidation.ok).toBe(false);
      expect(finalValidation.score).toBe(Number.MIN_SAFE_INTEGER);
      expect(finalValidation.summary).toContain("Doctor checks unavailable:");
      expect(finalValidation.summary).not.toContain(secret);
      return { status: "unrepaired", attempts: [], finalValidation };
    });
    await expect(
      withTriageTerminal(true, () =>
        triageCommand(createTriageRuntime(), { noExport: true, run: true }),
      ),
    ).rejects.toMatchObject({ code: 1 });
  });

  it.each([
    { name: "malformed JSON", result: { code: 0, termination: "exit", stdout: "not-json" } },
    { name: "missing findings", result: { code: 0, termination: "exit", stdout: "{}" } },
    {
      name: "unexplained failure",
      result: { code: 1, termination: "exit", stdout: '{"ok":false,"findings":[]}' },
    },
    {
      name: "output limit",
      result: { code: null, termination: "signal", stdout: "", outputLimitExceeded: true },
    },
  ])("never accepts $name as healthy Doctor validation", async ({ result }) => {
    mocks.runUtf8CommandWithTimeout.mockResolvedValue(result);
    mocks.runUpdateRepairLoop.mockImplementation(async ({ validate }) => {
      const finalValidation = await validate(new AbortController().signal);
      expect(finalValidation.ok).toBe(false);
      expect(finalValidation.summary).toContain("Doctor checks unavailable:");
      return { status: "unrepaired", attempts: [], finalValidation };
    });
    await expect(
      withTriageTerminal(true, () =>
        triageCommand(createTriageRuntime(), { noExport: true, run: true }),
      ),
    ).rejects.toMatchObject({ code: 1 });
  });

  it("propagates validation cancellation after the Doctor child settles", async () => {
    const controller = new AbortController();
    const reason = new Error("wall-clock-budget");
    mocks.runUtf8CommandWithTimeout.mockImplementation(async (_argv, { signal }) => {
      expect(signal).toBe(controller.signal);
      controller.abort(reason);
      return { termination: "signal", code: null, stdout: "" };
    });
    mocks.runUpdateRepairLoop.mockImplementation(async ({ validate }) => {
      await expect(validate(controller.signal)).rejects.toBe(reason);
      return {
        status: "aborted",
        reason: "wall-clock-budget",
        attempts: [],
        finalValidation: { ok: false, score: -1, summary: "Cancelled" },
      };
    });
    await expect(
      withTriageTerminal(true, () =>
        triageCommand(createTriageRuntime(), { noExport: true, run: true }),
      ),
    ).rejects.toMatchObject({ code: 2 });
  });

  it.each([
    { interactive: false, nonInteractive: false },
    { interactive: true, nonInteractive: true },
  ])(
    "refuses embedded execution without an allowed terminal ($interactive/$nonInteractive)",
    async ({ interactive, nonInteractive }) => {
      await expect(
        withTriageTerminal(interactive, () =>
          triageCommand(createTriageRuntime(), { noExport: true, run: true, nonInteractive }),
        ),
      ).rejects.toThrow("Embedded triage requires an interactive terminal");
      expect(mocks.runUpdateRepairLoop).not.toHaveBeenCalled();
    },
  );

  it.each([
    { status: "aborted", reason: "cancelled", code: 1 },
    { status: "unrepaired", reason: "per-turn-budget", code: 2 },
    { status: "improved", reason: "wall-clock-budget", code: 2 },
  ])(
    "reports $status and preserves nonzero exit $code for $reason",
    async ({ status, reason, code }) => {
      mocks.runUpdateRepairLoop.mockResolvedValue({
        status,
        reason,
        attempts: [{ summary: "Attempt completed." }],
        finalValidation: { ok: false, score: -1, summary: "Doctor lint found an error." },
      });
      const runtime = createTriageRuntime();
      await expect(
        withTriageTerminal(true, () => triageCommand(runtime, { noExport: true, run: true })),
      ).rejects.toMatchObject({ code });
      expect(runtime.log).toHaveBeenCalledWith("Attempt completed.");
      expect(runtime.log).toHaveBeenCalledWith(
        `Embedded repair ${status}: Doctor lint found an error.`,
      );
      expect(runtime.error).toHaveBeenCalledWith(reason);
    },
  );

  it("runs embedded triage from in-memory diagnostics when its artifact cannot be saved", async () => {
    vi.spyOn(fs, "writeFile").mockRejectedValueOnce(
      Object.assign(new Error("EACCES: support artifact permission denied"), { code: "EACCES" }),
    );
    const runtime = createTriageRuntime();

    await withTriageTerminal(true, () => triageCommand(runtime, { noExport: true, run: true }));

    expect(mocks.runUpdateRepairLoop).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        context: expect.objectContaining({ error: "Operator requested installation triage" }),
      }),
    );
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("EACCES"));
    expect(runtime.log).not.toHaveBeenCalledWith(expect.stringMatching(/^Debugging prompt: /u));
  });

  it("does not publish a result after its recovery owner closes during repair", async () => {
    let current = true;
    const runtime = createTriageRuntime();
    mocks.runUpdateRepairLoop.mockImplementation(async ({ isCurrent, onEvent }) => {
      expect(isCurrent()).toBe(true);
      onEvent({ type: "turn-started", turn: 1, provider: "openai", model: "gpt-5.6-luna" });
      expect(runtime.log).toHaveBeenCalledWith("Starting repair turn 1 with openai/gpt-5.6-luna.");
      current = false;
      return {
        status: "aborted",
        attempts: [],
        finalValidation: { ok: false, score: -1, summary: "Closed" },
      };
    });
    await withTriageTerminal(true, () =>
      triageCommand(runtime, {
        run: true,
        noExport: true,
        recovery: {
          target: resolveInstallationTarget(),
          updateFailure: { error: "Captured update failure" },
          isCurrent: () => current,
        },
      }),
    );
    expect(runtime.log).not.toHaveBeenCalledWith(
      expect.stringContaining("Embedded repair aborted"),
    );
    expect(runtime.exit).not.toHaveBeenCalled();
  });
});
