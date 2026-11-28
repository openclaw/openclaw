/** Renders operator control guidance from the configured command and tool capabilities. */
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import {
  hasNativeApprovalPromptRuntimeCapability,
  isKnownNativeApprovalPromptChannel,
} from "../channels/plugins/native-approval-prompt.js";

export function buildOpenClawControlSection({
  hasOpenClaw,
  hasGateway,
  hasExec,
  restartCommandsEnabled,
  setupIssue,
}: {
  hasOpenClaw: boolean;
  hasGateway: boolean;
  hasExec: boolean;
  restartCommandsEnabled: boolean;
  setupIssue?: string;
}): string[] {
  return [
    "## OpenClaw Control",
    "Do not invent commands.",
    setupIssue
      ? setupIssue
      : hasOpenClaw
        ? "For this Gateway's config writes, channels, plugins, agents, or models/providers: use `openclaw`. Exact commands need no helper inference: `config set <path> <value>`, `config unset|get|schema <path>`, `config validate` (normal approval/write checks apply)."
        : hasGateway
          ? "Config read: `gateway` (`config.get|config.schema.lookup`) when exposed; config writes require `openclaw`."
          : "",
    "Config recovery: if broken config or a missing setup tool blocks an explicit local repair, use existing file/exec permissions: prefer `openclaw config`, else save a rollback copy, repair narrowly, validate, read back. Never override approvals, readonly config, containment, disabled tools, or access/approval/ownership policies.",
    ...(!hasOpenClaw || setupIssue
      ? [
          "`/openclaw` rescue only runs supported commands—never instruct users to send free-form setup or tool-enable requests to it.",
        ]
      : []),
    [
      "Updates, on explicit owner request only: identify the installation actually serving and follow its documented procedure (built-in updater for standard installs; a served Git checkout's in-place procedure only when the host authorizes this caller, no revision needed; Git on source installs only for a requested exact revision with host maintenance authorization). If unclear, report the blocker. Shell access is not update authority; change install method only on explicit request.",
      ...(restartCommandsEnabled
        ? ["Owners can send `/update` in chat when `commands.restart` is enabled."]
        : []),
      hasGateway
        ? "On explicit owner/scheduled maintenance, `gateway` update.run only for built-in-updater installs (supervised restart); also `restart`, `update.cleanup` (`dryRun` previews; deletes rollback copies, so require an explicit request). Report accepted/deferred accurately; scheduling != completion."
        : "",
      "Missing chat ownership: Control UI owner setup or Gateway operator. Keep a working restart path before stopping; if runtime admission refuses, report it and never bypass via `exec`.",
    ]
      .filter(Boolean)
      .join(" "),
    hasExec
      ? "Remote hosts: verify it is not this Gateway, then use exec/SSH under normal approvals (`openclaw` only targets local; do not block on local agent-ID migration)."
      : "",
    "",
  ];
}

export function buildExecApprovalPromptGuidance(params: {
  runtimeChannel?: string;
  inlineButtonsEnabled?: boolean;
  runtimeCapabilities?: readonly string[];
}) {
  const runtimeChannel = normalizeOptionalLowercaseString(params.runtimeChannel);
  const usesNativeApprovalUi =
    params.inlineButtonsEnabled ||
    hasNativeApprovalPromptRuntimeCapability(params.runtimeCapabilities) ||
    isKnownNativeApprovalPromptChannel(runtimeChannel);
  const policyGuidance =
    "Submit task-authorized commands via the tool and let policy decide approval; request approval only from an actual approval-pending result (never invent IDs or bare `/approve`).";
  if (usesNativeApprovalUi) {
    return `${policyGuidance} Approval-pending: native card/buttons first; plain \`/approve\` only if manual, copying exact \`Reply with:\`.`;
  }
  return `${policyGuidance} Approval-pending: send exact \`/approve\` from \`Reply with:\`; never ask for another code.`;
}
