import path from "node:path";
import { buildCommandContext } from "../../../src/auto-reply/reply/commands-context.js";
import { parseInlineSessionDirectives } from "../../../src/auto-reply/reply/directive-handling.parse.js";
import { prepareReplyRunContext } from "../../../src/auto-reply/reply/get-reply-run-context.js";
import { finalizeInboundContextForSdk } from "../../../src/auto-reply/reply/inbound-context.js";
import { prepareReplyConversation } from "../../../src/auto-reply/reply/prompt-session-context.js";
import { createTypingController } from "../../../src/auto-reply/reply/typing.js";
import type { TemplateContext } from "../../../src/auto-reply/templating.js";
import type { OpenClawConfig } from "../../../src/config/types.openclaw.js";

// Snapshot generation also runs outside Vitest, so use real preparation factories.
export async function preparePromptSnapshotReply(params: {
  ctx: TemplateContext;
  body: string;
  workspaceDir: string;
}) {
  const cfg: OpenClawConfig = { agents: { entries: { main: {} } } };
  // Preserve scenario metadata while supplying the canonical text preparation consumes.
  const { commandText, rawText } = finalizeInboundContextForSdk({ ...params.ctx });
  const sessionCtx = { ...params.ctx, commandText, rawText, agentText: params.body };
  const provider = "anthropic";
  const model = "claude-sonnet-4-6";
  const prepared = await prepareReplyRunContext({
    ctx: sessionCtx,
    sessionCtx,
    conversation: prepareReplyConversation({ ctx: sessionCtx }),
    cfg,
    agentId: "main",
    agentDir: path.join(params.workspaceDir, "../agent"),
    agentCfg: {},
    sessionCfg: {},
    commandAuthorized: true,
    command: buildCommandContext(
      {
        ctx: sessionCtx,
        cfg,
        agentId: "main",
        isGroup: sessionCtx.ChatType === "group" || sessionCtx.ChatType === "channel",
        triggerBodyNormalized: sessionCtx.commandText,
      },
      { ownerList: [], senderIsOwner: false, isAuthorizedSender: true },
    ),
    allowTextCommands: true,
    directives: parseInlineSessionDirectives(""),
    defaultActivation: "mention",
    resolvedThinkLevel: undefined,
    resolvedVerboseLevel: "off",
    resolvedReasoningLevel: "off",
    resolvedElevatedLevel: "off",
    elevatedEnabled: false,
    elevatedAllowed: false,
    blockStreamingEnabled: false,
    resolvedBlockStreamingBreak: "message_end",
    get modelState(): never {
      throw new Error("Prompt snapshot preparation does not execute model selection");
    },
    provider,
    model,
    typing: createTypingController({}),
    defaultModel: model,
    timeoutMs: 30_000,
    isNewSession: false,
    resetTriggered: false,
    systemSent: true,
    workspaceDir: params.workspaceDir,
    abortedLastRun: false,
  });
  if (prepared.kind !== "ready") {
    throw new Error("Expected prepared snapshot reply context");
  }
  return prepared;
}
