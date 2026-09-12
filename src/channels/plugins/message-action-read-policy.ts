// Canonical action classification and loader-provenance read delegation policy.
import type { ChannelMessageActionName, ChannelPlugin } from "./types.js";

export type ChannelMessageActionReadPolicy =
  | { readonly kind: "none" }
  | {
      readonly kind: "conversation-read";
      readonly targetlessCache: "deny" | "bundled-current-context";
      readonly readOnly: boolean;
    };

const NO_CONVERSATION_READ = { kind: "none" } as const;
const CONVERSATION_READ = {
  kind: "conversation-read",
  targetlessCache: "deny",
  readOnly: false,
} as const;
const READ_ONLY_CONVERSATION_READ = {
  ...CONVERSATION_READ,
  readOnly: true,
} as const;
const BUNDLED_CURRENT_CONTEXT_CACHE_READ = {
  ...READ_ONLY_CONVERSATION_READ,
  targetlessCache: "bundled-current-context",
} as const;

// Exhaustive by design: every new core action must declare its read authority
// before the dispatcher will compile.
const CHANNEL_MESSAGE_ACTION_READ_POLICIES = {
  send: NO_CONVERSATION_READ,
  broadcast: NO_CONVERSATION_READ,
  poll: NO_CONVERSATION_READ,
  "poll-vote": CONVERSATION_READ,
  react: CONVERSATION_READ,
  reactions: READ_ONLY_CONVERSATION_READ,
  read: READ_ONLY_CONVERSATION_READ,
  edit: CONVERSATION_READ,
  unsend: CONVERSATION_READ,
  reply: NO_CONVERSATION_READ,
  sendWithEffect: NO_CONVERSATION_READ,
  renameGroup: NO_CONVERSATION_READ,
  setGroupIcon: NO_CONVERSATION_READ,
  addParticipant: NO_CONVERSATION_READ,
  removeParticipant: NO_CONVERSATION_READ,
  leaveGroup: NO_CONVERSATION_READ,
  sendAttachment: NO_CONVERSATION_READ,
  delete: CONVERSATION_READ,
  pin: CONVERSATION_READ,
  unpin: CONVERSATION_READ,
  "list-pins": READ_ONLY_CONVERSATION_READ,
  permissions: READ_ONLY_CONVERSATION_READ,
  "thread-create": NO_CONVERSATION_READ,
  "thread-list": READ_ONLY_CONVERSATION_READ,
  "thread-reply": NO_CONVERSATION_READ,
  search: READ_ONLY_CONVERSATION_READ,
  sticker: NO_CONVERSATION_READ,
  "sticker-search": BUNDLED_CURRENT_CONTEXT_CACHE_READ,
  "member-info": READ_ONLY_CONVERSATION_READ,
  "role-info": READ_ONLY_CONVERSATION_READ,
  "emoji-list": READ_ONLY_CONVERSATION_READ,
  "emoji-upload": NO_CONVERSATION_READ,
  "sticker-upload": NO_CONVERSATION_READ,
  "role-add": NO_CONVERSATION_READ,
  "role-remove": NO_CONVERSATION_READ,
  "channel-info": READ_ONLY_CONVERSATION_READ,
  "channel-list": READ_ONLY_CONVERSATION_READ,
  "channel-create": NO_CONVERSATION_READ,
  "conversation-open": NO_CONVERSATION_READ,
  "channel-edit": NO_CONVERSATION_READ,
  "channel-delete": NO_CONVERSATION_READ,
  "channel-move": NO_CONVERSATION_READ,
  "category-create": NO_CONVERSATION_READ,
  "category-edit": NO_CONVERSATION_READ,
  "category-delete": NO_CONVERSATION_READ,
  "topic-create": NO_CONVERSATION_READ,
  "topic-edit": NO_CONVERSATION_READ,
  "voice-status": READ_ONLY_CONVERSATION_READ,
  "event-list": READ_ONLY_CONVERSATION_READ,
  "event-create": NO_CONVERSATION_READ,
  timeout: NO_CONVERSATION_READ,
  kick: NO_CONVERSATION_READ,
  ban: NO_CONVERSATION_READ,
  "set-profile": NO_CONVERSATION_READ,
  "set-presence": NO_CONVERSATION_READ,
  "download-file": CONVERSATION_READ,
  "upload-file": NO_CONVERSATION_READ,
} as const satisfies Record<ChannelMessageActionName, ChannelMessageActionReadPolicy>;

export function resolveChannelMessageActionReadPolicy(
  action: unknown,
): ChannelMessageActionReadPolicy | undefined {
  if (typeof action !== "string" || !Object.hasOwn(CHANNEL_MESSAGE_ACTION_READ_POLICIES, action)) {
    return undefined;
  }
  // SAFETY: the own-key check above restricts the string to the exhaustive action map.
  return CHANNEL_MESSAGE_ACTION_READ_POLICIES[action as ChannelMessageActionName];
}

export type MessageActionReadEnforcement =
  | { kind: "provider-owned" }
  | {
      kind: "host-exact-current";
      pluginTrust: "bundled" | "external";
    };

export function resolveMessageActionReadEnforcement(params: {
  action: ChannelMessageActionName;
  actions: ChannelPlugin["actions"];
  pluginOrigin: string | undefined;
  pluginTrustedOfficialInstall?: boolean;
}): MessageActionReadEnforcement {
  const providerOwnedReadGates = params.actions?.providerOwnedReadGates;
  const actionPolicy = resolveChannelMessageActionReadPolicy(params.action);
  // Read-capable actions can also mutate provider or local state. Do not expand
  // their authority without a provider-side final-effect lifecycle fence.
  const officialReadOnly =
    params.pluginTrustedOfficialInstall === true &&
    params.actions?.conversationReadAuthority?.version === 2 &&
    actionPolicy?.kind === "conversation-read" &&
    actionPolicy.readOnly;
  if (
    (params.pluginOrigin === "bundled" || officialReadOnly) &&
    (providerOwnedReadGates === true || providerOwnedReadGates?.includes(params.action) === true)
  ) {
    return { kind: "provider-owned" };
  }
  return {
    kind: "host-exact-current",
    pluginTrust: params.pluginOrigin === "bundled" ? "bundled" : "external",
  };
}
