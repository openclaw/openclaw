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
        ? "For the Gateway hosting this session, config writes, channels, plugins, agents, models/providers: ask `openclaw`."
        : hasGateway
          ? `Config read: \`gateway\` (\`config.get|config.schema.lookup\`) only when those actions are exposed by its schema. Config writes need the \`openclaw\` tool.`
          : "",
    hasOpenClaw && !setupIssue
      ? "For an exact config change, send `openclaw` a `message` such as `config set <path> <value>`, `config unset <path>`, `config get <path>`, `config schema <path>`, or `config validate`. These commands do not need helper inference; existing approval and config-write checks still apply."
      : "",
    "Config recovery: if broken config or an operationally unavailable setup tool blocks an explicitly requested local repair, use available file/exec tools within their existing permissions. Prefer validated `openclaw config` commands; if they cannot load the config, inspect the actual file, preserve a rollback copy, make the narrow repair, then validate and read back. Recovery must not override an approval decision, readonly config, containment, or disabled tools. Do not use this fallback to change access, approval, or ownership policies; those changes still require the authorized control path.",
    ...(!hasOpenClaw || setupIssue
      ? [
          "`/openclaw` rescue accepts supported commands, not a free-form substitute for the missing setup tool. Do not tell the user to enable tools by sending arbitrary setup instructions to it.",
        ]
      : []),
    [
      "For the Gateway hosting this session:",
      "Use the built-in updater by default. For a source installation, use Git only if the operator explicitly requests an exact revision and the host authorizes maintenance for this caller. Shell access alone is not update authority.",
      ...(restartCommandsEnabled
        ? [
            "In a connected chat, the owner can send `/update` with commands.restart enabled (the default), regardless of the agent's tool profile.",
          ]
        : []),
      hasGateway
        ? "On an explicit owner request or operator-scheduled maintenance, `gateway`: update.run updates with supervised restart and completion notices; restart schedules a safe restart; update.cleanup retires eligible recovery copies while the Gateway keeps running (dryRun previews). Cleanup permanently removes eligible rollback copies, so require a cleanup request, not merely an update request. Report accepted or deferred work accurately; scheduling is not completion."
        : "",
      "Missing chat ownership needs owner setup in the Control UI or help from the Gateway operator.",
      "The Gateway must retain a working restart path before it stops. If runtime admission refuses, report the concrete blocker; do not bypass owner/operator authorization or retry the denied operation through exec.",
    ].join(" "),
    hasExec
      ? "For user-requested setup or repair on another host, verify it is not this Gateway, then use available exec/SSH tools; normal exec approvals still apply. The local `openclaw` helper does not target remote Gateways. Do not block that separately authorized remote task on local agent-ID migration."
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
    "For task-authorized commands, make the execution request through the available tool and let its current policy decide whether approval is needed. Request exec approval only from an actual approval-pending result; never invent approval IDs or ask for a bare /approve.";
  if (usesNativeApprovalUi) {
    return `${policyGuidance} exec approval-pending: native card/buttons first. Plain /approve only when tool requires chat/manual approval; copy exact "Reply with:" command.`;
  }
  return `${policyGuidance} exec approval-pending: send exact /approve from "Reply with:"; never ask for another code.`;
}
