import type { TeammateInfo } from "./teammates.js";

export type MentionContext = {
  wasMentioned: boolean;
  mentionType: "direct" | "implicit" | "none";
  otherBotsMentioned: TeammateInfo[];
  isReplyToSelf: boolean;
};

export type MentionContextParams = {
  messageText: string;
  selfUserId: string;
  teammates: TeammateInfo[];
  isReplyToSelf?: boolean;
};

const MENTION_PATTERN = /<@([A-Z0-9]+)>/g;

export function buildMentionContext(params: MentionContextParams): MentionContext {
  const { messageText, selfUserId, teammates, isReplyToSelf = false } = params;

  const mentions = [...messageText.matchAll(MENTION_PATTERN)].map((m) => m[1]);
  const directlyMentioned = mentions.includes(selfUserId);

  const teammateMap = new Map(teammates.map((t) => [t.userId, t]));
  const otherBotsMentioned = mentions
    .filter((id) => id !== selfUserId && teammateMap.has(id))
    .map((id) => teammateMap.get(id)!)
    .filter((v, i, arr) => arr.findIndex((t) => t.userId === v.userId) === i);

  let mentionType: MentionContext["mentionType"] = "none";
  if (directlyMentioned) {
    mentionType = "direct";
  } else if (isReplyToSelf) {
    mentionType = "implicit";
  }

  return {
    wasMentioned: directlyMentioned || isReplyToSelf,
    mentionType,
    otherBotsMentioned,
    isReplyToSelf,
  };
}

export function formatMentionContextHint(ctx: MentionContext): string | undefined {
  if (ctx.otherBotsMentioned.length === 0) {
    return undefined;
  }

  const names = ctx.otherBotsMentioned.map((t) => `@${t.name}`).join(", ");
  return `Note: This message also mentions ${names} - it may be directed at them.`;
}
