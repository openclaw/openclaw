import type { SessionSystemPromptReport } from "../../config/sessions/types.js";

export type ContextCategory = "system-prompt" | "workspace-files" | "skills" | "tools";

export type CategoryBreakdown = {
  category: ContextCategory;
  label: string;
  chars: number;
  tokens: number;
  itemCount: number;
};

export type CategoryDetailItem = {
  name: string;
  status?: string;
  chars: number;
  tokens: number;
  extra?: string;
};

export type SessionTokenInfo = {
  totalTokens: number | null;
  contextTokens: number | null;
};

export type ContextSnapshot = {
  timestamp: number;
  totalChars: number;
  totalTokens: number;
};

export type ContextHistory = {
  snapshots: ContextSnapshot[];
  maxCapacity: number;
};

export function estimateTokensFromChars(chars: number): number {
  return Math.ceil(Math.max(0, chars) / 4);
}

export function formatInt(n: number): string {
  return new Intl.NumberFormat("en-US").format(n);
}

export function formatCharsAndTokens(chars: number): string {
  return `${formatInt(chars)} chars (~${formatInt(estimateTokensFromChars(chars))} tok)`;
}

export function createHistory(maxCapacity = 60): ContextHistory {
  return { snapshots: [], maxCapacity };
}

export function pushSnapshot(history: ContextHistory, totalChars: number): void {
  const snapshot: ContextSnapshot = {
    timestamp: Date.now(),
    totalChars,
    totalTokens: estimateTokensFromChars(totalChars),
  };
  // Skip if identical to last
  const last = history.snapshots[history.snapshots.length - 1];
  if (last && last.totalChars === totalChars) {
    return;
  }
  history.snapshots.push(snapshot);
  if (history.snapshots.length > history.maxCapacity) {
    history.snapshots.shift();
  }
}

export function getCategoryBreakdown(report: SessionSystemPromptReport): CategoryBreakdown[] {
  // systemPrompt.chars already includes injected workspace files, skills, and tool-list text.
  // Only tool schemas (JSON) are additive. Break out the embedded portions so categories
  // are disjoint and sum to the real total without double-counting.
  const workspaceChars = report.injectedWorkspaceFiles.reduce((s, f) => s + f.injectedChars, 0);
  const skillsChars = report.skills.promptChars;
  const toolListChars = report.tools.listChars;
  const toolSchemaChars = report.tools.schemaChars;
  const coreSystemPromptChars = Math.max(
    0,
    report.systemPrompt.chars - workspaceChars - skillsChars - toolListChars,
  );

  return [
    {
      category: "system-prompt",
      label: "System Prompt",
      chars: coreSystemPromptChars,
      tokens: estimateTokensFromChars(coreSystemPromptChars),
      itemCount: 1,
    },
    {
      category: "workspace-files",
      label: "Workspace Files",
      chars: workspaceChars,
      tokens: estimateTokensFromChars(workspaceChars),
      itemCount: report.injectedWorkspaceFiles.length,
    },
    {
      category: "skills",
      label: "Skills",
      chars: skillsChars,
      tokens: estimateTokensFromChars(skillsChars),
      itemCount: report.skills.entries.length,
    },
    {
      category: "tools",
      label: "Tools",
      chars: toolListChars + toolSchemaChars,
      tokens: estimateTokensFromChars(toolListChars + toolSchemaChars),
      itemCount: report.tools.entries.length,
    },
  ];
}

export function getCategoryDetail(
  report: SessionSystemPromptReport,
  category: ContextCategory,
): CategoryDetailItem[] {
  switch (category) {
    case "system-prompt": {
      // Compute the same disjoint core as getCategoryBreakdown so detail rows
      // sum to the overview total. Workspace files, skills, and tool-list text
      // are embedded inside projectContextChars; subtract them to get the
      // core project context, leaving nonProjectContextChars untouched since
      // it contains framework/runtime prompt text with no embedded segments.
      const embeddedChars =
        report.injectedWorkspaceFiles.reduce((s, f) => s + f.injectedChars, 0) +
        report.skills.promptChars +
        report.tools.listChars;
      const coreProjectChars = Math.max(0, report.systemPrompt.projectContextChars - embeddedChars);
      return [
        {
          name: "Project Context",
          chars: coreProjectChars,
          tokens: estimateTokensFromChars(coreProjectChars),
        },
        {
          name: "Non-Project Context",
          chars: report.systemPrompt.nonProjectContextChars,
          tokens: estimateTokensFromChars(report.systemPrompt.nonProjectContextChars),
        },
      ];
    }
    case "workspace-files":
      return report.injectedWorkspaceFiles.map((f) => ({
        name: f.name,
        status: f.missing ? "MISSING" : f.truncated ? "TRUNCATED" : "OK",
        chars: f.injectedChars,
        tokens: estimateTokensFromChars(f.injectedChars),
      }));
    case "skills":
      return report.skills.entries
        .toSorted((a, b) => b.blockChars - a.blockChars)
        .map((s) => ({
          name: s.name,
          chars: s.blockChars,
          tokens: estimateTokensFromChars(s.blockChars),
        }));
    case "tools": {
      // The category total is listChars + schemaChars. listChars is extracted
      // from the system prompt tool-list block (names, formatting, summaries)
      // and isn't decomposable per tool, so show it as a dedicated row.
      // Per-tool rows use schemaChars which is individually attributable.
      const perTool = report.tools.entries
        .toSorted((a, b) => b.schemaChars - a.schemaChars)
        .map((t) => ({
          name: t.name,
          chars: t.schemaChars,
          tokens: estimateTokensFromChars(t.schemaChars),
          extra: t.propertiesCount != null ? `${t.propertiesCount} params` : undefined,
        }));
      return [
        {
          name: "(tool list text)",
          chars: report.tools.listChars,
          tokens: estimateTokensFromChars(report.tools.listChars),
        },
        ...perTool,
      ];
    }
  }
}

export function getTotalChars(report: SessionSystemPromptReport): number {
  // systemPrompt.chars includes workspace files, skills, and tool-list text.
  // Only tool schemas are additive (not embedded in the system prompt text).
  return report.systemPrompt.chars + report.tools.schemaChars;
}
