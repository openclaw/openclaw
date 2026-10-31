import {
  DEFERRED_UPDATE_MODEL_RETIREMENT_WARNING,
  hasCompletedUpdateModelRetirement,
} from "./update-deferred-model-retirement.js";
import type { UpdateRunRecord } from "./update-run-record.js";
import type { UpdateStepResult } from "./update-step-result.js";

type DeferredUpdateWarningOptions = {
  finallyReportedPluginIds?: ReadonlySet<string>;
  readUpdateRun?: () => Pick<UpdateRunRecord, "steps"> | undefined;
};

/**
 * Retire model warnings only after the selected run records completion. Plugin
 * warnings retire when their obligation leaves the pending ledger, a later warning
 * supersedes them, or the caller reports that plugin's final state itself.
 * Matches both shipped warning forms without reading retired migration reports.
 * Messages are ordered oldest first.
 */
export async function readRetiredDeferredUpdateWarnings(
  messages: readonly (string | undefined)[],
  options: DeferredUpdateWarningOptions = {},
): Promise<ReadonlySet<string>> {
  const retired = new Set<string>();
  if (
    messages.includes(DEFERRED_UPDATE_MODEL_RETIREMENT_WARNING) &&
    hasCompletedUpdateModelRetirement(options.readUpdateRun?.())
  ) {
    retired.add(DEFERRED_UPDATE_MODEL_RETIREMENT_WARNING);
  }
  const pluginWarnings = new Map<string, string>();
  const latestByPlugin = new Map<string, string>();
  for (const message of messages) {
    const pluginId =
      message &&
      /^Plugin "([^"]+)" (?:state migration is pending|data\/settings upgrade is unfinished):/u.exec(
        message,
      )?.[1];
    if (message && pluginId) {
      pluginWarnings.set(message, pluginId);
      latestByPlugin.set(pluginId, message);
    }
  }
  if (!pluginWarnings.size) {
    return retired;
  }
  const { readDeferredPluginMigrationsAsync } = await import("./deferred-plugin-migrations.js");
  const pending = new Set(
    (await readDeferredPluginMigrationsAsync()).map(({ pluginId }) => pluginId),
  );
  for (const [message, pluginId] of pluginWarnings) {
    if (
      !pending.has(pluginId) ||
      latestByPlugin.get(pluginId) !== message ||
      options.finallyReportedPluginIds?.has(pluginId)
    ) {
      retired.add(message);
    }
  }
  return retired;
}

/**
 * Drops warnings a later repair in the same pass settled or superseded, such as
 * post-session plugin migrations finishing after config preflight reported them
 * pending. The ledger is authoritative; an unreadable ledger keeps every warning.
 */
export async function retainCurrentDeferredUpdateWarnings(
  warnings: readonly string[],
  options: DeferredUpdateWarningOptions = {},
): Promise<string[]> {
  const retired = await readRetiredDeferredUpdateWarnings(warnings, options).catch(
    () => new Set<string>(),
  );
  return warnings.filter((warning) => !retired.has(warning));
}

/** Keep the original process outcome while replacing its settled warning projection. */
export function retireDeferredUpdateStepWarnings(
  step: UpdateStepResult,
  retired: ReadonlySet<string>,
): UpdateStepResult {
  const reported = step.warnings ?? (step.advisory ? [step.advisory.message] : []);
  const warnings = reported.filter((message) => !retired.has(message));
  if (warnings.length === reported.length) {
    return step;
  }
  return {
    ...step,
    warnings,
    ...(step.advisory
      ? {
          advisory: {
            ...step.advisory,
            message: warnings.join("\n") || "Warnings settled during post-core convergence.",
          },
        }
      : {}),
  };
}
