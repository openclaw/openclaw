import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

export type ChannelMessageActionReadPolicy =
  | { readonly kind: "none" }
  | {
      readonly kind: "conversation-read";
      readonly targetlessCache: "deny" | "bundled-current-context";
    };

type ChannelMessageActionFacts = {
  readonly readPolicy: ChannelMessageActionReadPolicy;
  readonly targetMode: "to" | "channelId" | "none";
  readonly fencedRead?: true;
  readonly readOnly?: true;
  readonly sendsContent?: true;
  readonly scheduledWrite?: "operator" | "provider";
  readonly crossContext?: "marker" | "guard";
};

const NO_CONVERSATION_READ = { readPolicy: { kind: "none" }, targetMode: "none" } as const;
const CONVERSATION_READ = {
  readPolicy: { kind: "conversation-read", targetlessCache: "deny" },
  targetMode: "to",
} as const;
// Retrieval, read authority, and delivery classification are independent facts.
// Conversation-read authority also covers existing-message mutations below.
const RETRIEVAL = {
  ...CONVERSATION_READ,
  targetMode: "none",
  fencedRead: true,
  readOnly: true,
} as const;
const TARGETED_RETRIEVAL = { ...RETRIEVAL, targetMode: "to" } as const;
const CONTENT_SEND = {
  ...NO_CONVERSATION_READ,
  targetMode: "to",
  sendsContent: true,
  crossContext: "marker",
} as const;
const MARKED_CONTENT = {
  ...NO_CONVERSATION_READ,
  targetMode: "to",
  crossContext: "marker",
} as const;
const GUARDED_ACTION = {
  ...NO_CONVERSATION_READ,
  targetMode: "to",
  crossContext: "guard",
} as const;
const TARGETED_ACTION = { ...NO_CONVERSATION_READ, targetMode: "to" } as const;
const CHANNEL_TARGETED_ACTION = { ...NO_CONVERSATION_READ, targetMode: "channelId" } as const;
const PROVIDER_WRITE = {
  ...CONVERSATION_READ,
  scheduledWrite: "provider",
  crossContext: "guard",
} as const;

/**
 * Deliberately closed, core-owned vocabulary so every transport can render every action.
 * Plugins add names through a core PR; runtime registration is intentionally unsupported.
 */
const CHANNEL_MESSAGE_ACTION_DEFINITIONS = [
  { name: "send", ...CONTENT_SEND },
  { name: "broadcast", ...NO_CONVERSATION_READ },
  { name: "poll", ...MARKED_CONTENT },
  { name: "poll-vote", ...CONVERSATION_READ, crossContext: "guard" },
  { name: "react", ...CONVERSATION_READ },
  { name: "reactions", ...TARGETED_RETRIEVAL },
  { name: "read", ...TARGETED_RETRIEVAL },
  { name: "edit", ...PROVIDER_WRITE },
  { name: "unsend", ...CONVERSATION_READ },
  { name: "reply", ...MARKED_CONTENT },
  { name: "sendWithEffect", ...CONTENT_SEND },
  { name: "renameGroup", ...TARGETED_ACTION },
  { name: "setGroupIcon", ...TARGETED_ACTION },
  { name: "addParticipant", ...TARGETED_ACTION },
  { name: "removeParticipant", ...TARGETED_ACTION },
  { name: "leaveGroup", ...TARGETED_ACTION },
  { name: "sendAttachment", ...CONTENT_SEND },
  { name: "delete", ...PROVIDER_WRITE },
  { name: "pin", ...PROVIDER_WRITE },
  { name: "unpin", ...PROVIDER_WRITE },
  { name: "list-pins", ...TARGETED_RETRIEVAL },
  { name: "permissions", ...TARGETED_RETRIEVAL },
  { name: "thread-create", ...GUARDED_ACTION },
  { name: "thread-list", ...RETRIEVAL },
  { name: "thread-reply", ...CONTENT_SEND },
  { name: "search", ...RETRIEVAL },
  { name: "sticker", ...MARKED_CONTENT },
  {
    name: "sticker-search",
    ...RETRIEVAL,
    readPolicy: { kind: "conversation-read", targetlessCache: "bundled-current-context" },
  },
  { name: "member-info", ...RETRIEVAL },
  { name: "role-info", ...RETRIEVAL },
  { name: "emoji-list", ...RETRIEVAL },
  { name: "emoji-upload", ...NO_CONVERSATION_READ },
  { name: "sticker-upload", ...NO_CONVERSATION_READ },
  { name: "role-add", ...NO_CONVERSATION_READ },
  { name: "role-remove", ...NO_CONVERSATION_READ },
  { name: "channel-info", ...RETRIEVAL, targetMode: "channelId" },
  { name: "channel-list", ...RETRIEVAL },
  { name: "channel-create", ...NO_CONVERSATION_READ },
  { name: "conversation-open", ...NO_CONVERSATION_READ },
  { name: "channel-edit", ...CHANNEL_TARGETED_ACTION, scheduledWrite: "operator" },
  { name: "channel-delete", ...CHANNEL_TARGETED_ACTION },
  { name: "channel-move", ...CHANNEL_TARGETED_ACTION },
  { name: "category-create", ...NO_CONVERSATION_READ },
  { name: "category-edit", ...NO_CONVERSATION_READ },
  { name: "category-delete", ...NO_CONVERSATION_READ },
  { name: "topic-create", ...GUARDED_ACTION },
  { name: "topic-edit", ...GUARDED_ACTION },
  { name: "voice-status", ...RETRIEVAL },
  { name: "event-list", ...RETRIEVAL },
  { name: "event-create", ...NO_CONVERSATION_READ },
  { name: "timeout", ...NO_CONVERSATION_READ },
  { name: "kick", ...NO_CONVERSATION_READ },
  { name: "ban", ...NO_CONVERSATION_READ },
  { name: "set-profile", ...NO_CONVERSATION_READ },
  { name: "set-presence", ...NO_CONVERSATION_READ },
  { name: "download-file", ...RETRIEVAL },
  { name: "upload-file", ...CONTENT_SEND },
] as const satisfies readonly ({ readonly name: string } & ChannelMessageActionFacts)[];

type ActionNames<Definitions extends readonly { readonly name: string }[]> = {
  -readonly [Index in keyof Definitions]: Definitions[Index]["name"];
};

export const CHANNEL_MESSAGE_ACTION_NAMES: Readonly<
  ActionNames<typeof CHANNEL_MESSAGE_ACTION_DEFINITIONS>
> =
  // SAFETY: Mapping each row's name preserves the exact tuple order and length.
  CHANNEL_MESSAGE_ACTION_DEFINITIONS.map(({ name }) => name) as ActionNames<
    typeof CHANNEL_MESSAGE_ACTION_DEFINITIONS
  >;

export type ChannelMessageActionName = (typeof CHANNEL_MESSAGE_ACTION_NAMES)[number];

const CHANNEL_MESSAGE_ACTION_FACTS = new Map<string, ChannelMessageActionFacts>(
  CHANNEL_MESSAGE_ACTION_DEFINITIONS.map((action) => [action.name, action]),
);

export function resolveChannelMessageActionFacts(
  action: unknown,
): ChannelMessageActionFacts | undefined {
  return typeof action === "string" ? CHANNEL_MESSAGE_ACTION_FACTS.get(action) : undefined;
}

/** Return true when a message action sends or uploads user-visible content. */
export function isMessageToolSendActionName(action: unknown): boolean {
  const normalized = normalizeOptionalString(action) ?? "";
  return resolveChannelMessageActionFacts(normalized)?.sendsContent === true;
}
