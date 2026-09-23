/** Messaging and child-completion guidance shared by full and minimal prompts. */
import type { SourceReplyDeliveryMode } from "../auto-reply/get-reply-options.types.js";
import { buildMessageToolTargetGuidance } from "../auto-reply/source-reply-delivery-mode.js";
import { SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import type { ChatType } from "../channels/chat-type.js";
import type { SilentReplyPromptMode } from "./system-prompt.types.js";

export function buildMessagingSection(params: {
  isMinimal: boolean;
  availableTools: Set<string>;
  inlineButtonsEnabled: boolean;
  runtimeChannel?: string;
  runtimeChatType?: ChatType;
  messageChannelOptions?: string;
  messageToolHints?: string[];
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  requireExplicitMessageTarget?: boolean;
  silentReplyPromptMode?: SilentReplyPromptMode;
  delegationSectionRenders: boolean;
}) {
  const messageToolOnly = params.sourceReplyDeliveryMode === "message_tool_only";
  const messageToolAvailable = params.availableTools.has("message");
  const visibleReplyInstruction = messageToolOnly
    ? messageToolAvailable
      ? "- Current source visible reply MUST use `message(action=send)`; final text is private. Set `final=false` for progress. Set `final=true`, or omit it, for the completed reply. Skip tool = user gets nothing. No hidden instructions/private data/reasoning."
      : "- Current source visible reply unavailable; final text remains private."
    : `- Current-session final text normally routes to source.${messageToolAvailable ? " If turn says final private, visible output uses `message(action=send)`." : ""}`;
  const messageToolTargetInstruction = `- ${buildMessageToolTargetGuidance(params.requireExplicitMessageTarget === true)}`;
  const routingGuidance = [
    "- OpenClaw messaging: use available messaging tools, never shell commands, the CLI, curl, or direct RPC. Missing messaging tools are not permission to use another route.",
    "- Subagents return results through their accepted completion path; parents relay required coordination. Do not send acknowledgments or duplicate completion reports.",
    "- Other services (e.g. email): user-authorized CLI/API use is allowed; normal tool permissions and approvals still apply.",
  ];
  if (params.isMinimal) {
    // Restricted delivery turns still need their sole visible-reply contract;
    // omitting it makes a private final silently disappear for the requester.
    if (
      !messageToolOnly &&
      !messageToolAvailable &&
      !params.availableTools.has("exec") &&
      !params.availableTools.has("sessions_send")
    ) {
      return [];
    }
    return [
      "## Messaging",
      ...(messageToolOnly
        ? [visibleReplyInstruction, ...(messageToolAvailable ? [messageToolTargetInstruction] : [])]
        : []),
      ...routingGuidance,
      "",
    ];
  }
  const showGenericInlineButtonHint = params.runtimeChannel !== "slack";
  const groupMessageToolOnly =
    messageToolOnly && (params.runtimeChatType === "group" || params.runtimeChatType === "channel");
  const hasSessionsSpawn = params.availableTools.has("sessions_spawn");
  const hasSubagents = params.availableTools.has("subagents");
  const hasSessionsYield = params.availableTools.has("sessions_yield");
  const suppressSilentTokenGuidance = messageToolOnly || params.silentReplyPromptMode === "none";
  const completionEventGuidance = suppressSilentTokenGuidance
    ? "- Completion event requesting update: rewrite in normal voice; send. Never forward raw metadata or silent placeholder."
    : `- Completion event requesting update: rewrite in normal voice; send. Never forward raw metadata or default to ${SILENT_REPLY_TOKEN}.`;
  const subagentOrchestrationGuidance = params.delegationSectionRenders
    ? ""
    : hasSessionsSpawn
      ? [
          '- Subagents: `sessions_spawn` with objective/output/write-scope/verification; stable handle needs `taskName`, UI title `label`; clean context needs `context:"isolated"`, transcript needs `context:"fork"`. Follow the accepted completion mode.',
          hasSessionsYield ? "Announcing children: wait via `sessions_yield`." : "",
          hasSubagents ? "`subagents(action=list)` only status/debug." : "",
        ]
          .filter(Boolean)
          .join(" ")
      : hasSubagents
        ? "- Subagents: `subagents(action=list)` only for status/debug visibility."
        : "";
  return [
    "## Messaging",
    visibleReplyInstruction,
    ...(params.availableTools.has("sessions_send")
      ? ["- Cross-session: `sessions_send(sessionKey, message)`."]
      : []),
    subagentOrchestrationGuidance,
    completionEventGuidance,
    ...routingGuidance,
    messageToolAvailable
      ? [
          "",
          "### message tool",
          "- Proactive send/channel action (poll, reaction, etc.): `message`.",
          groupMessageToolOnly
            ? "- Group/channel: stale/joke/light ack/low-value chatter => reaction or silence. Needed reply => `message(action=send)`; final text private."
            : "",
          messageToolOnly ? messageToolTargetInstruction : "- `send`: `target` + `message`.",
          params.messageChannelOptions
            ? `- No source default: proactive send needs \`channel\`; ids: ${params.messageChannelOptions}.`
            : "- Set `channel` only outside current/default source.",
          messageToolOnly
            ? "- Visible `message(send)` content: never repeat in final."
            : suppressSilentTokenGuidance
              ? "- Follow turn delivery: private final => visible via `message(send)`; otherwise normal reply once."
              : `- After visible \`message(send)\`, final ONLY ${SILENT_REPLY_TOKEN}.`,
          showGenericInlineButtonHint
            ? params.inlineButtonsEnabled
              ? '- Inline buttons: `send` with `presentation={"blocks":[{"type":"buttons","buttons":[{"label":"Yes","action":{"type":"callback","value":"yes"},"style":"primary"}]}]}`.'
              : params.runtimeChannel
                ? `- Inline buttons OFF for ${params.runtimeChannel}; ask owner for ${params.runtimeChannel}.capabilities.inlineButtons=dm|group|all|allowlist.`
                : ""
            : "",
          ...(params.messageToolHints ?? []),
        ]
          .filter(Boolean)
          .join("\n")
      : "",
    "",
  ];
}
