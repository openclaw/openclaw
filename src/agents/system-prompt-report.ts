import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionSystemPromptReport } from "../config/sessions/types.js";
import { buildBootstrapInjectionStats } from "./bootstrap-budget.js";
import { buildDelegationProfile } from "./delegation-profile.js";
import type { EmbeddedContextFile } from "./pi-embedded-helpers.js";
import { resolveTaskProfile } from "./task-profile.js";
import { discoverWorkspacePolicyFiles, type WorkspaceBootstrapFile } from "./workspace.js";
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

function buildPromptBudget(params: {
  systemPromptChars: number;
  workspaceInjectedChars: number;
  skillsPromptChars: number;
  toolListChars: number;
  toolSchemaChars: number;
}): SessionSystemPromptReport["promptBudget"] {
  const workspaceInjectedChars = Math.max(0, params.workspaceInjectedChars);
  const skillsPromptChars = Math.max(0, params.skillsPromptChars);
  const toolListChars = Math.max(0, params.toolListChars);
  const toolSchemaChars = Math.max(0, params.toolSchemaChars);
  const trackedInsideSystemPrompt = workspaceInjectedChars + skillsPromptChars + toolListChars;
  return {
    totalTrackedChars: Math.max(0, params.systemPromptChars) + toolSchemaChars,
    workspaceInjectedChars,
    skillsPromptChars,
    toolListChars,
    otherSystemPromptChars: Math.max(0, params.systemPromptChars - trackedInsideSystemPrompt),
    toolSchemaChars,
  };
}

export function buildSystemPromptReport(params: {
  source: SessionSystemPromptReport["source"];
  generatedAt: number;
  sessionId?: string;
  sessionKey?: string;
  provider?: string;
  model?: string;
  workspaceDir?: string;
  spawnedBy?: string | null;
  config?: OpenClawConfig;
  bootstrapMaxChars: number;
  bootstrapTotalMaxChars?: number;
  bootstrapTruncation?: SessionSystemPromptReport["bootstrapTruncation"];
  sandbox?: SessionSystemPromptReport["sandbox"];
  systemPrompt: string;
  bootstrapFiles: WorkspaceBootstrapFile[];
  injectedFiles: EmbeddedContextFile[];
  skillsPrompt: string;
  tools: AgentTool[];
  taskProfile?: SessionSystemPromptReport["taskProfile"];
  toolPruning?: SessionSystemPromptReport["toolPruning"];
  skillPruning?: SessionSystemPromptReport["skillPruning"];
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
  const discoveredWorkspacePolicyFiles = discoverWorkspacePolicyFiles({
    dir: params.workspaceDir,
    bootstrapFiles: params.bootstrapFiles,
  });
  const injectedWorkspacePolicyFiles = discoveredWorkspacePolicyFiles.filter(
    (file) => file.autoInjected,
  );
  const conflictCount =
    new Set(
      injectedWorkspacePolicyFiles
        .filter((file) => file.conflictSummary)
        .map((file) => `${file.policyRole}:${file.name}`),
    ).size > 0
      ? new Set(
          injectedWorkspacePolicyFiles
            .filter((file) => file.conflictSummary)
            .map((file) => file.policyRole),
        ).size
      : 0;
  const workspaceInjectedChars = injectedWorkspaceFiles.reduce(
    (sum, file) => sum + Math.max(0, file.injectedChars),
    0,
  );
  const slicedFiles = injectedWorkspaceFiles.filter((file) => file.sliced);

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
    taskProfile:
      params.taskProfile ??
      resolveTaskProfile({
        sessionKey: params.sessionKey,
        workspaceDir: params.workspaceDir,
        tools: params.tools,
      }),
    workspacePolicyDiscovery: {
      totalDiscovered: discoveredWorkspacePolicyFiles.length,
      injectedCount: discoveredWorkspacePolicyFiles.filter((file) => file.autoInjected).length,
      candidateCount: discoveredWorkspacePolicyFiles.filter((file) => !file.autoInjected).length,
      mergeOrder: injectedWorkspacePolicyFiles.map((file) => file.name),
      conflictCount,
      entries: discoveredWorkspacePolicyFiles,
    },
    policySlicing: {
      totalSlicedChars: slicedFiles.reduce(
        (sum, file) => sum + Math.max(0, file.slicedChars ?? 0),
        0,
      ),
      slicedFileCount: slicedFiles.length,
      entries: slicedFiles.map((file) => ({
        name: file.name,
        path: file.path,
        slicedChars: Math.max(0, file.slicedChars ?? 0),
        reasons: file.sliceReasons ?? [],
      })),
    },
    ...(params.toolPruning ? { toolPruning: params.toolPruning } : {}),
    ...(params.skillPruning ? { skillPruning: params.skillPruning } : {}),
    delegationProfile: buildDelegationProfile({
      sessionKey: params.sessionKey,
      spawnedBy: params.spawnedBy,
      workspaceDir: params.workspaceDir,
      tools: params.tools,
      config: params.config,
    }),
    systemPrompt: {
      chars: systemPrompt.length,
      projectContextChars,
      nonProjectContextChars: Math.max(0, systemPrompt.length - projectContextChars),
    },
    promptBudget: buildPromptBudget({
      systemPromptChars: systemPrompt.length,
      workspaceInjectedChars,
      skillsPromptChars: params.skillsPrompt.length,
      toolListChars,
      toolSchemaChars: toolsSchemaChars,
    }),
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
