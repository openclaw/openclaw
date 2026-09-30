import { vi } from "vitest";
import type { SkillCommandSpec } from "../../skills/types.js";
import type { TemplateContext } from "../templating.js";
import { clearInlineDirectives } from "./get-reply-directives-utils.js";
import { handleInlineActions } from "./get-reply-inline-actions.js";
import { buildTestCtx } from "./test-ctx.js";
import type { TypingController } from "./typing.js";

export const createOpenClawToolsMock = vi.fn();

export type HandleInlineActionsInput = Parameters<
  typeof import("./get-reply-inline-actions.js").handleInlineActions
>[0];

const skillToolDispatchDependencies: NonNullable<
  HandleInlineActionsInput["skillToolDispatchDependencies"]
> = {
  createOpenClawTools: createOpenClawToolsMock,
};

export const createTypingController = (): TypingController => ({
  onReplyStart: async () => {},
  startTypingLoop: async () => {},
  startTypingOnText: async () => {},
  refreshTypingTtl: () => {},
  isActive: () => false,
  markRunComplete: () => {},
  markDispatchIdle: () => {},
  cleanup: vi.fn(),
});

export const createHandleInlineActionsInput = (params: {
  ctx: ReturnType<typeof buildTestCtx>;
  typing: TypingController;
  cleanedBody: string;
  command?: Partial<HandleInlineActionsInput["command"]>;
  overrides?: Partial<Omit<HandleInlineActionsInput, "ctx" | "sessionCtx" | "typing" | "command">>;
}): HandleInlineActionsInput => {
  const baseCommand: HandleInlineActionsInput["command"] = {
    surface: "whatsapp",
    channel: "whatsapp",
    channelId: "whatsapp",
    ownerList: [],
    senderIsOwner: false,
    isAuthorizedSender: false,
    senderId: undefined,
    abortKey: "whatsapp:+999",
    rawBodyNormalized: params.cleanedBody,
    commandBodyNormalized: params.cleanedBody,
    from: "whatsapp:+999",
    to: "whatsapp:+999",
  };
  return {
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
      ...baseCommand,
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
    skillToolDispatchDependencies,
    ...params.overrides,
  };
};

export function runTestInlineActions(params: Parameters<typeof createHandleInlineActionsInput>[0]) {
  return handleInlineActions(createHandleInlineActionsInput(params));
}

export function mockCallArgs(
  mock: ReturnType<typeof vi.fn>,
  label: string,
  callIndex = 0,
): unknown[] {
  const call = mock.mock.calls[callIndex] as unknown[] | undefined;
  if (!call) {
    throw new Error(`expected ${label} mock call ${callIndex}`);
  }
  return call;
}

export function createInlineToolDispatchFixture<T>(params: {
  body: string;
  toolName: string;
  execute: () => Promise<T>;
  skill: Pick<SkillCommandSpec, "name" | "skillName" | "description" | "skillSource">;
  sourceFilePath: string;
  nativeChannelId?: string;
}) {
  const typing = createTypingController();
  const toolExecute = vi.fn(params.execute);
  createOpenClawToolsMock.mockReturnValue([{ name: params.toolName, execute: toolExecute }]);
  const ctx = buildTestCtx({
    Body: params.body,
    CommandBody: params.body,
    ...(params.nativeChannelId === undefined ? {} : { NativeChannelId: params.nativeChannelId }),
  });
  const skillCommands: SkillCommandSpec[] = [
    {
      ...params.skill,
      dispatch: {
        kind: "tool",
        toolName: params.toolName,
        argMode: "raw",
      },
      sourceFilePath: params.sourceFilePath,
    },
  ];
  return { typing, toolExecute, ctx, skillCommands };
}
