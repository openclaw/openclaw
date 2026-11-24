import type { SessionSystemPromptReport } from "./session-system-prompt-report.js";

export function promptReport(generatedAt: number, chars: number, promptChars: number) {
  return {
    source: "run",
    generatedAt,
    systemPrompt: { chars, projectContextChars: 0, nonProjectContextChars: chars },
    injectedWorkspaceFiles: [],
    skills: { promptChars, entries: [] },
    tools: { listChars: 0, schemaChars: 0, entries: [] },
  } satisfies SessionSystemPromptReport;
}
