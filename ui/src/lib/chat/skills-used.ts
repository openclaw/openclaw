import {
  createConversationSkillLoadCollector,
  type ConversationSkillLoad,
} from "../../../../src/chat/conversation-skills.js";
import type { ChatHistoryState } from "../../pages/chat/chat-transcript-metadata.ts";
import {
  cacheChatSessionSnapshot,
  readChatSessionSnapshot,
  resolveChatSnapshotKey,
  type ChatHistoryCursorHost,
  type ChatMessageCache,
} from "../../pages/chat/session-message-cache.ts";

export function extendConversationSkillHistory(
  history: ChatHistoryState | null | undefined,
  messages: readonly unknown[],
): ChatHistoryState {
  const collector = createConversationSkillLoadCollector(history?.skillsUsed);
  for (const message of messages) {
    collector.add(message);
  }
  return { ...(history ?? { stateRevision: {} }), skillsUsed: collector.finish() };
}

export function retainLiveConversationSkillLoad(
  host: ChatHistoryCursorHost & {
    chatMessagesBySession?: ChatMessageCache;
    chatDisplayedLeafEntryId?: string | null;
  },
  scope: readonly [string, string | null | undefined, string | null | undefined],
  message: unknown,
) {
  const target = { sessionKey: host.sessionKey };
  if (
    !host.chatMessagesBySession ||
    resolveChatSnapshotKey(host, target) !== scope[0] ||
    host.currentSessionId !== scope[1] ||
    host.chatDisplayedLeafEntryId !== scope[2]
  ) {
    return;
  }
  const snapshot = readChatSessionSnapshot(host.chatMessagesBySession, host, target);
  if (!snapshot || snapshot.sessionId !== scope[1]) {
    return;
  }
  const historyState = extendConversationSkillHistory(snapshot.historyState, [message]);
  if (
    !historyState.skillsUsed?.length ||
    historyState.skillsUsed.length === snapshot.historyState?.skillsUsed?.length
  ) {
    return;
  }
  cacheChatSessionSnapshot(host.chatMessagesBySession, host, target, { ...snapshot, historyState });
}

export type ConversationSkillUse = { name: string; loads: number };
const cache = new WeakMap<
  readonly unknown[],
  {
    tools: readonly unknown[];
    recorded: readonly ConversationSkillLoad[];
    skills: ConversationSkillUse[];
  }
>();
const noRecordedLoads: readonly ConversationSkillLoad[] = [];

export function conversationSkillsUsed(
  messages: readonly unknown[],
  tools: readonly unknown[],
  recorded: readonly ConversationSkillLoad[] = noRecordedLoads,
): ConversationSkillUse[] {
  const previous = cache.get(messages);
  if (previous?.tools === tools && previous.recorded === recorded) {
    return previous.skills;
  }
  const collector = createConversationSkillLoadCollector(recorded);
  for (const source of [messages, tools]) {
    for (const message of source) {
      collector.add(message);
    }
  }
  const skills = new Map<string, ConversationSkillUse>();
  for (const load of collector.finish()) {
    const skill = skills.get(load.name);
    if (skill) {
      skill.loads++;
    } else {
      skills.set(load.name, { name: load.name, loads: 1 });
    }
  }
  const result = [...skills.values()];
  cache.set(messages, { tools, recorded, skills: result });
  return result;
}
