import type { TemplateContext } from "../templating.js";
import { clearInlineDirectives } from "./get-reply-directives-utils.js";
import type { handleInlineActions } from "./get-reply-inline-actions.js";
import type { buildTestCtx } from "./test-ctx.js";

export type HandleInlineActionsInput = Parameters<typeof handleInlineActions>[0];

export const createHandleInlineActionsInput = (params: {
  ctx: ReturnType<typeof buildTestCtx>;
  typing: HandleInlineActionsInput["typing"];
  cleanedBody: string;
  command?: Partial<HandleInlineActionsInput["command"]>;
  overrides?: Partial<Omit<HandleInlineActionsInput, "ctx" | "sessionCtx" | "typing" | "command">>;
}): HandleInlineActionsInput => ({
  ctx: params.ctx,
  sessionCtx: params.ctx as unknown as TemplateContext,
  cfg: {},
  agentId: "main",
  sessionKey: "s:main",
  workspaceDir: "/tmp",
  isGroup: false,
  typing: params.typing,
  allowTextCommands: false,
  inlineStatusRequested: false,
  command: {
    surface: "whatsapp",
    channel: "whatsapp",
    channelId: "whatsapp",
    ownerList: [],
    senderIsOwner: false,
    isAuthorizedSender: false,
    abortKey: "whatsapp:+999",
    rawBodyNormalized: params.cleanedBody,
    commandBodyNormalized: params.cleanedBody,
    from: "whatsapp:+999",
    to: "whatsapp:+999",
    ...params.command,
  },
  directives: clearInlineDirectives(params.cleanedBody),
  cleanedBody: params.cleanedBody,
  elevatedEnabled: false,
  elevatedAllowed: false,
  elevatedFailures: [],
  defaultActivation: () => "always",
  resolveModelLevels: async () => ({
    resolvedThinkLevel: undefined,
    resolvedReasoningLevel: "off",
  }),
  resolvedVerboseLevel: undefined,
  resolvedElevatedLevel: "off",
  resolveDefaultThinkingLevel: async () => "off",
  provider: "openai",
  model: "gpt-4o-mini",
  contextTokens: 0,
  abortedLastRun: false,
  sessionScope: "per-sender",
  ...params.overrides,
});
