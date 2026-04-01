import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { SessionSystemPromptReport } from "../config/sessions/types.js";
import { buildBootstrapInjectionStats } from "./bootstrap-budget.js";
import type { EmbeddedContextFile } from "./pi-embedded-helpers.js";
import type { WorkspaceBootstrapFile } from "./workspace.js";

const STARTUP_MEMORY_FILE_NAMES = new Set(["MEMORY.md", "memory.md"]);
const SEARCHABLE_MEMORY_TOOL_NAMES = new Set(["memory_search", "memory_get"]);

function isConversationRecallTool(name: string): boolean {
  return /^lcm_/i.test(name);
}

function extractBetween(
  input: string,
  startMarker: string,
  endMarker: string,
): { text: string; found: boolean } {
  const start = input.indexOf(startMarker);
  if (start === -1) {
    return { text: "", found: false };
  }
  const end = input.indexOf(endMarker, start + startMarker.length);
  if (end === -1) {
    return { text: input.slice(start), found: true };
  }
  return { text: input.slice(start, end), found: true };
}

function parseSkillBlocks(skillsPrompt: string): Array<{ name: string; blockChars: number }> {
  const prompt = skillsPrompt.trim();
  if (!prompt) {
    return [];
  }
  const blocks = Array.from(prompt.matchAll(/<skill>[\s\S]*?<\/skill>/gi)).map(
    (match) => match[0] ?? "",
  );
  return blocks
    .map((block) => {
      const name = block.match(/<name>\s*([^<]+?)\s*<\/name>/i)?.[1]?.trim() || "(unknown)";
      return { name, blockChars: block.length };
    })
    .filter((b) => b.blockChars > 0);
}

function buildToolsEntries(tools: AgentTool[]): SessionSystemPromptReport["tools"]["entries"] {
  return tools.map((tool) => {
    const name = tool.name;
    const summary = tool.description?.trim() || tool.label?.trim() || "";
    const summaryChars = summary.length;
    const schemaChars = (() => {
      if (!tool.parameters || typeof tool.parameters !== "object") {
        return 0;
      }
      try {
        return JSON.stringify(tool.parameters).length;
      } catch {
        return 0;
      }
    })();
    const propertiesCount = (() => {
      const schema =
        tool.parameters && typeof tool.parameters === "object"
          ? (tool.parameters as Record<string, unknown>)
          : null;
      const props = schema && typeof schema.properties === "object" ? schema.properties : null;
      if (!props || typeof props !== "object") {
        return null;
      }
      return Object.keys(props as Record<string, unknown>).length;
    })();
    return { name, summaryChars, schemaChars, propertiesCount };
  });
}

function extractToolListText(systemPrompt: string): string {
  const markerA = "Tool names are case-sensitive. Call tools exactly as listed.\n";
  const markerB =
    "\nTOOLS.md does not control tool availability; it is user guidance for how to use external tools.";
  const extracted = extractBetween(systemPrompt, markerA, markerB);
  if (!extracted.found) {
    return "";
  }
  return extracted.text.replace(markerA, "").trim();
}

export function buildSystemPromptReport(params: {
  source: SessionSystemPromptReport["source"];
  generatedAt: number;
  sessionId?: string;
  sessionKey?: string;
  provider?: string;
  model?: string;
  workspaceDir?: string;
  bootstrapMaxChars: number;
  bootstrapTotalMaxChars?: number;
  bootstrapTruncation?: SessionSystemPromptReport["bootstrapTruncation"];
  sandbox?: SessionSystemPromptReport["sandbox"];
  systemPrompt: string;
  bootstrapFiles: WorkspaceBootstrapFile[];
  injectedFiles: EmbeddedContextFile[];
  skillsPrompt: string;
  tools: AgentTool[];
}): SessionSystemPromptReport {
  const systemPrompt = params.systemPrompt.trim();
  const projectContext = extractBetween(
    systemPrompt,
    "\n# Project Context\n",
    "\n## Silent Replies\n",
  );
  const projectContextChars = projectContext.text.length;
  const toolListText = extractToolListText(systemPrompt);
  const toolListChars = toolListText.length;
  const toolsEntries = buildToolsEntries(params.tools);
  const toolsSchemaChars = toolsEntries.reduce((sum, t) => sum + (t.schemaChars ?? 0), 0);
  const skillsEntries = parseSkillBlocks(params.skillsPrompt);
  const injectedWorkspaceFiles = buildBootstrapInjectionStats({
    bootstrapFiles: params.bootstrapFiles,
    injectedFiles: params.injectedFiles,
  });
  const startupMemoryFiles = injectedWorkspaceFiles
    .filter((file) => STARTUP_MEMORY_FILE_NAMES.has(file.name))
    .map((file) => ({
      name: file.name,
      path: file.path,
      status: file.missing
        ? ("missing" as const)
        : file.injectedChars > 0
          ? ("loaded" as const)
          : ("present-not-injected" as const),
      rawChars: file.rawChars,
      injectedChars: file.injectedChars,
    }));
  const searchableMemoryTools = toolsEntries
    .map((tool) => tool.name)
    .filter((name) => SEARCHABLE_MEMORY_TOOL_NAMES.has(name));
  const recallTools = toolsEntries.map((tool) => tool.name).filter(isConversationRecallTool);

  return {
    source: params.source,
    generatedAt: params.generatedAt,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    provider: params.provider,
    model: params.model,
    workspaceDir: params.workspaceDir,
    bootstrapMaxChars: params.bootstrapMaxChars,
    bootstrapTotalMaxChars: params.bootstrapTotalMaxChars,
    ...(params.bootstrapTruncation ? { bootstrapTruncation: params.bootstrapTruncation } : {}),
    sandbox: params.sandbox,
    systemPrompt: {
      chars: systemPrompt.length,
      projectContextChars,
      nonProjectContextChars: Math.max(0, systemPrompt.length - projectContextChars),
    },
    memory: {
      startup: {
        files: startupMemoryFiles,
      },
      searchable: {
        available: searchableMemoryTools.length > 0,
        toolNames: searchableMemoryTools,
        noteRoots: ["memory/"],
      },
      recall: {
        available: recallTools.length > 0,
        toolNames: recallTools,
      },
    },
    injectedWorkspaceFiles,
    skills: {
      promptChars: params.skillsPrompt.length,
      entries: skillsEntries,
    },
    tools: {
      listChars: toolListChars,
      schemaChars: toolsSchemaChars,
      entries: toolsEntries,
    },
  };
}
