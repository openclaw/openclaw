import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import {
  ConfigReadOnlyError,
  NixModeConfigMutationError,
} from "../../config/config-write-guard.js";
import { ConfigMutationConflictError } from "../../config/mutation-conflict.js";
import type { ConfigFileSnapshot } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { resolveOpenClawReleaseCohortVersion } from "../../infra/npm-registry-spec.js";
import { readPackageVersion } from "../../infra/package-json.js";
import { UpdateDoctorError } from "../../infra/update-doctor-result.js";
import {
  normalizeUpdateFailureFacts,
  type UpdateFailureFact,
} from "../../infra/update-failure-facts.js";
import { readPluginVersionDriftWarning } from "../../infra/update-plugin-version-warnings.js";
import { UpdateRequesterRevokedError } from "../../infra/update-requester-authority.js";
import type { UpdateOwedStepId } from "../../infra/update-run-owed-step.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import type { PluginInstallBatchTarget } from "../../plugins/install-runtime-batch.js";
import type { MissingPluginInstallPayload } from "../../plugins/payload-verification.js";
import { hasCommandProcessCleanupError } from "../../process/exec-result.js";
import { formatCliCommand } from "../command-format.js";
import { createUpdateConfigFailure } from "./update-command-config-failure.js";
import { UpdateCommandRecoveryPendingError } from "./update-command-recovery-error.js";

export type PostCorePluginUpdateResult = NonNullable<
  NonNullable<UpdateRunResult["postUpdate"]>["plugins"]
> & {
  /** Internal updater receipt, captured before the plugin lifecycle lease is released. */
  reloadTargets?: PluginInstallBatchTarget[];
};

export function formatMissingPluginPayloadReason(entry: MissingPluginInstallPayload): string {
  return entry.reason === "missing-install-path"
    ? "installPath is missing"
    : entry.reason === "missing-package-json"
      ? `package.json is missing under ${entry.installPath}`
      : `package directory is missing: ${entry.installPath}`;
}

export function createPostCorePluginUpdateResult(
  result: Pick<PostCorePluginUpdateResult, "status"> & Partial<PostCorePluginUpdateResult>,
): PostCorePluginUpdateResult {
  return {
    changed: false,
    sync: { changed: false, switchedToBundled: [], switchedToNpm: [], warnings: [], errors: [] },
    npm: { changed: false, outcomes: [] },
    integrityDrifts: [],
    ...result,
  };
}

/** Producer-classified notices shared by current and published updater handoffs. */
export function collectPostCorePluginAdvisories(
  result: PostCorePluginUpdateResult | undefined,
  doctorWarnings: readonly string[] = [],
): string[] {
  const warnings = result?.warnings ?? [];
  const alreadyReported = new Set(
    [
      ...warnings
        .filter(({ reason }) => reason === "plugin-target-unavailable")
        .map(({ pluginId }) => pluginId),
      ...[
        ...doctorWarnings,
        ...warnings
          .filter(({ reason }) => reason === "doctor-advisory")
          .map(({ message }) => message),
      ].map((message) => readPluginVersionDriftWarning(message)?.pluginId),
    ].filter((pluginId) => pluginId !== undefined),
  );
  return [
    ...warnings
      .filter(
        (warning) =>
          warning.reason === "plugin-target-unavailable" ||
          warning.reason === "plugin-operator-managed" ||
          warning.reason === "plugin-config-conflict" ||
          warning.reason === "doctor-advisory",
      )
      .map((warning) => warning.message),
    ...(result?.npm?.outcomes ?? [])
      .filter((outcome) => outcome.code === "source-bundled-plugin")
      .map((outcome) => outcome.message),
    // Append new warning categories after the rows known to shipped parent updaters.
    ...warnings
      .filter(
        (warning) =>
          warning.reason === "plugin-version-mismatch" &&
          (!warning.pluginId || !alreadyReported.has(warning.pluginId)),
      )
      .map((warning) => warning.message),
  ];
}

/** Final Doctor can repair an earlier mismatch. Require the committed record and payload to agree. */
export async function refreshPostCoreVersionMismatchWarnings(
  result: PostCorePluginUpdateResult,
  root: string,
): Promise<PostCorePluginUpdateResult> {
  const warnings = result.warnings ?? [];
  const candidates = new Set(
    warnings.flatMap(({ reason, pluginId }) =>
      reason === "plugin-version-mismatch" && pluginId ? [pluginId] : [],
    ),
  );
  if (
    !candidates.size ||
    result.status === "error" ||
    warnings.some(
      ({ reason }) => reason === "plugin-config-conflict" || reason === "plugin-convergence",
    )
  ) {
    return result;
  }
  try {
    const { readPersistedInstalledPluginIndexInstallRecordsAsync } =
      await import("../../plugins/installed-plugin-index-record-reader.js");
    const { createPluginCache, withPluginCache } = await import("../../plugins/plugin-cache.js");
    // A fresh Doctor can commit after the parent's metadata cache was populated.
    await using cache = createPluginCache();
    const [target, records] = await Promise.all([
      readPackageVersion(root),
      withPluginCache(cache, () => readPersistedInstalledPluginIndexInstallRecordsAsync()),
    ]);
    if (!target || !records) {
      return result;
    }
    const cohort = resolveOpenClawReleaseCohortVersion(target);
    const repaired = new Map<string, string>();
    for (const pluginId of candidates) {
      const record = Object.hasOwn(records, pluginId) ? records[pluginId] : undefined;
      const version = record?.resolvedVersion ?? record?.version;
      if (
        record?.source === "npm" &&
        record.installPath &&
        version &&
        resolveOpenClawReleaseCohortVersion(version) === cohort &&
        (await readPackageVersion(record.installPath)) === version
      ) {
        repaired.set(pluginId, version);
      }
    }
    if (!repaired.size) {
      return result;
    }
    const remaining = warnings.filter(
      ({ reason, pluginId }) =>
        !pluginId ||
        !repaired.has(pluginId) ||
        (reason !== "plugin-version-mismatch" && reason !== "plugin-target-unavailable"),
    );
    const outcomes = [
      ...result.npm.outcomes,
      ...Array.from(repaired).map(([pluginId, nextVersion]) => ({
        pluginId,
        status: "updated" as const,
        nextVersion,
        message: `Plugin "${pluginId}" is now at ${nextVersion} after post-plugin checks.`,
      })),
    ];
    const finalOutcomes = new Map(outcomes.map((outcome) => [outcome.pluginId, outcome]));
    const settled =
      result.status === "warning" &&
      !result.reason &&
      !remaining.length &&
      !result.sync.warnings.length &&
      !result.sync.errors.length &&
      ![...finalOutcomes.values()].some(({ status }) => status === "error");
    return {
      ...result,
      status: settled ? "ok" : result.status,
      warnings: remaining,
      npm: {
        ...result.npm,
        outcomes,
      },
    };
  } catch {
    // An unreadable ledger or package is not proof of repair.
    return result;
  }
}

export function collectPostCorePluginFailureFacts(
  result: PostCorePluginUpdateResult,
  env: NodeJS.ProcessEnv = process.env,
): UpdateFailureFact[] {
  if (result.status !== "error") {
    return [];
  }
  if (result.failureFacts?.length) {
    return normalizeUpdateFailureFacts(result.failureFacts, env);
  }
  const failures: UpdateFailureFact[] = result.npm.outcomes
    .filter((outcome) => outcome.status === "error")
    .map((outcome) => ({
      check: "plugin-update",
      code: outcome.code ?? "plugin-update-failed",
      pluginId: outcome.pluginId,
      message: outcome.message,
    }));
  if (!failures.length) {
    failures.push(
      ...result.sync.errors.map((message) => ({
        check: "plugin-sync",
        code: "plugin-sync-failed",
        message,
      })),
    );
  }
  if (!failures.length) {
    failures.push({
      check: "plugin-convergence",
      code: result.reason ?? "post-update-plugins",
      message: result.warnings?.[0]?.message,
    });
  }
  return normalizeUpdateFailureFacts(failures, env);
}

export type PluginUpdateWarning = NonNullable<PostCorePluginUpdateResult["warnings"]>[number];

export function createPluginUpdateWarning(params: {
  pluginId?: string;
  reason: string;
  kind?: "update" | "load";
  env?: NodeJS.ProcessEnv;
}): PluginUpdateWarning {
  const command = formatCliCommand(
    params.kind === "load"
      ? "openclaw doctor --fix"
      : params.pluginId
        ? `openclaw plugins update ${params.pluginId}`
        : "openclaw update repair",
    params.env,
  );
  const nextAction = `Run \`${command}\` to ${params.kind === "load" ? "check and repair the load problem" : "retry"}.`;
  return {
    ...(params.pluginId ? { pluginId: params.pluginId } : {}),
    reason: params.reason,
    message: params.pluginId
      ? `Plugin "${params.pluginId}" could not be ${params.kind === "load" ? "loaded" : "updated"}. ${nextAction}`
      : `Plugin updates could not complete. ${nextAction}`,
    guidance: [command],
  };
}

/** The plugin steps an update may owe. Each travels as a warning whose reason is its step id. */
const OWED_PLUGIN_STEP_IDS = [
  "plugin-convergence",
  "post-plugin-doctor",
] as const satisfies readonly UpdateOwedStepId[];
type OwedPluginStep = { id: (typeof OWED_PLUGIN_STEP_IDS)[number]; reason: string };

export function createOwedPluginStepWarning(
  id: OwedPluginStep["id"],
  error: unknown,
): PluginUpdateWarning {
  return {
    reason: id,
    message: formatErrorMessage(error),
    guidance: [formatCliCommand("openclaw update repair")],
  };
}

/** The steps a plugin phase left owed. A failed phase did not keep its result and owes nothing. */
export function listOwedPluginSteps(
  plugins: PostCorePluginUpdateResult | undefined,
): OwedPluginStep[] {
  if (!plugins || plugins.status === "error") {
    return [];
  }
  return (plugins.warnings ?? []).flatMap((warning) => {
    const id = OWED_PLUGIN_STEP_IDS.find((candidate) => candidate === warning.reason);
    return id ? [{ id, reason: warning.message }] : [];
  });
}

/**
 * Whether a kept plugin phase finished convergence. One deferred by a config conflict rolled its
 * plugin work back, so it proves nothing about what an earlier run owes.
 */
export function pluginPhaseConverged(plugins: PostCorePluginUpdateResult | undefined): boolean {
  return (
    (plugins?.status === "ok" || plugins?.status === "warning") &&
    !plugins.warnings?.some((warning) => warning.reason === "plugin-config-conflict")
  );
}

/**
 * A cohort rollback restores the previous plugin set after most failures. These are different:
 * config, Doctor, child processes or update authority are unsettled, so the update still fails.
 */
export function pluginConvergenceFailureBlocksUpdate(error: unknown): boolean {
  return (
    hasCommandProcessCleanupError(error) ||
    collectNestedErrorCandidates(error).some(
      (cause) =>
        cause instanceof ConfigMutationConflictError ||
        cause instanceof ConfigReadOnlyError ||
        cause instanceof NixModeConfigMutationError ||
        cause instanceof UpdateDoctorError ||
        cause instanceof UpdateRequesterRevokedError ||
        cause instanceof UpdateCommandRecoveryPendingError,
    )
  );
}

export function appendPluginUpdateWarnings(
  result: UpdateRunResult,
  warnings: readonly PluginUpdateWarning[],
): UpdateRunResult {
  if (warnings.length === 0) {
    return result;
  }
  const plugins =
    result.postUpdate?.plugins ?? createPostCorePluginUpdateResult({ status: "warning" });
  const combined = [...(plugins.warnings ?? [])];
  for (const warning of warnings) {
    if (
      !combined.some(
        (entry) => entry.pluginId === warning.pluginId && entry.reason === warning.reason,
      )
    ) {
      combined.push(warning);
    }
  }
  return {
    ...result,
    postUpdate: {
      ...result.postUpdate,
      plugins: {
        ...plugins,
        status: plugins.status === "error" ? "error" : "warning",
        warnings: combined,
      },
    },
  };
}

/** Invalid config cannot establish the plugin set required for restart. */
export function buildInvalidConfigPostCoreUpdateResult(snapshot: ConfigFileSnapshot): {
  message: string;
  guidance: string[];
  result: PostCorePluginUpdateResult & Pick<ReturnType<typeof createUpdateConfigFailure>, "reason">;
} {
  const failure = createUpdateConfigFailure(snapshot);
  const guidance = [
    ...(failure.nextAction ? [failure.nextAction] : []),
    "Once the config loads successfully, rerun `openclaw update repair`.",
  ];
  const message = `Plugin post-update convergence skipped; refusing to restart the gateway with an unverified plugin set.\n${failure.message}`;
  return {
    message,
    guidance,
    result: {
      ...createPostCorePluginUpdateResult({ status: "error" }),
      reason: failure.reason,
      failureFacts: failure.failureFacts,
      warnings: [{ reason: failure.reason, message, guidance }],
    },
  };
}
