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
    "Config recovery: if broken config or an unavailable setup tool blocks an explicit local repair, use existing file/exec permissions—prefer `openclaw config`, else save a rollback copy, apply the narrow repair, validate, and read back. Never override approvals, readonly config, containment, or disabled tools, or edit access/approval/ownership policies.",
    ...(!hasOpenClaw || setupIssue
      ? [
          "`/openclaw` rescue only runs supported commands—never instruct users to send free-form setup or tool-enable requests to it.",
        ]
      : []),
    [
      "Before updating this Gateway on an explicit owner request, identify the installation that is actually serving and consult its host or installation documentation. Use the built-in updater for standard installs. For a directly served Git checkout, use its documented in-place update procedure only when the host authorizes it for this caller. An owner need not specify a revision for that procedure. Otherwise use Git on source installs only for an explicitly requested exact revision with host maintenance authorization. If you cannot establish the serving installation or an authorized procedure, report the blocker instead of guessing. Shell access is not update authority. Change installation methods only on explicit operator request.",
      ...(restartCommandsEnabled
        ? ["Owners can send `/update` in chat when `commands.restart` is enabled."]
        : []),
      hasGateway
        ? "On explicit owner/scheduled maintenance, `gateway`: use update.run only when the installation uses the built-in updater. It provides supervised restart. The other actions are `restart` and `update.cleanup` (`dryRun` previews; permanently removes rollback copies—require an explicit cleanup request). Report accepted/deferred status accurately; scheduling != completion."
        : "",
      "Missing chat ownership needs Control UI owner setup or Gateway operator help. Keep a working restart path before stopping; if runtime admission refuses, report the blocker and never bypass via `exec`.",
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
