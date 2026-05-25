import {
  commandTurnKindToSource,
  createCommandTurnContext,
  type CommandTurnContext,
} from "../../auto-reply/command-turn-context.js";
import {
  finalizeInboundContext as finalizeCoreInboundContext,
  type FinalizeInboundContextOptions,
} from "../../auto-reply/reply/inbound-context.js";
import {
  normalizeInboundTextNewlines,
  sanitizeInboundSystemTags,
} from "../../auto-reply/reply/inbound-text.js";
import type { FinalizedMsgContext } from "../../auto-reply/templating.js";
import type { ContextVisibilityMode } from "../../config/types.base.js";
import { shouldIncludeSupplementalContext } from "../../security/context-visibility.js";
import type {
  AccessFacts,
  CommandFacts,
  ConversationFacts,
  InboundMediaFacts,
  MessageFacts,
  ReplyPlanFacts,
  RouteFacts,
  SenderFacts,
  SupplementalContextFacts,
} from "../turn/types.js";
import type { InboundEventKind } from "./kind.js";
import { buildChannelInboundMediaPayload } from "./media.js";

export type BuildChannelInboundEventContextParams = {
  channel: string;
  accountId?: string;
  provider?: string;
  surface?: string;
  messageId?: string;
  messageIdFull?: string;
  timestamp?: number;
  from: string;
  sender: SenderFacts;
  conversation: ConversationFacts;
  route: RouteFacts;
  reply: ReplyPlanFacts;
  message: MessageFacts;
  access?: AccessFacts;
  command?: CommandFacts;
  commandTurn?: CommandTurnContext;
  media?: InboundMediaFacts[];
  supplemental?: SupplementalContextFacts;
  contextVisibility?: ContextVisibilityMode;
  extra?: Record<string, unknown>;
};

type UntrustedStructuredContextEntries = NonNullable<
  FinalizedMsgContext["UntrustedStructuredContext"]
>;

export type BuiltChannelInboundEventContext = FinalizedMsgContext & {
  Body: string;
  BodyForAgent: string;
  BodyForCommands: string;
  ChatType: ConversationFacts["kind"];
  CommandAuthorized: boolean;
  CommandBody: string;
  From: string;
  RawBody: string;
  SessionKey: string;
  To: string;
  InboundEventKind: InboundEventKind;
};

type FinalizeInboundContextFn = <T extends Record<string, unknown>>(
  ctx: T,
  opts?: FinalizeInboundContextOptions,
) => unknown;

export type FinalizeChannelInboundContextParams<T extends Record<string, unknown>> = {
  context: T;
  supplemental?: SupplementalContextFacts;
  contextVisibility?: ContextVisibilityMode;
  media?: readonly InboundMediaFacts[];
  finalize?: FinalizeInboundContextFn;
  finalizeOptions?: FinalizeInboundContextOptions;
};

export type FinalizeChannelInboundContextResult<T extends Record<string, unknown>> = {
  context: T & FinalizedMsgContext;
  supplemental?: SupplementalContextFacts;
  quoteHidden: boolean;
  forwardedHidden: boolean;
  threadHidden: boolean;
};

function keepSupplementalContext(params: {
  mode?: ContextVisibilityMode;
  kind: "quote" | "forwarded" | "thread";
  senderAllowed?: boolean;
}): boolean {
  if (!params.mode || params.mode === "all") {
    return true;
  }
  if (params.senderAllowed === undefined) {
    return false;
  }
  return shouldIncludeSupplementalContext({
    mode: params.mode,
    kind: params.kind,
    senderAllowed: params.senderAllowed,
  });
}

export function filterChannelInboundSupplementalContext(params: {
  supplemental?: SupplementalContextFacts;
  contextVisibility?: ContextVisibilityMode;
}): SupplementalContextFacts | undefined {
  const supplemental = params.supplemental;
  if (!supplemental) {
    return undefined;
  }
  const quote = keepSupplementalContext({
    mode: params.contextVisibility,
    kind: "quote",
    senderAllowed: supplemental.quote?.senderAllowed,
  })
    ? supplemental.quote
    : undefined;
  const forwarded = keepSupplementalContext({
    mode: params.contextVisibility,
    kind: "forwarded",
    senderAllowed: supplemental.forwarded?.senderAllowed,
  })
    ? supplemental.forwarded
    : undefined;
  const thread = keepSupplementalContext({
    mode: params.contextVisibility,
    kind: "thread",
    senderAllowed: supplemental.thread?.senderAllowed,
  })
    ? supplemental.thread
    : undefined;

  return {
    ...supplemental,
    quote,
    forwarded,
    thread,
  };
}

export function filterChannelInboundQuoteContext(
  contextVisibility: ContextVisibilityMode | undefined,
  quote: SupplementalContextFacts["quote"] | undefined,
): SupplementalContextFacts["quote"] | undefined {
  return filterChannelInboundSupplementalContext({
    contextVisibility,
    supplemental: quote ? { quote } : undefined,
  })?.quote;
}

export function finalizeChannelInboundContext<T extends Record<string, unknown>>(
  params: FinalizeChannelInboundContextParams<T>,
): FinalizeChannelInboundContextResult<T> {
  const contextSupplemental = (params.context as { SupplementalContext?: SupplementalContextFacts })
    .SupplementalContext;
  const rawSupplemental = params.supplemental ?? contextSupplemental;
  const supplemental = filterChannelInboundSupplementalContext({
    supplemental: rawSupplemental,
    contextVisibility: params.contextVisibility,
  });
  const mediaPayload = params.media ? buildChannelInboundMediaPayload([...params.media]) : {};
  const baseContext = {
    ...params.context,
    SupplementalContext: supplemental,
    ...mediaPayload,
  };
  const untrustedStructuredContext = resolveUntrustedStructuredContext({
    supplemental,
    extra: baseContext,
  });
  const finalize = params.finalize ?? finalizeCoreInboundContext;
  const context = finalize(
    {
      ...baseContext,
      UntrustedStructuredContext: untrustedStructuredContext,
    },
    params.finalizeOptions,
  ) as T & FinalizedMsgContext;
  return {
    context,
    supplemental,
    quoteHidden: Boolean(rawSupplemental?.quote && !supplemental?.quote),
    forwardedHidden: Boolean(rawSupplemental?.forwarded && !supplemental?.forwarded),
    threadHidden: Boolean(rawSupplemental?.thread && !supplemental?.thread),
  };
}

function resolveAccessFactsCommandAuthorized(access: AccessFacts | undefined): boolean | undefined {
  const commands = access?.commands;
  return typeof commands?.authorized === "boolean"
    ? commands.authorized
    : commands?.authorizers?.some((entry) => entry.allowed);
}

function normalizeUntrustedGroupPrompt(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = sanitizeInboundSystemTags(normalizeInboundTextNewlines(value));
  return normalized.trim().length > 0 ? normalized : undefined;
}

function resolveUntrustedStructuredContext(params: {
  supplemental?: SupplementalContextFacts;
  extra?: Record<string, unknown>;
}): UntrustedStructuredContextEntries | undefined {
  const entries: UntrustedStructuredContextEntries = [];
  const extraEntries = params.extra?.UntrustedStructuredContext;
  if (Array.isArray(extraEntries)) {
    entries.push(...(extraEntries as UntrustedStructuredContextEntries));
  }
  entries.push(...(params.supplemental?.untrustedContext ?? []));

  // User-controlled group prompt metadata must stay out of GroupSystemPrompt.
  // Keeping it with untrusted context prevents spoofed system markers from gaining prompt authority.
  const groupPrompt = normalizeUntrustedGroupPrompt(
    params.supplemental?.untrustedGroupSystemPrompt,
  );
  if (groupPrompt) {
    entries.push({
      label: "Group prompt context",
      type: "group_prompt_context",
      payload: { text: groupPrompt },
    });
  }

  return entries.length > 0 ? entries : undefined;
}

function resolveChannelCommandContext(params: {
  command?: CommandFacts;
  commandTurn?: CommandTurnContext;
  message: MessageFacts;
  access?: AccessFacts;
}): CommandTurnContext | undefined {
  if (params.commandTurn) {
    return params.commandTurn;
  }
  const command = params.command;
  if (!command) {
    return undefined;
  }
  const body = command.body ?? params.message.commandBody ?? params.message.rawBody;
  return createCommandTurnContext(commandTurnKindToSource(command.kind), {
    authorized:
      command.kind === "normal"
        ? false
        : (command.authorized ?? resolveAccessFactsCommandAuthorized(params.access) === true),
    commandName: command.name,
    body,
  });
}

export function buildChannelInboundEventContext(
  params: BuildChannelInboundEventContextParams,
): BuiltChannelInboundEventContext {
  const body = params.message.body ?? params.message.rawBody;
  const commandTurn = resolveChannelCommandContext({
    command: params.command,
    commandTurn: params.commandTurn,
    message: params.message,
    access: params.access,
  });

  const result = finalizeChannelInboundContext({
    supplemental: params.supplemental,
    contextVisibility: params.contextVisibility,
    media: params.media,
    context: {
      Body: body,
      InboundEventKind: params.message.inboundEventKind ?? "user_request",
      BodyForAgent: params.message.bodyForAgent ?? params.message.rawBody,
      InboundHistory: params.message.inboundHistory,
      RawBody: params.message.rawBody,
      CommandBody: params.message.commandBody ?? params.message.rawBody,
      BodyForCommands: params.message.commandBody ?? params.message.rawBody,
      From: params.from,
      To: params.reply.to,
      SessionKey: params.route.dispatchSessionKey ?? params.route.routeSessionKey,
      AccountId: params.route.accountId ?? params.accountId,
      ParentSessionKey: params.route.parentSessionKey,
      ModelParentSessionKey: params.route.modelParentSessionKey,
      MessageSid: params.messageId,
      MessageSidFull: params.messageIdFull,
      ReplyToId: params.reply.replyToId,
      ReplyToIdFull: params.reply.replyToIdFull,
      ChatType: params.conversation.kind,
      ConversationLabel: params.conversation.label,
      GroupSubject: params.conversation.kind !== "direct" ? params.conversation.label : undefined,
      GroupSpace: params.conversation.spaceId,
      SenderName: params.sender.name ?? params.sender.displayLabel,
      SenderId: params.sender.id,
      SenderUsername: params.sender.username,
      SenderTag: params.sender.tag,
      MemberRoleIds: params.sender.roles,
      Timestamp: params.timestamp,
      Provider: params.provider ?? params.channel,
      Surface: params.surface ?? params.provider ?? params.channel,
      WasMentioned: params.access?.mentions?.wasMentioned,
      CommandAuthorized: resolveAccessFactsCommandAuthorized(params.access) === true,
      CommandTurn: commandTurn,
      MessageThreadId: params.reply.messageThreadId ?? params.conversation.threadId,
      NativeChannelId: params.reply.nativeChannelId ?? params.conversation.nativeChannelId,
      OriginatingChannel: params.channel,
      OriginatingTo: params.reply.originatingTo,
      ThreadParentId: params.reply.threadParentId ?? params.conversation.parentId,
      ...params.extra,
    },
  });
  return result.context as BuiltChannelInboundEventContext;
}
