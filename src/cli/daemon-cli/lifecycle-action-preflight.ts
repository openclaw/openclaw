import { readConfigFileSnapshot } from "../../config/config.js";
import { resolveFutureConfigActionBlock } from "../../config/future-version-guard.js";
import { renderConfigValidationIssueLines } from "../../config/issue-location.js";
import { isPluginPackagingRuntimeOutputInvalidConfigSnapshot } from "../../config/recovery-policy.js";
import type { ConfigFileSnapshot } from "../../config/types.openclaw.js";
import { formatPluginPackagingRuntimeOutputRecoveryHint } from "../config-recovery-hints.js";

/** Service lifecycle actions; only start/restart bring the gateway up. */
type DaemonServiceAction = "start" | "restart" | "stop" | "uninstall";

type ServiceActionPreflightFailure = {
  message: string;
  hints?: string[];
};

/** Startup admission, or a diagnostic to report after recovery actions. */
export async function getServiceActionPreflightFailure(
  action: DaemonServiceAction,
): Promise<ServiceActionPreflightFailure | null> {
  let snapshot: ConfigFileSnapshot;
  try {
    snapshot = await readConfigFileSnapshot({
      observe: false,
    });
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
  } catch {
    return null;
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
