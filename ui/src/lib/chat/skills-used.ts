import {
  createConversationSkillLoadCollector,
  type ConversationSkillLoad,
} from "../../../../src/chat/conversation-skills.js";

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
