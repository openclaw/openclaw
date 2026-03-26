import type { AgentTool } from "@mariozechner/pi-agent-core";

export type TaskProfileId = "coding" | "research" | "ops" | "assistant";

export type TaskProfileSource =
  | "explicit"
  | "session-key"
  | "workspace-dir"
  | "prompt-text"
  | "tool-surface"
  | "default";

export type TaskProfileResolution = {
  id: TaskProfileId;
  source: TaskProfileSource;
  signal?: string;
};

const SPECIFIC_PROFILE_HINTS: Array<{
  id: Exclude<TaskProfileId, "assistant">;
  patterns: RegExp[];
}> = [
  { id: "coding", patterns: [/\bcoding\b/i, /\bcoder\b/i, /\bdev(eloper)?\b/i] },
  { id: "research", patterns: [/\bresearch\b/i, /\bresearcher\b/i, /\banalysis\b/i] },
  {
    id: "ops",
    patterns: [/\bops\b/i, /\boperations\b/i, /\boperator\b/i, /\bdevops\b/i, /\bsre\b/i],
  },
];

const ASSISTANT_PROFILE_HINTS: RegExp[] = [/\bassistant\b/i, /\bdefault\b/i, /\bmain\b/i];
const PROMPT_PROFILE_HINTS: Array<{ id: TaskProfileId; patterns: RegExp[] }> = [
  {
    id: "coding",
    patterns: [
      /\b(fix|implement|refactor|patch|debug|build|lint|test|compile|typecheck)\b/i,
      /\b(ts|tsx|js|jsx|py|rs|go|java|swift|sql|yaml|yml|json|toml)\b/i,
      /(^|[\s`"'])((src|app|lib|tests?)\/|package\.json|tsconfig\.json|pnpm-lock\.yaml)/i,
    ],
  },
  {
    id: "ops",
    patterns: [
      /\b(restart|deploy|rollout|health|status|logs?|service|incident|gateway|cron|node|nodes)\b/i,
      /\b(systemctl|launchctl|kubectl|docker|journalctl)\b/i,
    ],
  },
  {
    id: "research",
    patterns: [
      /\b(research|analy[sz]e|analysis|summari[sz]e|compare|investigate|look up)\b/i,
      /\b(latest|news|docs?|document(?:ation)?|paper|article|search the web)\b/i,
    ],
  },
  {
    id: "assistant",
    patterns: [/\b(reply|respond|draft|notify|compose)\b/i],
  },
];

const OPS_TOOL_NAMES = new Set(["cron", "gateway", "nodes"]);
const CODING_TOOL_NAMES = new Set([
  "read",
  "write",
  "edit",
  "apply_patch",
  "exec",
  "process",
  "image",
  "sessions_spawn",
  "sessions_yield",
  "subagents",
]);
const RESEARCH_TOOL_NAMES = new Set(["web_search", "web_fetch", "browser", "memory_search"]);
const ASSISTANT_TOOL_NAMES = new Set(["message", "sessions_send", "session_status"]);

function matchSpecificProfileHint(
  value: string | undefined,
  source: Extract<TaskProfileSource, "session-key" | "workspace-dir">,
): TaskProfileResolution | undefined {
  const normalized = value?.trim();
  if (!normalized) {
    return undefined;
  }
  for (const hint of SPECIFIC_PROFILE_HINTS) {
    if (hint.patterns.some((pattern) => pattern.test(normalized))) {
      return { id: hint.id, source, signal: normalized };
    }
  }
  return undefined;
}

function matchAssistantHint(
  value: string | undefined,
  source: Extract<TaskProfileSource, "session-key" | "workspace-dir">,
): TaskProfileResolution | undefined {
  const normalized = value?.trim();
  if (!normalized) {
    return undefined;
  }
  if (ASSISTANT_PROFILE_HINTS.some((pattern) => pattern.test(normalized))) {
    return { id: "assistant", source, signal: normalized };
  }
  return undefined;
}

function resolveProfileFromTools(tools: AgentTool[]): TaskProfileResolution | undefined {
  const toolNames = new Set(
    tools
      .map((tool) => tool.name)
      .filter((name): name is string => typeof name === "string" && name.length > 0),
  );
  const firstMatch = (candidates: Set<string>): string | undefined =>
    Array.from(toolNames).find((name) => candidates.has(name));

  const codingMatch = firstMatch(CODING_TOOL_NAMES);
  if (codingMatch) {
    return { id: "coding", source: "tool-surface", signal: codingMatch };
  }

  const opsMatch = firstMatch(OPS_TOOL_NAMES);
  if (opsMatch) {
    return { id: "ops", source: "tool-surface", signal: opsMatch };
  }

  const researchMatch = firstMatch(RESEARCH_TOOL_NAMES);
  if (researchMatch) {
    return { id: "research", source: "tool-surface", signal: researchMatch };
  }

  const assistantMatch = firstMatch(ASSISTANT_TOOL_NAMES);
  if (assistantMatch) {
    return { id: "assistant", source: "tool-surface", signal: assistantMatch };
  }

  return undefined;
}

function resolveProfileFromPrompt(promptText?: string): TaskProfileResolution | undefined {
  const normalized = promptText?.trim();
  if (!normalized) {
    return undefined;
  }
  for (const hint of PROMPT_PROFILE_HINTS) {
    for (const pattern of hint.patterns) {
      const match = normalized.match(pattern);
      if (match?.[0]) {
        return {
          id: hint.id,
          source: "prompt-text",
          signal: match[0],
        };
      }
    }
  }
  return undefined;
}

export function resolveTaskProfile(params: {
  explicit?: TaskProfileResolution | TaskProfileId;
  sessionKey?: string;
  workspaceDir?: string;
  promptText?: string;
  tools: AgentTool[];
}): TaskProfileResolution {
  const explicit =
    typeof params.explicit === "string"
      ? { id: params.explicit, source: "explicit" as const }
      : params.explicit
        ? { ...params.explicit, source: "explicit" as const }
        : undefined;
  if (explicit) {
    return explicit;
  }

  const fromSessionKey = matchSpecificProfileHint(params.sessionKey, "session-key");
  if (fromSessionKey) {
    return fromSessionKey;
  }

  const fromWorkspaceDir = matchSpecificProfileHint(params.workspaceDir, "workspace-dir");
  if (fromWorkspaceDir) {
    return fromWorkspaceDir;
  }

  const fromPrompt = resolveProfileFromPrompt(params.promptText);
  if (fromPrompt) {
    return fromPrompt;
  }

  const fromTools = resolveProfileFromTools(params.tools);
  if (fromTools) {
    return fromTools;
  }

  const assistantFromSessionKey = matchAssistantHint(params.sessionKey, "session-key");
  if (assistantFromSessionKey) {
    return assistantFromSessionKey;
  }

  const assistantFromWorkspaceDir = matchAssistantHint(params.workspaceDir, "workspace-dir");
  if (assistantFromWorkspaceDir) {
    return assistantFromWorkspaceDir;
  }

  return { id: "assistant", source: "default" };
}
