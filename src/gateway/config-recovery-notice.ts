import path from "node:path";
import { formatConfigIssueLines } from "../config/issue-format.js";
import { resolveMainSessionKey } from "../config/sessions/main-session.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { enqueueSystemEvent } from "../infra/system-events.js";

export type ConfigRecoveryNoticePhase = "startup" | "reload";

type ConfigRecoveryIssue = {
  path?: string | null;
  message: string;
};

const MAX_RECOVERY_ISSUES = 5;

export function formatConfigRecoveryIssueSummary(
  issues: ReadonlyArray<ConfigRecoveryIssue> | undefined,
): string {
  if (!issues || issues.length === 0) {
    return "";
  }
  const visible = formatConfigIssueLines(issues.slice(0, MAX_RECOVERY_ISSUES), "", {
    normalizeRoot: true,
  });
  const hidden = issues.length - visible.length;
  const suffix = hidden > 0 ? `; ...and ${hidden} more` : "";
  return ` Validation issues: ${visible.join("; ")}${suffix}.`;
}

export function formatConfigRecoveryNotice(params: {
  phase: ConfigRecoveryNoticePhase;
  reason: string;
  configPath: string;
  issues?: ReadonlyArray<ConfigRecoveryIssue>;
}): string {
  const configName = path.basename(params.configPath) || "openclaw.json";
  return [
    `Config recovery warning: OpenClaw restored ${configName} from the last-known-good backup during ${params.phase} (${params.reason}).`,
    `The rejected config was invalid and was preserved as a timestamped .clobbered.* file.${formatConfigRecoveryIssueSummary(params.issues)}`,
    `Do not write ${configName} again unless you validate the full config first.`,
  ].join(" ");
}

export function enqueueConfigRecoveryNotice(params: {
  cfg: OpenClawConfig;
  phase: ConfigRecoveryNoticePhase;
  reason: string;
  configPath: string;
  issues?: ReadonlyArray<ConfigRecoveryIssue>;
}): boolean {
  return enqueueSystemEvent(formatConfigRecoveryNotice(params), {
    sessionKey: resolveMainSessionKey(params.cfg),
    contextKey: `config-recovery:${params.phase}:${params.reason}`,
  });
}
