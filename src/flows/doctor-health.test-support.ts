import fs from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type * as restart from "../cli/daemon-cli/restart-health.js";
import { createConfigIO } from "../config/io.factory.js";
import { hashConfigRaw } from "../config/io.read-helpers.js";
import { ConfigWritePostCommitError } from "../config/io.write-errors.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  UpdateDoctorError,
  type UpdatePostInstallDoctorResult,
} from "../infra/update-doctor-result.js";
import type { OpenClawStateDatabase } from "../state/openclaw-state-db-contract.js";
import { UpdateSchemaRefusalError } from "../state/openclaw-update-schema-refusal.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { createDoctorHealthContribution } from "./doctor-health-contribution.js";
import type { DoctorHealthFlowContext } from "./doctor-health-contributions.js";

export function stubDoctorEnv(values: Record<string, string | undefined>) {
  for (const [name, value] of Object.entries(values)) {
    vi.stubEnv(name, value);
  }
}

export function createDoctorRuntime() {
  return { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
}

export function withDoctorState<T>(
  run: (state: OpenClawTestState) => Promise<T>,
  env?: Record<string, string | undefined>,
) {
  return withOpenClawTestState({ scenario: "minimal", env }, run);
}

export const postInstallAdvisory: NonNullable<DoctorHealthFlowContext["postInstallDoctorResult"]> =
  {
    status: "advisory",
    advisory: {
      kind: "package-post-install-doctor",
      message: "recoverable plugin repair",
      reason: "deferred-configured-plugin-repair",
      details: ["plugin repair deferred"],
    },
  };

const mocks = vi.hoisted(() => {
  const handles = {
    outro: vi.fn(),
    confirm: vi.fn(async () => true),
    lint: vi.fn<(typeof import("../commands/doctor-lint.js"))["runDoctorLintCli"]>(),
    config: vi.fn<() => OpenClawConfig>(),
    runContributions: vi.fn<(ctx: DoctorHealthFlowContext) => Promise<void>>(),
    writeUpdatePostInstallDoctorResult: vi.fn(),
    service: vi.fn(),
    resident: vi.fn<() => { pid: number } | undefined>(),
    probePortUsage: vi.fn<(typeof import("../infra/ports-probe.js"))["probePortUsage"]>(),
    inspectGatewayRestart: vi.fn<typeof restart.inspectGatewayRestart>(),
    waitForGatewayHealthyRestart: vi.fn<typeof restart.waitForGatewayHealthyRestart>(),
    packageRoot: vi.fn<() => string | undefined>(),
    runtimeTmpDir: vi.fn<() => string>(),
    restartedHealthy: true,
    emulateNativeInstall: true,
    servicePlatform: undefined as NodeJS.Platform | undefined,
    taskDefinitelyStopped: vi.fn(() => true),
    startupFallbackRuntime: vi.fn<() => Promise<{ status: string } | null>>(async () => null),
  };
  // Registration runs before imports, like vi.mock; partials retain every other export.
  const partials = {
    "../infra/tmp-openclaw-dir.js": { resolvePreferredOpenClawTmpDir: handles.runtimeTmpDir },
    "../infra/openclaw-root.js": { resolveOpenClawPackageRoot: async () => handles.packageRoot() },
    "../daemon/service.js": { resolveGatewayService: () => handles.service() },
    "../infra/ports-probe.js": { probePortUsage: handles.probePortUsage },
    "../daemon/schtasks-runtime.js": {
      isScheduledTaskDefinitelyNotRunning: handles.taskDefinitelyStopped,
      readWindowsStartupFallbackRuntimeForUpdate: handles.startupFallbackRuntime,
    },
    "../cli/daemon-cli/restart-health.js": {
      inspectGatewayRestart: handles.inspectGatewayRestart,
      waitForGatewayHealthyRestart: handles.waitForGatewayHealthyRestart,
      renderRestartDiagnostics: () => ["synthetic readiness failure"],
    },
    "../commands/doctor-lint.js": { runDoctorLintCli: handles.lint },
    "../config/config.js": { CONFIG_PATH: "/tmp/openclaw.json" },
    "../infra/update-doctor-result.js": {
      UPDATE_POST_INSTALL_DOCTOR_ADVISORY_EXIT_CODE: 86,
      UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV: "OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH",
      writeUpdatePostInstallDoctorResult: handles.writeUpdatePostInstallDoctorResult,
    },
  };
  for (const [module, overrides] of Object.entries(partials)) {
    vi.doMock(module, async (original) => ({ ...(await original<object>()), ...overrides }));
  }
  const replacements = {
    "@clack/prompts": {
      intro: vi.fn(),
      note: vi.fn(),
      outro: handles.outro,
      confirm: handles.confirm,
      select: vi.fn(),
    },
    "../commands/doctor-update.js": {
      maybeOfferUpdateBeforeDoctor: async () => ({ updated: false }),
    },
    "../commands/doctor-ui.js": { maybeRepairUiProtocolFreshness: async () => undefined },
    "../commands/doctor-install.js": { noteSourceInstallIssues: () => undefined },
    "../commands/doctor/shared/plugin-runtime-symlinks.js": {
      noteStalePluginRuntimeSymlinks: async () => undefined,
      removeStalePluginRuntimeSymlinks: async () => ({ changes: [], warnings: [] }),
    },
    "../commands/doctor-platform-notes.js": { noteStartupOptimizationHints: () => undefined },
    // Keep config preparation outside service-lifecycle fixtures.
    "../commands/doctor-config-flow.js": {
      loadAndMaybeMigrateDoctorConfig: async () => ({
        cfg: handles.config(),
        shouldWriteConfig: true,
        [Symbol.asyncDispose]: async () => undefined,
      }),
    },
    "./doctor-health-contributions.js": { runDoctorHealthContributions: handles.runContributions },
  };
  for (const [module, replacement] of Object.entries(replacements)) {
    vi.doMock(module, () => replacement);
  }
  return handles;
});

const runtimeDirs = useAutoCleanupTempDirTracker(afterEach);
async function restartSnapshot(
  params: Parameters<typeof restart.inspectGatewayRestart>[0],
  gatewayBootId: string,
): Promise<restart.GatewayRestartSnapshot> {
  return {
    runtime: await params.service.readRuntime(params.env ?? process.env),
    portUsage: { port: params.port, status: "busy", listeners: [], hints: [] },
    healthy: true,
    staleGatewayPids: [],
    gatewayVersion: params.expectedVersion ?? null,
    gatewayBuildId: params.expectedBuildId ?? null,
    gatewayBootId,
  };
}
beforeEach(() => {
  mocks.resident.mockReset();
  mocks.runtimeTmpDir.mockReturnValue(runtimeDirs.make("openclaw-doctor-runtime-"));
  mocks.inspectGatewayRestart
    .mockReset()
    .mockImplementation((params) => restartSnapshot(params, "synthetic-current-boot"));
  mocks.waitForGatewayHealthyRestart.mockReset().mockImplementation(async (params) => {
    if (!params.service) {
      throw new Error("Doctor readiness must use its managed Gateway service");
    }
    return {
      ...(await restartSnapshot(
        { ...params, service: params.service },
        "synthetic-restarted-boot",
      )),
      outcome: mocks.restartedHealthy ? "ready" : "failed",
      healthy: mocks.restartedHealthy,
      waitOutcome: mocks.restartedHealthy ? "healthy" : "timeout",
    };
  });
});

vi.mock("../gateway/call.js", async (original) => {
  const { gatewayMaintenanceResponse } = await import("../gateway/health-response.test-support.js");
  return {
    ...(await original<typeof import("../gateway/call.js")>()),
    callGatewayCli: gatewayMaintenanceResponse(() => mocks.resident()),
  };
});

vi.mock("../infra/restart-stale-pids.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/restart-stale-pids.js")>();
  return {
    ...actual,
    // Synthetic Gateway PIDs must not collide with the test worker's real ancestors.
    inspectSelfAndAncestorPidsSync: (
      ...args: Parameters<typeof actual.inspectSelfAndAncestorPidsSync>
    ) =>
      mocks.emulateNativeInstall
        ? { pids: new Set([process.pid, 1]), complete: true }
        : actual.inspectSelfAndAncestorPidsSync(...args),
  };
});

vi.mock("../daemon/service-process-membership.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../daemon/service-process-membership.js")>();
  return {
    ...actual,
    // Doctor is outside the fixture's native service.
    inspectServiceProcessMembershipSync: (
      ...args: Parameters<typeof actual.inspectServiceProcessMembershipSync>
    ) =>
      mocks.emulateNativeInstall ? "outside" : actual.inspectServiceProcessMembershipSync(...args),
  };
});

vi.mock("../infra/container-environment.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/container-environment.js")>();
  return {
    ...actual,
    isContainerEnvironment: () =>
      mocks.emulateNativeInstall ? false : actual.isContainerEnvironment(),
  };
});

vi.mock("../daemon/systemd-exec.js", async (original) => {
  const { gatewayMaintenanceSystemdShow } =
    await import("../gateway/health-response.test-support.js");
  return {
    ...(await original<typeof import("../daemon/systemd-exec.js")>()),
    execSystemctlUser: gatewayMaintenanceSystemdShow,
  };
});

vi.mock("../config/paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/paths.js")>();
  return {
    ...actual,
    // Runtime-only cases retain the real install-identity policy.
    isDefaultInstallIdentity: (env: NodeJS.ProcessEnv) =>
      mocks.emulateNativeInstall || actual.isDefaultInstallIdentity(env),
  };
});

vi.mock("../cli/update-cli/update-command-service-maintenance.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../cli/update-cli/update-command-service-maintenance.js")
    >();
  return {
    ...actual,
    maybeStopManagedServiceBeforeMutableUpdate: async (
      params: Parameters<typeof actual.maybeStopManagedServiceBeforeMutableUpdate>[0],
    ) => {
      // Keep the host's filesystem case semantics outside native-manager operations.
      const platform = mocks.servicePlatform
        ? vi.spyOn(process, "platform", "get").mockReturnValue(mocks.servicePlatform)
        : undefined;
      try {
        return await actual.maybeStopManagedServiceBeforeMutableUpdate(params);
      } finally {
        platform?.mockRestore();
      }
    },
  };
});

vi.mock("../infra/gateway-supervision.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/gateway-supervision.js")>();
  return {
    ...actual,
    assertGatewayServiceMutationAllowed: (
      ...args: Parameters<typeof actual.assertGatewayServiceMutationAllowed>
    ) => {
      if (!mocks.emulateNativeInstall) {
        actual.assertGatewayServiceMutationAllowed(...args);
      }
    },
  };
});

export { mocks };

export const doctorServiceInspectionCases = [
  "inspection-failed",
  "runtime-only",
  "owned-unknown",
  "foreign-running",
  "foreign-unknown",
  "foreign-stopped",
  "foreign-stopped-loaded",
  "foreign-stopped-loaded-disabled",
  "foreign-stopped-loaded-unknown",
  "foreign-respawning",
  "unresolved-running",
  "unresolved-unknown",
  "unresolved-stopped",
  "unresolved-stopped-loaded",
  "unresolved-respawning",
  "absent",
  "absent-unknown",
  "absent-busy-port",
  "absent-unknown-port",
  "windows-ready",
  "windows-queued",
  "windows-startup-stopped",
  "windows-startup-unknown",
].flatMap((kind) => [
  { kind, updateParent: false },
  { kind, updateParent: true },
]);

export function seedMaintenanceStartupFailure(openDatabase: () => OpenClawStateDatabase) {
  openDatabase().db.exec(
    "INSERT INTO gateway_boot_lifecycle (boot_id, pid, started_at_ms, completed_at_ms, outcome, startup_reason) VALUES ('maintenance', 1, 1, 2, 'startup_failed', 'gateway.maintenance_required')",
  );
  return () =>
    openDatabase()
      .db.prepare("SELECT outcome FROM gateway_boot_lifecycle WHERE boot_id = 'maintenance'")
      .get();
}

export function registerDoctorConfigReceiptTests(
  runDoctorHealthFlow: typeof import("./doctor-health.js").runDoctorHealthFlow,
) {
  const ipcResultPath = "/tmp/openclaw-update-doctor-result.json";
  const resultRuntime = () => {
    vi.stubEnv("OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH", ipcResultPath);
    return createDoctorRuntime();
  };
  it.each([
    "unchanged",
    "ok",
    "error",
    "advisory",
    "interleaved",
    "partial-config",
    "unrestored-config",
    "restored-config",
    "schema-refusal",
    "wrapped-refusal",
  ] as const)("publishes consumed input and final committed hash (%s)", async (outcome) => {
    await withDoctorState(async (state) => {
      const resultPath = state.path("doctor-result.json");
      vi.stubEnv("OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH", resultPath);
      const runtime = createDoctorRuntime();
      let expectedHash = "unchanged";
      const expectedInputHash = hashConfigRaw(
        fs.existsSync(state.configPath) ? fs.readFileSync(state.configPath, "utf8") : null,
      );
      const configFailure = (
        publication: "partial" | "complete",
        rollbackStatus: "unknown" | "not-restored" | "restored",
      ) =>
        new ConfigWritePostCommitError({
          configPath: state.configPath,
          publication,
          rollbackStatus,
          cause: new Error("config publication failed"),
        });
      const stopFact = {
        check: "gateway-stop",
        code: "stale-gateway-stop-failed",
        message: "stop failed",
      };
      const failures: Partial<Record<typeof outcome, Error>> = {
        error: new Error("health failed after commit"),
        "partial-config": new AggregateError([configFailure("partial", "unknown")]),
        "unrestored-config": configFailure("complete", "not-restored"),
        "restored-config": configFailure("partial", "restored"),
        "schema-refusal": new UpdateSchemaRefusalError([], "2026.9.2", {
          targetVersion: "2026.9.5",
        }),
        "wrapped-refusal": new AggregateError([new UpdateDoctorError("stop failed", [stopFact])]),
      };
      const failure = failures[outcome];
      mocks.runContributions.mockImplementation(async (ctx) => {
        if (outcome === "unchanged") {
          return;
        }
        const io = createConfigIO({ env: state.env, pluginValidation: "skip" });
        // Preflight and final repair can both write. Only the last payload belongs in the receipt.
        for (const port of [19101, 19102, 19103]) {
          const written = await io.writeConfigFile({ gateway: { mode: "local", port } });
          expectedHash = written.persistedHash;
          if (outcome === "interleaved" && port === 19101) {
            fs.appendFileSync(state.configPath, "\n");
          }
        }
        fs.appendFileSync(state.configPath, "\n// operator saved after Doctor\n");
        if (failure) {
          throw failure;
        }
        if (outcome === "advisory") {
          ctx.postInstallDoctorResult = postInstallAdvisory;
        }
      });
      const completed = runDoctorHealthFlow(runtime, { nonInteractive: true });
      if (failure) {
        await expect(completed).rejects.toBe(failure);
      } else {
        await completed;
      }
      const result: UpdatePostInstallDoctorResult = {
        ...(outcome === "advisory" ? postInstallAdvisory : { status: failure ? "error" : "ok" }),
        configHash: expectedHash,
      };
      if (outcome === "partial-config" || outcome === "unrestored-config") {
        result.maintenanceRefusal = { kind: "data-at-risk", reason: "gateway-state-unverified" };
      } else if (outcome === "schema-refusal") {
        result.maintenanceRefusal = { kind: "data-at-risk", reason: "incomplete-migration" };
      }
      if (failure) {
        const [check, code]: [string, string] =
          outcome === "partial-config" || outcome === "unrestored-config"
            ? ["config-write", "rollback-state-unverified"]
            : outcome === "schema-refusal"
              ? ["database-schema-preflight", "update-schema-bump-unfenced"]
              : outcome === "wrapped-refusal"
                ? ["gateway-stop", "stale-gateway-stop-failed"]
                : ["doctor", "doctor-failed"];
        result.failureFacts = [
          { check, code, message: outcome === "error" ? failure.message : expect.any(String) },
        ];
      }
      if (outcome !== "unchanged") {
        result.configChanges = [
          { kind: "key", key: "gateway" },
          { kind: "key", key: "meta" },
        ];
        if (outcome !== "interleaved") {
          result.configInputHash = expectedInputHash;
        }
      }
      expect(mocks.writeUpdatePostInstallDoctorResult).toHaveBeenCalledWith({
        resultPath,
        result,
      });
      if (outcome !== "unchanged") {
        expect(expectedHash).not.toBe(hashConfigRaw(fs.readFileSync(state.configPath, "utf8")));
      }
      if (outcome === "advisory") {
        expect(mocks.writeUpdatePostInstallDoctorResult).toHaveBeenCalledBefore(runtime.exit);
        expect(runtime.exit).toHaveBeenCalledWith(86);
      }
    });
  });
  it.each([false, true])(
    "preserves health warnings in the update result (advisory=%s)",
    async (advisory) => {
      mocks.runContributions.mockImplementation(async (ctx) => {
        ctx.configResult.warnings = ['Plugin "fixture" config repair failed; config preserved.'];
        await createDoctorHealthContribution("doctor:fixture-warning", "Fixture warning", {
          healthChecks: {
            description: "Optional fixture maintenance",
            detect: async () => [
              {
                checkId: "core/doctor/fixture-warning",
                severity: "warning",
                message: "optional maintenance incomplete",
              },
            ],
          },
        }).run(ctx);
        if (advisory) {
          ctx.postInstallDoctorResult = postInstallAdvisory;
        }
      });
      const runtime = resultRuntime();

      await runDoctorHealthFlow(runtime, {});

      expect(mocks.writeUpdatePostInstallDoctorResult).toHaveBeenCalledWith({
        resultPath: ipcResultPath,
        result: {
          ...(advisory ? postInstallAdvisory : { status: "ok" }),
          configHash: "unchanged",
          warnings: [
            'Plugin "fixture" config repair failed; config preserved.',
            "core/doctor/fixture-warning: optional maintenance incomplete",
          ],
        },
      });
      expect(runtime.exit).not.toHaveBeenCalledWith(1);
      if (advisory) {
        expect(runtime.exit).toHaveBeenCalledWith(86);
      }
    },
  );
  it("reports a cron ownership refusal instead of a recoverable post-install advisory", async () => {
    mocks.runContributions.mockImplementation(async (ctx) => {
      ctx.configWriteRefusal = "cron-owner-safety";
      ctx.postInstallDoctorResult = postInstallAdvisory;
    });
    const runtime = resultRuntime();

    try {
      await runDoctorHealthFlow(runtime, {});
    } finally {
      vi.unstubAllEnvs();
    }

    expect(mocks.outro).toHaveBeenCalledWith("Doctor finished, but config fixes were not applied.");
    expect(mocks.outro).not.toHaveBeenCalledWith("Doctor complete.");
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(runtime.exit).not.toHaveBeenCalledWith(86);
    expect(mocks.writeUpdatePostInstallDoctorResult).toHaveBeenCalledWith({
      resultPath: ipcResultPath,
      result: {
        status: "error",
        configHash: "unchanged",
        failureFacts: [
          {
            check: "config-write",
            code: "cron-owner-safety",
            message: "Doctor config fixes were not applied.",
          },
        ],
      },
    });
  });
}
