import { note } from "../../packages/terminal-core/src/note.js";
import type { ConfigSnapshotReadMeasure } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import type { DeferredPluginMigration } from "../infra/deferred-plugin-migrations.js";
import { resolveUpdateRehearsalRoot } from "../infra/update-rehearsal-paths.js";
import { normalizePluginsConfig, resolveEffectiveEnableState } from "../plugins/config-state.js";
import type { PluginPayloadSmokeFailure } from "../plugins/payload-verification.js";
import {
  buildDegradedPluginsFromVerificationFailures,
  formatPluginVerificationDiagnostic,
  type DegradedPlugin,
} from "../plugins/runtime-degraded-state.js";
import { resolveCompatibilityHostVersion } from "../version.js";
import { measureDoctorConfigPreflightStep } from "./doctor-config-preflight-measure.js";
import type { PluginMigrationInspection } from "./doctor/shared/plugin-migration-availability.js";
import { shouldDeferConfiguredPluginInstallRepair } from "./doctor/shared/update-phase.js";

type StartupPluginVerificationDiagnostic = {
  kind: "plugin-verification";
  messages: string[];
};

type StartupPluginConvergenceResult = {
  blockingDiagnostic: StartupPluginVerificationDiagnostic | null;
  quarantinedPlugins: DegradedPlugin[];
  deferredPlugins?: DeferredPluginMigration[];
  migrationInspection?: PluginMigrationInspection;
};

async function planStartupPluginVerification(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  measure?: ConfigSnapshotReadMeasure;
}) {
  const { planStartupPluginConvergence } = await measureDoctorConfigPreflightStep(
    "plugin-plan-import",
    () => import("./doctor/shared/startup-plugin-convergence-plan.js"),
    params.measure,
  );
  return await measureDoctorConfigPreflightStep(
    "plugin-plan",
    () =>
      planStartupPluginConvergence({
        config: params.cfg,
        env: params.env,
      }),
    params.measure,
  );
}

function isStartupPluginVerificationFailureActive(params: {
  cfg: OpenClawConfig;
  failure: PluginPayloadSmokeFailure;
}): boolean {
  return resolveEffectiveEnableState({
    id: params.failure.pluginId,
    origin: "global",
    config: normalizePluginsConfig(params.cfg.plugins),
    rootConfig: params.cfg,
  }).enabled;
}

function buildStartupPluginQuarantine(params: {
  cfg: OpenClawConfig;
  failures: readonly PluginPayloadSmokeFailure[];
}): DegradedPlugin[] {
  return buildDegradedPluginsFromVerificationFailures(
    params.failures.filter(
      (failure) =>
        Boolean(failure.installPath) &&
        isStartupPluginVerificationFailureActive({ cfg: params.cfg, failure }),
    ),
  );
}

function formatStartupPluginSmokeFailure(failure: PluginPayloadSmokeFailure): string {
  return `Plugin "${failure.pluginId}": ${formatPluginVerificationDiagnostic({
    kind: "plugin-verification",
    reason: failure.reason,
    detail: failure.detail,
    ...(failure.installPath ? { installPath: failure.installPath } : {}),
  })}. Run \`openclaw update repair\` to retry plugin repair.`;
}

export async function runDoctorPluginConvergence(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  measure?: ConfigSnapshotReadMeasure;
}): Promise<StartupPluginConvergenceResult> {
  const plan = await planStartupPluginVerification(params);
  if (!plan.required) {
    return { blockingDiagnostic: null, quarantinedPlugins: [] };
  }
  const { inspectPluginMigrationAvailability } =
    await import("./doctor/shared/plugin-migration-availability.js");
  const isUpdateRehearsal = Boolean(resolveUpdateRehearsalRoot(params.env));
  if (isUpdateRehearsal) {
    // Shipped drivers run this preflight inside their fixed canary deadline.
    note(
      "Plugin refresh deferred to live update finalization; the canary verifies copied plugin payloads without downloading replacements.",
      "Doctor warnings",
    );
  }
  if (isUpdateRehearsal || shouldDeferConfiguredPluginInstallRepair(params.env)) {
    const payloads = await verifyStartupPluginPayloads(params, plan.installRecords);
    const { pending, ...migrationInspection } = await inspectPluginMigrationAvailability({
      ...params,
      installRecords: plan.installRecords,
      deferInstallation: true,
    });
    return {
      ...payloads,
      migrationInspection,
      deferredPlugins: [
        ...new Map(
          [...(payloads.deferredPlugins ?? []), ...pending].map((entry) => [entry.pluginId, entry]),
        ).values(),
      ],
    };
  }
  const { runPostCorePluginConvergence } = await measureDoctorConfigPreflightStep(
    "plugin-convergence-import",
    () => import("./doctor/shared/post-core-plugin-convergence.js"),
    params.measure,
  );
  const convergence = await measureDoctorConfigPreflightStep(
    "plugin-convergence",
    () =>
      runPostCorePluginConvergence({
        cfg: params.cfg,
        env: params.env,
        compatibilityHostVersion: resolveCompatibilityHostVersion(params.env),
      }),
    params.measure,
  );
  if (convergence.changes.length > 0) {
    note(convergence.changes.map((entry) => `- ${entry}`).join("\n"), "Doctor changes");
  }
  const notices = convergence.notices ?? [];
  if (notices.length > 0) {
    note(
      notices.map((notice) => `- ${notice.message} ${notice.guidance.join(" ")}`.trim()).join("\n"),
      "Doctor notices",
    );
  }
  const warnings = convergence.warnings.map((warning) =>
    `${warning.message} ${warning.guidance.join(" ")}`.trim(),
  );
  if (warnings.length > 0) {
    note(warnings.map((warning) => `- ${warning}`).join("\n"), "Doctor warnings");
  }
  const quarantinedPlugins = buildStartupPluginQuarantine({
    cfg: params.cfg,
    failures: convergence.smokeFailures,
  });
  const quarantinedPluginIds = new Set(quarantinedPlugins.map((plugin) => plugin.pluginId));
  const { pending, ...migrationInspection } = await inspectPluginMigrationAvailability({
    ...params,
    installRecords: convergence.installRecords,
    deferInstallation: false,
  });
  const deferredPlugins = new Map(pending.map((plugin) => [plugin.pluginId, plugin]));
  for (const warning of convergence.warnings) {
    if (warning.pluginId && !quarantinedPluginIds.has(warning.pluginId)) {
      deferredPlugins.set(warning.pluginId, {
        ...deferredPlugins.get(warning.pluginId),
        pluginId: warning.pluginId,
        reason: warning.reason,
        command: "openclaw update repair",
      });
    }
  }
  for (const plugin of quarantinedPlugins) {
    deferredPlugins.set(plugin.pluginId, {
      ...deferredPlugins.get(plugin.pluginId),
      pluginId: plugin.pluginId,
      reason: plugin.diagnostic.detail,
      command: "openclaw update repair",
    });
  }
  const nonBlockingWarningKeys = new Set(
    convergence.smokeFailures
      .filter(
        (failure) =>
          Boolean(failure.installPath) ||
          !isStartupPluginVerificationFailureActive({ cfg: params.cfg, failure }),
      )
      .map((failure) => JSON.stringify([failure.pluginId, `${failure.reason}: ${failure.detail}`])),
  );
  const blockingMessages = convergence.warnings
    .filter((warning) => {
      if (warning.pluginId && deferredPlugins.has(warning.pluginId)) {
        return false;
      }
      if (
        warning.kind === "repair" &&
        warning.pluginId &&
        quarantinedPluginIds.has(warning.pluginId)
      ) {
        return false;
      }
      return (
        !warning.pluginId ||
        !nonBlockingWarningKeys.has(JSON.stringify([warning.pluginId, warning.reason]))
      );
    })
    .map((warning) => `${warning.message} ${warning.guidance.join(" ")}`.trim());
  return {
    blockingDiagnostic:
      blockingMessages.length > 0
        ? { kind: "plugin-verification", messages: blockingMessages }
        : null,
    quarantinedPlugins,
    ...(migrationInspection.requiredPluginIds.length > 0 ||
    migrationInspection.inspectionRequiredPluginIds.length > 0 ||
    migrationInspection.statelessPluginIds.length > 0
      ? { migrationInspection }
      : {}),
    ...(deferredPlugins.size > 0 ? { deferredPlugins: [...deferredPlugins.values()] } : {}),
  };
}

export async function refreshStartupPluginQuarantine(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  measure?: ConfigSnapshotReadMeasure;
}): Promise<StartupPluginConvergenceResult> {
  const plan = await planStartupPluginVerification(params);
  if (!plan.required) {
    return { blockingDiagnostic: null, quarantinedPlugins: [] };
  }
  return verifyStartupPluginPayloads(params, plan.installRecords);
}

async function verifyStartupPluginPayloads(
  params: Parameters<typeof runDoctorPluginConvergence>[0],
  records: Record<string, PluginInstallRecord>,
): Promise<StartupPluginConvergenceResult> {
  const { runActivePluginPayloadSmokeCheck } = await measureDoctorConfigPreflightStep(
    "plugin-payload-verification-import",
    () => import("../plugins/active-payload-verification.js"),
    params.measure,
  );
  const smoke = await measureDoctorConfigPreflightStep(
    "plugin-payload-verification",
    () =>
      runActivePluginPayloadSmokeCheck({
        cfg: params.cfg,
        records,
        env: params.env,
      }),
    params.measure,
  );
  const result = mapStartupPluginQuarantineRefresh({
    cfg: params.cfg,
    failures: smoke.failures,
  });
  if (result.quarantinedPlugins.length > 0) {
    note(
      result.quarantinedPlugins
        .map(
          (plugin) =>
            `- ${formatStartupPluginSmokeFailure({
              pluginId: plugin.pluginId,
              reason: plugin.diagnostic.reason,
              detail: plugin.diagnostic.detail,
              ...(plugin.diagnostic.installPath
                ? { installPath: plugin.diagnostic.installPath }
                : {}),
            })}`,
        )
        .join("\n"),
      "Doctor warnings",
    );
  }
  return result;
}

function mapStartupPluginQuarantineRefresh(params: {
  cfg: OpenClawConfig;
  failures: readonly PluginPayloadSmokeFailure[];
}): StartupPluginConvergenceResult {
  const quarantinedPlugins = buildStartupPluginQuarantine(params);
  const blockingFailures = params.failures.filter(
    (failure) =>
      !failure.installPath &&
      isStartupPluginVerificationFailureActive({ cfg: params.cfg, failure }),
  );
  return {
    blockingDiagnostic: null,
    quarantinedPlugins,
    deferredPlugins: [
      ...blockingFailures,
      ...quarantinedPlugins.map((plugin) => ({
        pluginId: plugin.pluginId,
        detail: plugin.diagnostic.detail,
      })),
    ].map((failure) => ({
      pluginId: failure.pluginId,
      reason: failure.detail,
      command: "openclaw update repair",
    })),
  };
}

export function formatStartupPluginVerificationFailure(
  diagnostic: StartupPluginVerificationDiagnostic,
): string {
  return [
    "OpenClaw plugin verification failed; refusing to report the gateway ready.",
    ...diagnostic.messages.map((message) => `- ${message}`),
    "Resolve the plugin verification errors above, then restart the Gateway.",
  ].join("\n");
}
