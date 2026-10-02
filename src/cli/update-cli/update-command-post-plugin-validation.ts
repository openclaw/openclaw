import {
  normalizeUpdateFailureFacts,
  type UpdateFailureFact,
} from "../../infra/update-failure-facts.js";
import type { PostCorePluginUpdateResult } from "./update-command-plugins.js";

export const POST_PLUGIN_DOCTOR_EXECUTION_FAILED_REASON = "post-plugin-doctor-execution-failed";
export const POST_PLUGIN_CONFIG_VALIDATION_EXECUTION_FAILED_REASON =
  "post-plugin-config-validation-execution-failed";

export type PostPluginConfigValidation =
  | { status: "valid" }
  | { status: "invalid" | "execution-failed"; failureFacts: UpdateFailureFact[] };

export function applyPostPluginConfigValidation(
  pluginUpdate: PostCorePluginUpdateResult,
  validation: PostPluginConfigValidation,
): PostCorePluginUpdateResult {
  if (validation.status === "valid") {
    return pluginUpdate;
  }
  const result = validation.failureFacts.length
    ? {
        ...pluginUpdate,
        failureFacts: normalizeUpdateFailureFacts([
          ...(pluginUpdate.failureFacts ?? []),
          ...validation.failureFacts,
        ]),
      }
    : pluginUpdate;
  // Only actual target-schema issues supersede a failed Doctor. An unavailable
  // validator cannot replace the earlier failure or authorize another repair.
  if (
    pluginUpdate.status === "error" &&
    (pluginUpdate.reason !== POST_PLUGIN_DOCTOR_EXECUTION_FAILED_REASON ||
      validation.status === "execution-failed")
  ) {
    return result;
  }
  const executionFailed = validation.status === "execution-failed";
  return {
    ...result,
    status: "error",
    reason: executionFailed
      ? POST_PLUGIN_CONFIG_VALIDATION_EXECUTION_FAILED_REASON
      : "post-plugin-doctor-invalid-config",
    warnings: [
      ...(pluginUpdate.warnings ?? []),
      executionFailed
        ? {
            // Released readers omit failureFacts but retain this bounded warning.
            reason: validation.failureFacts
              .map((fact) => fact.message)
              .filter(Boolean)
              .join("; "),
            message: "Config validation could not complete; refusing to restart.",
            guidance: [
              "Resolve the validation command failure, then rerun `openclaw update repair`.",
            ],
          }
        : {
            reason: "Config remained invalid after updated plugin migrations.",
            message:
              "Post-update plugin migration did not produce a valid config; refusing to restart.",
            guidance: ["Run `openclaw doctor --fix`, then rerun `openclaw update repair`."],
          },
    ],
  };
}
