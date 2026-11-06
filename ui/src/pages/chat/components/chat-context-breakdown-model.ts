import type { SessionSystemPromptReport } from "../../../../../src/config/sessions/session-system-prompt-report.js";

export type ContextEntry = {
  key: string;
  name: string;
  path?: string;
  tokens: number | null;
};
export type ContextGroup = {
  key: string;
  kind:
    | "agent-workspace"
    | "execution-project"
    | "personal"
    | "other"
    | "openclaw"
    | "mcp"
    | "client"
    | "unknown-tools";
  name?: string;
  path?: string;
  tokens: number | null;
  entries: ContextEntry[];
};
export type ContextCategory = {
  id: "messages" | "files" | "skills" | "tools" | "system";
  tokens: number | null;
  entries: ContextEntry[];
  groups?: ContextGroup[];
};

const estimate = (chars: number) => Math.round(chars / 4);
const sumTokens = (entries: ContextEntry[]) =>
  entries.some((entry) => entry.tokens === null)
    ? null
    : entries.reduce((sum, entry) => sum + (entry.tokens ?? 0), 0);
const parentPath = (path: string) => path.replace(/[\\/][^\\/]*$/, "");
const basename = (path: string) =>
  path
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .pop();

export function buildDeferredContextGroups(report: SessionSystemPromptReport): ContextGroup[] {
  return toolGroups(report.tools.deferred?.entries ?? []);
}

function toolGroups(
  tools: Array<{
    name: string;
    source?: "openclaw" | "mcp" | "client";
    sourceName?: string;
    serverName?: string;
    schemaChars: number | null;
  }>,
): ContextGroup[] {
  const groups = new Map<string, ContextGroup>();
  for (const tool of tools) {
    const kind = tool.source ?? "unknown-tools";
    const name =
      kind === "mcp"
        ? (tool.serverName ?? tool.sourceName)
        : kind === "client"
          ? tool.sourceName
          : undefined;
    const key = kind + ":" + (name ?? "");
    let group = groups.get(key);
    if (!group) {
      group = { key, kind, name, tokens: 0, entries: [] };
      groups.set(key, group);
    }
    group.entries.push({
      key: tool.name,
      name: tool.name,
      tokens: tool.schemaChars === null ? null : estimate(tool.schemaChars),
    });
  }
  return Array.from(groups.values(), (group) => ({ ...group, tokens: sumTokens(group.entries) }));
}

/** Character estimates, not provider tokenization. Deferred schemas never enter consumed totals. */
export function buildChatContextCategories(
  report: SessionSystemPromptReport,
  used: number,
): ContextCategory[] {
  const groups = new Map<string, ContextGroup>();
  for (const file of report.injectedWorkspaceFiles) {
    const kind = file.origin?.kind ?? "other";
    const path = file.origin?.rootPath ?? parentPath(file.path);
    const key = kind + ":" + path;
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        kind,
        path,
        name: kind === "execution-project" || kind === "other" ? basename(path) : undefined,
        tokens: 0,
        entries: [],
      };
      groups.set(key, group);
    }
    group.entries.push({
      key: file.path,
      name: file.name,
      path: file.path,
      tokens: file.injectedChars === null ? null : estimate(file.injectedChars),
    });
  }
  const files = Array.from(groups.values(), (group) => ({
    ...group,
    tokens: sumTokens(group.entries),
  }));
  const tools = toolGroups(report.tools.entries);
  const fileEntries = files.flatMap((group) => group.entries);
  const fileChars = report.injectedWorkspaceFiles.some((file) => file.injectedChars === null)
    ? null
    : report.injectedWorkspaceFiles.reduce((sum, file) => sum + (file.injectedChars ?? 0), 0);
  const fixed = estimate(report.systemPrompt.chars + report.tools.schemaChars);
  // Do not call an inconsistent estimate "zero messages", or count embedded
  // files/skills twice as both their own category and the whole system prompt.
  return [
    {
      id: "messages",
      tokens: fileChars === null || fixed > used ? null : used - fixed,
      entries: [],
    },
    {
      id: "files",
      tokens: fileChars === null ? null : estimate(fileChars),
      entries: fileEntries,
      groups: files,
    },
    {
      id: "tools",
      tokens: estimate(report.tools.schemaChars + report.tools.listChars),
      entries: tools.flatMap((group) => group.entries),
      groups: tools,
    },
    {
      id: "skills",
      tokens: estimate(report.skills.promptChars),
      entries: report.skills.entries.map((skill) => ({
        key: skill.name,
        name: skill.name,
        tokens: estimate(skill.blockChars),
      })),
    },
    {
      id: "system",
      tokens:
        fileChars === null
          ? null
          : estimate(
              Math.max(
                0,
                report.systemPrompt.chars -
                  fileChars -
                  report.skills.promptChars -
                  report.tools.listChars,
              ),
            ),
      entries: [],
    },
  ];
}
