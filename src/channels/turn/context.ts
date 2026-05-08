import { finalizeInboundContext } from "../../auto-reply/reply/inbound-context.js";
import type { FinalizedMsgContext } from "../../auto-reply/templating.js";
import type { ContextVisibilityMode } from "../../config/types.base.js";
import { shouldIncludeSupplementalContext } from "../../security/context-visibility.js";
import type {
  AccessFacts,
  ConversationFacts,
  InboundMediaFacts,
  MessageFacts,
  ReplyPlanFacts,
  RouteFacts,
  SenderFacts,
  SupplementalContextFacts,
} from "./types.js";

export type BuildChannelTurnContextParams = {
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
  media?: InboundMediaFacts[];
  supplemental?: SupplementalContextFacts;
  contextVisibility?: ContextVisibilityMode;
  extra?: Record<string, unknown>;
};

function compactMediaFacts(media: InboundMediaFacts[]): {
  paths?: string[];
  urls?: string[];
  types?: string[];
  transcribedIndexes?: number[];
} {
  const paths: string[] = [];
  const urls: string[] = [];
  const types: string[] = [];
  const transcribedIndexes: number[] = [];
  for (let index = 0; index < media.length; index += 1) {
    const item = media[index];
    if (!item) {
      continue;
    }
    if (item.path) {
      paths.push(item.path);
    }
    const url = item.url ?? item.path;
    if (url) {
      urls.push(url);
    }
    const type = item.contentType ?? item.kind;
    if (type) {
      types.push(type);
    }
    if (item.transcribed) {
      transcribedIndexes.push(index);
    }
  }
  return {
    paths: paths.length > 0 ? paths : undefined,
    urls: urls.length > 0 ? urls : undefined,
    types: types.length > 0 ? types : undefined,
    transcribedIndexes: transcribedIndexes.length > 0 ? transcribedIndexes : undefined,
  };
}

function commandAuthorized(access: AccessFacts | undefined): boolean | undefined {
  const commands = access?.commands;
  if (!commands) {
    return undefined;
  }
  return commands.authorizers.some((entry) => entry.allowed);
}

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

export function filterChannelTurnSupplementalContext(params: {
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

export function buildChannelTurnContext(
  params: BuildChannelTurnContextParams,
): FinalizedMsgContext {
  const media = params.media ?? [];
  const supplemental = filterChannelTurnSupplementalContext({
    supplemental: params.supplemental,
    contextVisibility: params.contextVisibility,
  });
  const body = params.message.body ?? params.message.rawBody;
  const mediaFacts = compactMediaFacts(media);

  return finalizeInboundContext({
    Body: body,
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
    ReplyToId: params.reply.replyToId ?? supplemental?.quote?.id,
    ReplyToIdFull: params.reply.replyToIdFull ?? supplemental?.quote?.fullId,
    ReplyToBody: supplemental?.quote?.body,
    ReplyToSender: supplemental?.quote?.sender,
    ReplyToIsQuote: supplemental?.quote?.isQuote,
    ForwardedFrom: supplemental?.forwarded?.from,
    ForwardedFromType: supplemental?.forwarded?.fromType,
    ForwardedFromId: supplemental?.forwarded?.fromId,
    ForwardedDate: supplemental?.forwarded?.date,
    ThreadStarterBody: supplemental?.thread?.starterBody,
    ThreadHistoryBody: supplemental?.thread?.historyBody,
    ThreadLabel: supplemental?.thread?.label,
    MediaPath: media[0]?.path,
    MediaUrl: media[0]?.url ?? media[0]?.path,
    MediaType: media[0]?.contentType ?? media[0]?.kind,
    MediaPaths: mediaFacts.paths,
    MediaUrls: mediaFacts.urls,
    MediaTypes: mediaFacts.types,
    MediaTranscribedIndexes: mediaFacts.transcribedIndexes,
    ChatType: params.conversation.kind,
    ConversationLabel: params.conversation.label,
    GroupSubject: params.conversation.kind !== "direct" ? params.conversation.label : undefined,
    GroupSpace: params.conversation.spaceId,
    GroupSystemPrompt: supplemental?.groupSystemPrompt,
    UntrustedStructuredContext: Array.isArray(supplemental?.untrustedContext)
      ? supplemental.untrustedContext.map((payload, index) => ({
          label: `context ${index + 1}`,
          payload,
        }))
      : undefined,
    SenderName: params.sender.name ?? params.sender.displayLabel,
    SenderId: params.sender.id,
    SenderUsername: params.sender.username,
    SenderTag: params.sender.tag,
    MemberRoleIds: params.sender.roles,
    Timestamp: params.timestamp,
    Provider: params.provider ?? params.channel,
    Surface: params.surface ?? params.provider ?? params.channel,
    WasMentioned: params.access?.mentions?.wasMentioned,
    CommandAuthorized: commandAuthorized(params.access),
    MessageThreadId: params.reply.messageThreadId ?? params.conversation.threadId,
    NativeChannelId: params.reply.nativeChannelId ?? params.conversation.nativeChannelId,
    OriginatingChannel: params.channel,
    OriginatingTo: params.reply.originatingTo,
    ThreadParentId: params.reply.threadParentId ?? params.conversation.parentId,
    ...params.extra,
  });
}
