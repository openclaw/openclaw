import { PLUGIN_CAPABILITY_CONSENT_REQUIRED } from "../../../packages/gateway-protocol/src/capability-consent-error-details.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import type { PluginPayloadSmokeFailure } from "../../plugins/payload-verification.js";
import type { PluginUpdateOutcome } from "../../plugins/update.js";

export type PostCorePluginUpdateResult = NonNullable<
  NonNullable<UpdateRunResult["postUpdate"]>["plugins"]
>;

// Producer evidence only. This does not assert activation, final config validity,
// or authority to execute a repair. Unknown installation requirements stay unsafe.
// Legacy status/reason remain independent until callers qualify their policy cutover.
export type PluginUpdateAssessment =
  | { kind: "no-payload-repair" }
  | { kind: "optional-repair-needed"; failures: PluginPayloadSmokeFailure[] }
  | { kind: "core-critical"; reason: "invalid-config" }
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

/**
 * Build the post-core-update result we return when the active config cannot
 * even be parsed. Mandatory post-core convergence requires a parseable
 * config to know which plugins are configured; if one isn't available, we
 * refuse to restart the gateway and surface this as a hard error so the
 * existing `status === "error"` => `exit 1` pre-restart gate fires.
 */
export function buildInvalidConfigPostCoreUpdateResult(): {
  message: string;
  guidance: string[];
  result: PostCorePluginUpdateResult;
} {
  const guidance = [
    "Run `openclaw doctor` to inspect the config validation errors.",
    "Once the config parses, rerun `openclaw update repair`.",
  ];
  const message =
    "Plugin post-update convergence skipped because the config is invalid; refusing to restart the gateway with an unverified plugin set.";
  return {
    message,
    guidance,
    result: {
      status: "error",
      reason: "invalid-config",
      changed: false,
      sync: {
        changed: false,
        switchedToBundled: [],
        switchedToNpm: [],
        warnings: [],
        errors: [],
      },
      npm: {
        changed: false,
        outcomes: [],
      },
      integrityDrifts: [],
      warnings: [{ reason: "invalid-config", message, guidance }],
    },
  };
}
