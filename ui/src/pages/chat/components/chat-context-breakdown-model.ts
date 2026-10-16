import type { SessionSystemPromptReport } from "../../../../../src/config/sessions/session-system-prompt-report.js";

export type ContextCategory = {
  id: "messages" | "files" | "skills" | "tools" | "system";
  tokens: number | null;
  entries: Array<{ name: string; tokens: number | null }>;
};

/** These are character estimates, not provider tokenization. Prompt sections are disjoint. */
export function buildChatContextCategories(
  report: SessionSystemPromptReport,
  used: number,
): ContextCategory[] {
  const estimate = (chars: number) => Math.round(chars / 4);
  const files = report.injectedWorkspaceFiles.map((file) => ({
    name: file.name,
    tokens: file.injectedChars === null ? null : estimate(file.injectedChars),
  }));
  const fileChars = report.injectedWorkspaceFiles.some((file) => file.injectedChars === null)
    ? null
    : report.injectedWorkspaceFiles.reduce((sum, file) => sum + (file.injectedChars ?? 0), 0);
  const fixed = estimate(report.systemPrompt.chars + report.tools.schemaChars);
  // Do not call an inconsistent estimate "zero messages", or count embedded
  // memory/skills twice as both their own category and the whole system prompt.
  return [
    {
      id: "messages",
      tokens: fileChars === null || fixed > used ? null : used - fixed,
      entries: [],
    },
    { id: "files", tokens: fileChars === null ? null : estimate(fileChars), entries: files },
    {
      id: "tools",
      tokens: estimate(report.tools.schemaChars + report.tools.listChars),
      entries: report.tools.entries.map((tool) => ({
        name: tool.name,
        tokens: estimate(tool.schemaChars),
      })),
    },
    {
      id: "skills",
      tokens: estimate(report.skills.promptChars),
      entries: report.skills.entries.map((skill) => ({
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
