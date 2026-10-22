import { vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import { createReplyOperation } from "../../sessions/session-controller.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../../state/openclaw-agent-db.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import type { runPreparedReply } from "./get-reply-run.js";
import { finalizeInboundContextForSdk } from "./inbound-context.js";
import { prepareReplyConversation } from "./prompt-session-context.js";

const activePreparedFixtures: ReturnType<typeof createReplyOperation>[] = [];

export function activatePreparedRun(sessionKey = "session-key") {
  const operation = createReplyOperation({
    sessionKey,
    sessionId: "active-session",
    resetTriggered: false,
  });
  operation.setPhase("running");
  activePreparedFixtures.push(operation);
  return operation;
}

export async function cleanupPreparedReplyFixtures() {
  for (const operation of activePreparedFixtures.splice(0)) {
    operation.complete();
    await operation.ownerSettlement;
  }
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
}

export function createInboundBody<T extends string>(body: T) {
  return { Body: body, RawBody: body, CommandBody: body };
}

export function createSessionBody<T extends string>(body: T) {
  return { Body: body, BodyStripped: body };
}

export function createProviderSurface<T extends string>(provider: T) {
  return { Provider: provider, Surface: provider };
}

export function createPreparedReplyTurn(
  body: string,
  common: Parameters<typeof runPreparedReply>[0]["ctx"],
  session: Partial<Parameters<typeof runPreparedReply>[0]["sessionCtx"]> = {},
  inbound: Partial<Parameters<typeof runPreparedReply>[0]["ctx"]> = {},
) {
  return {
    ctx: { ...createInboundBody(body), ...common, ...inbound },
    sessionCtx: { ...createSessionBody(body), ...common, ...session },
  };
}

export function createTelegramGroupSession(): SessionEntry {
  return {
    sessionId: "session-telegram-group",
    updatedAt: 1,
    systemSent: true,
    chatType: "group",
    delivery: normalizeSessionDeliveryState({
      context: { channel: "telegram", to: "-100123" },
      origin: { provider: "telegram", surface: "telegram", chatType: "group", to: "-100123" },
    }),
  };
}

export function createInboundTurn<
  TBody extends string,
  TProvider extends string,
  TChatType extends string,
>(body: TBody, provider: TProvider, chatType: TChatType) {
  return { ...createInboundBody(body), ...createProviderSurface(provider), ChatType: chatType };
}

export function createSessionTurn<
  TBody extends string,
  TProvider extends string,
  TChatType extends string,
>(body: TBody, provider: TProvider, chatType: TChatType) {
  return { ...createSessionBody(body), ...createProviderSurface(provider), ChatType: chatType };
}

export function baseParams(
  overrides: Partial<Parameters<typeof runPreparedReply>[0]> = {},
): Parameters<typeof runPreparedReply>[0] {
  const route = {
    ThreadHistoryBody: "Earlier message in this thread",
    OriginatingChannel: "slack",
    OriginatingTo: "C123",
    ChatType: "group",
  };
  const defaults = {
    ctx: { ...createInboundBody(""), ...route },
    sessionCtx: {
      ...createSessionBody(""),
      ...route,
      media: [{ path: "/tmp/input.png" }],
      Provider: "slack",
    },
    cfg: { session: {}, channels: {}, agents: { defaults: {} } },
    agentId: "default",
    agentDir: "/tmp/agent",
    agentCfg: {},
    sessionCfg: {},
    commandAuthorized: true,
    command: {
      surface: "slack",
      channel: "slack",
      isAuthorizedSender: true,
      abortKey: "session-key",
      ownerList: [],
      senderIsOwner: false,
      rawBodyNormalized: "",
      commandBodyNormalized: "",
    } as never,
    commandSource: "",
    allowTextCommands: true,
    directives: { hasThinkDirective: false, thinkLevel: undefined } as never,
    defaultActivation: "always",
    resolvedThinkLevel: "high",
    resolvedVerboseLevel: "off",
    resolvedReasoningLevel: "off",
    resolvedElevatedLevel: "off",
    elevatedEnabled: false,
    elevatedAllowed: false,
    blockStreamingEnabled: false,
    resolvedBlockStreamingBreak: "message_end",
    modelState: {
      resolveDefaultThinkingLevel: async () => "medium",
      resolveThinkingCatalog: async () => [],
    } as never,
    provider: "anthropic",
    model: "claude-opus-4-1",
    typing: {
      onReplyStart: vi.fn().mockResolvedValue(undefined),
      cleanup: vi.fn(),
    } as never,
    defaultModel: "claude-opus-4-1",
    timeoutMs: 30_000,
    isNewSession: true,
    resetTriggered: false,
    systemSent: true,
    sessionKey: "session-key",
    workspaceDir: "/tmp/workspace",
    abortedLastRun: false,
  };
  const ctx = overrides.ctx ?? defaults.ctx;
  const sessionCtx = overrides.sessionCtx ?? defaults.sessionCtx;
  const resolveTestCanonicalText = (value: Record<string, unknown>) => {
    const { commandText, agentText, rawText } = finalizeInboundContextForSdk({ ...value });
    return { commandText, agentText, rawText };
  };
  const sessionText = resolveTestCanonicalText(sessionCtx);
  return {
    ...defaults,
    ...overrides,
    conversation:
      overrides.conversation ??
      prepareReplyConversation({
        ctx: sessionCtx,
        sessionEntry:
          overrides.sessionStore?.[overrides.sessionKey ?? defaults.sessionKey] ??
          overrides.sessionEntry,
      }),
    ctx: { ...ctx, ...resolveTestCanonicalText(ctx) },
    sessionCtx: {
      ...sessionCtx,
      ...sessionText,
      agentText:
        typeof sessionCtx.BodyStripped === "string"
          ? sessionCtx.BodyStripped
          : sessionText.agentText,
    },
  } as Parameters<typeof runPreparedReply>[0];
}

export function ownerParams(): Parameters<typeof runPreparedReply>[0] {
  const params = baseParams();
  params.command.senderIsOwner = true;
  return params;
}
