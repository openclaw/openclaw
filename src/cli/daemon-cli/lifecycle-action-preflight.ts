import { readConfigFileSnapshot } from "../../config/config.js";
import { resolveFutureConfigActionBlock } from "../../config/future-version-guard.js";
import { renderConfigValidationIssueLines } from "../../config/issue-location.js";
import { isPluginPackagingRuntimeOutputInvalidConfigSnapshot } from "../../config/recovery-policy.js";
import type { ConfigFileSnapshot } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { formatPluginPackagingRuntimeOutputRecoveryHint } from "../config-recovery-hints.js";

/** Startup admission, or a diagnostic to report after recovery actions. */
export async function getServiceActionPreflightFailure(
  action: "start" | "restart" | "stop" | "uninstall",
): Promise<{
  message: string;
  hints?: string[];
} | null> {
  let snapshot: ConfigFileSnapshot;
  try {
    if (action === "restart") {
      // Selection failures are candidate-config diagnostics, not a veto on the installed service.
      const { readConfigSnapshotForEngineSelection } =
        await import("../../commands/config-preflight-snapshot.js");
      snapshot = await readConfigSnapshotForEngineSelection(process.env, { isolateEnv: false });
      if (snapshot.valid) {
        snapshot = await readConfigFileSnapshot({ observe: false });
      }
    } else {
      snapshot = await readConfigFileSnapshot({
        observe: false,
        // Recovery diagnostics must not load plugin state after service shutdown/removal.
        ...(action === "stop" || action === "uninstall"
          ? { pluginValidation: "core-only" as const }
          : {}),
      });
    }
    if (!snapshot.valid) {
      const message =
        snapshot.issues.length > 0
          ? renderConfigValidationIssueLines(snapshot, "").join("\n")
          : "Unknown validation issue.";
      return {
        message,
        ...(isPluginPackagingRuntimeOutputInvalidConfigSnapshot(snapshot)
          ? { hints: formatPluginPackagingRuntimeOutputRecoveryHint().split("\n") }
          : {}),
      };
    }
  } catch (error) {
    return action === "restart" ? { message: formatErrorMessage(error) } : null;
  }

  const futureBlock = resolveFutureConfigActionBlock({
    action: `${action} the gateway service`,
    snapshot,
  });
  if (futureBlock) {
    return {
      message:
        action === "start"
          ? futureBlock.message
          : `Config was last written by OpenClaw ${futureBlock.touchedVersion}; this binary is ${futureBlock.currentVersion}.`,
      hints: futureBlock.hints,
    };
  }
  return null;
}
