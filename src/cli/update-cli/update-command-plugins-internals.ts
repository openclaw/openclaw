import { PLUGIN_CAPABILITY_CONSENT_REQUIRED } from "../../../packages/gateway-protocol/src/capability-consent-error-details.js";
import type { ConfigFileSnapshot } from "../../config/types.openclaw.js";
import {
  normalizeUpdateFailureFacts,
  type UpdateFailureFact,
} from "../../infra/update-failure-facts.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import type { PluginPayloadSmokeFailure } from "../../plugins/payload-verification.js";
import type { PluginUpdateOutcome } from "../../plugins/update.js";
import { formatCliCommand } from "../command-format.js";
import { createUpdateConfigFailure } from "./update-command-config-failure.js";

export type PostCorePluginUpdateResult = NonNullable<
  NonNullable<UpdateRunResult["postUpdate"]>["plugins"]
>;

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
): string[] {
  return [
    ...(result?.warnings ?? [])
      .filter(
        (warning) =>
          warning.reason === "plugin-target-unavailable" ||
          warning.reason === "plugin-operator-managed" ||
          warning.reason === "doctor-advisory",
      )
      .map((warning) => warning.message),
    ...(result?.npm?.outcomes ?? [])
      .filter((outcome) => outcome.code === "source-bundled-plugin")
      .map((outcome) => outcome.message),
  ];
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

// Producer evidence only. This does not assert activation, final config validity,
// or authority to execute a repair. Unknown installation requirements stay unsafe.
// Legacy status/reason remain independent until callers qualify their policy cutover.
export type PluginUpdateAssessment =
  | { kind: "no-payload-repair" }
  | { kind: "optional-repair-needed"; failures: PluginPayloadSmokeFailure[] }
  | { kind: "core-critical"; reason: ReturnType<typeof createUpdateConfigFailure>["reason"] }
  | {
      kind: "unsafe";
      reason:
        | "capability-consent-required"
        | "integrity-drift"
        | "unowned-plugin-payload"
        | "required-plugin-unavailable"
        | "plugin-requirement-unknown"
        | "convergence-failed"
        | "plugin-disabled-after-update";
    };

export type ProducedPluginUpdateResult = PostCorePluginUpdateResult & {
  assessment: PluginUpdateAssessment;
};

export function assessPluginUpdate(params: {
  smokeFailures: PluginPayloadSmokeFailure[];
  disabledPluginIds: readonly string[];
  errored: boolean;
  outcomes: PluginUpdateOutcome[];
  integrityDrift: boolean;
  requirements: Readonly<Record<string, "optional" | "required">>;
}): PluginUpdateAssessment {
  if (
    params.outcomes.some(
      (outcome) =>
        outcome.status === "error" && outcome.code === PLUGIN_CAPABILITY_CONSENT_REQUIRED,
    )
  ) {
    return { kind: "unsafe", reason: "capability-consent-required" };
  }
  if (params.integrityDrift) {
    return { kind: "unsafe", reason: "integrity-drift" };
  }
  const failures = params.smokeFailures;
  if (failures.some((failure) => !failure.installPath)) {
    return { kind: "unsafe", reason: "unowned-plugin-payload" };
  }
  const unavailablePluginIds = [
    ...failures.map((failure) => failure.pluginId),
    ...params.disabledPluginIds,
  ];
  if (unavailablePluginIds.some((pluginId) => params.requirements[pluginId] === "required")) {
    return { kind: "unsafe", reason: "required-plugin-unavailable" };
  }
  if (unavailablePluginIds.some((pluginId) => params.requirements[pluginId] !== "optional")) {
    return { kind: "unsafe", reason: "plugin-requirement-unknown" };
  }
  if (params.disabledPluginIds.length > 0) {
    // The disable outcome loses its failure code. Optionality cannot establish
    // that a consent/integrity refusal is safe to turn into repairable degradation.
    return { kind: "unsafe", reason: "plugin-disabled-after-update" };
  }
  if (failures.length > 0) {
    // Outcomes retain earlier failed repair attempts, including repaired payloads.
    // Active payload failures come from final verification, not that history.
    return { kind: "optional-repair-needed", failures };
  }
  return params.errored
    ? { kind: "unsafe", reason: "convergence-failed" }
    : { kind: "no-payload-repair" };
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
