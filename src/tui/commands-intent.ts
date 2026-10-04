// Keyword slash command discovery for OpenClaw TUI autocomplete.

export type KeywordMatch = {
  command: string;
  description: string;
  matchedKeyword: string;
  score: number;
};

export const KEYWORD_TAGS: Record<string, readonly string[]> = {
  usage: [
    "token",
    "tokens",
    "cost",
    "pricing",
    "spend",
    "spending",
    "price",
    "bill",
    "billing",
    "quota",
    "consumption",
    "kharcha",
  ],
  model: ["switch", "llm", "provider", "select", "choose", "badlo", "pick"],
  new: ["fresh", "start", "restart", "wipe", "nayi", "naya", "clean"],
  reset: ["restart", "reboot", "reinitialize"],
  think: ["thinking", "reasoning", "thought", "deep", "depth"],
  reasoning: ["thinking", "depth", "stream", "deliberation"],
  fast: ["speed", "quick", "rapid", "turbo", "jaldi"],
  verbose: ["debug", "detailed", "trace", "logging"],
  status: ["gateway", "health", "system", "ping", "alive"],
  stop: ["abort", "cancel", "halt", "kill", "rok"],
  agent: ["persona", "bot", "assistant", "subagent"],
  session: ["thread", "history", "conversation", "branch"],
  help: ["commands", "manual", "info", "guide", "docs"],
  settings: ["config", "preferences", "options", "setup"],
  elevated: ["sudo", "admin", "permissions", "root", "bypass"],
  exit: ["quit", "bye", "close"],
};

export function matchSlashKeywords(
  word: string,
  availableCommands?: ReadonlySet<string>,
): KeywordMatch[] {
  if (!word || word.length < 2) {
    return [];
  }

  const lowered = word.toLowerCase();
  const scoredResults: KeywordMatch[] = [];
  const seen = new Set<string>();

  for (const [cmd, tags] of Object.entries(KEYWORD_TAGS)) {
    if (availableCommands && availableCommands.size > 0 && !availableCommands.has(cmd)) {
      continue;
    }
    for (const tag of tags) {
      let score = 0;
      if (tag === lowered) {
        score = 100;
      } else if (tag.startsWith(lowered)) {
        score = 80;
      } else if (lowered.length >= 4 && tag.includes(lowered)) {
        score = 50;
      }

      if (score > 0) {
        if (!seen.has(cmd)) {
          seen.add(cmd);
          scoredResults.push({
            command: cmd,
            description: `Matched keyword '${tag}'`,
            matchedKeyword: tag,
            score,
          });
        }
        break;
      }
    }
  }

  scoredResults.sort((a, b) => b.score - a.score);
  return scoredResults;
}
