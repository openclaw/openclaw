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
        ? hasGateway
          ? "For the Gateway hosting this session, config writes, channels, plugins, agents, models/providers: ask `openclaw`."
          : "For the Gateway hosting this session, restart, config, channels, plugins, agents, models/providers: ask `openclaw`."
        : hasGateway
          ? `Config read: \`gateway\` (\`config.get|config.schema.lookup\`) only when those actions are exposed by its schema. Config writes need the \`openclaw\` tool.`
          : "",
    ...(!hasOpenClaw || setupIssue
      ? [
          "`/openclaw` rescue accepts supported commands, not a free-form substitute for the missing setup tool. Do not tell the user to enable tools by sending arbitrary setup instructions to it.",
        ]
      : []),
    [
      "For the Gateway hosting this session:",
      ...(restartCommandsEnabled
        ? [
            "In a connected chat, the owner can send `/update` with commands.restart enabled (the default), regardless of the agent's tool profile.",
          ]
        : []),
      hasGateway
        ? "On an explicit owner request or operator-scheduled maintenance, perform the work with `gateway`: update.run updates with supervised restart and completion notices; restart schedules a safe restart; update.cleanup retires eligible recovery copies while the Gateway keeps running (dryRun previews). Cleanup permanently removes eligible rollback copies, so require a cleanup request, not merely an update request. Do not redirect the owner to slash commands or a terminal when these actions are available. Report accepted or deferred work accurately; scheduling is not completion."
        : restartCommandsEnabled
          ? "For a chat update request, direct the user to `/update`. Outside chat, use the Control UI or ask the operator to run `openclaw update` in a terminal."
          : "For an update request, use the Control UI or ask the operator to run `openclaw update` in a terminal.",
      "Missing chat ownership needs owner setup in the Control UI or help from the Gateway operator.",
      "Use runtime-supervised maintenance: the Gateway must retain a working restart path before it stops. For this Gateway, use maintenance tools, not exec or detached jobs, for installation changes or service control. If runtime admission refuses, report the concrete blocker; do not bypass owner/operator authorization.",
    ].join(" "),
    hasExec
      ? "For user-requested setup or repair on another host, verify it is not this Gateway, then use available exec/SSH tools; normal exec approvals still apply. The local `openclaw` helper does not target remote Gateways. For updates there, use `openclaw update --yes`."
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
