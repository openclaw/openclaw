import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { createAgentSession, SessionManager, SettingsManager } from "@mariozechner/pi-coding-agent";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveOpenClawAgentDir } from "../../agents/agent-paths.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../../agents/defaults.js";
import { getApiKeyForModel } from "../../agents/model-auth.js";
import { ensureOpenClawModelsJson } from "../../agents/models-config.js";
import { ensureSessionHeader } from "../../agents/pi-embedded-helpers.js";
import { applyExtraParamsToAgent } from "../../agents/pi-embedded-runner/extra-params.js";
import { resolveModel } from "../../agents/pi-embedded-runner/model.js";
import { resolveUserPath } from "../../utils.js";
import {
  prefixDoltSummaryFrontmatter,
  serializeDoltSummaryFrontmatter,
  type DoltSummaryType,
} from "./contract.js";
import { type DoltPromptOverrides, resolveDoltPromptTemplate } from "./prompts.js";

export const DOLT_SUMMARY_MAX_OUTPUT_TOKENS = 2000;
export const DOLT_LEAF_MIN_SOURCE_TURNS = 2;

export type DoltRollupPromptTemplateId = "leaf" | "bindle" | "reset-short-bindle";

export type DoltRollupSummaryType = DoltSummaryType;

export type DoltSummarySourceTurn = {
  pointer: string;
  role: string;
  content: string;
  timestampMs?: number;
  safetyRelevantToolOutcome?: boolean;
};

export type DoltSummaryModelSelection = {
  provider: string;
  modelId: string;
};

export type DoltSummaryMetadata = {
  summary_type: DoltRollupSummaryType;
  finalized_at_reset: boolean;
  prompt_template: DoltRollupPromptTemplateId;
  max_output_tokens: number;
};

export type DoltSummarizeParams = {
  sourceTurns: DoltSummarySourceTurn[];
  mode: DoltRollupPromptTemplateId;
  datesCovered: {
    startEpochMs: number;
    endEpochMs: number;
  };
  childPointers: string[];
  finalizedAtReset?: boolean;
  promptOverrides?: DoltPromptOverrides;
  provider?: string;
  model?: string;
  providerOverride?: string;
  modelOverride?: string;
  config?: OpenClawConfig;
  authProfileId?: string;
  agentDir?: string;
  workspaceDir?: string;
  runPrompt?: (params: DoltSummaryPromptRunParams) => Promise<string>;
};

export type DoltSummaryPromptRunParams = {
  prompt: string;
  modelSelection: DoltSummaryModelSelection;
  maxOutputTokens: number;
  config?: OpenClawConfig;
  authProfileId?: string;
  agentDir?: string;
  workspaceDir?: string;
};

export type DoltSummarizeResult = {
  summary: string;
  metadata: DoltSummaryMetadata;
  modelSelection: DoltSummaryModelSelection;
};

type DoltSummaryPromptTemplate = {
  id: DoltRollupPromptTemplateId;
  label: string;
  summaryType: DoltRollupSummaryType;
};

const PROMPT_TEMPLATE_MAP: Record<DoltRollupPromptTemplateId, DoltSummaryPromptTemplate> = {
  leaf: { id: "leaf", label: "normal leaf rollup", summaryType: "leaf" },
  bindle: { id: "bindle", label: "normal bindle rollup", summaryType: "bindle" },
  "reset-short-bindle": {
    id: "reset-short-bindle",
    label: "reset short-bindle rollup",
    summaryType: "bindle",
  },
};

/**
 * Resolve which provider/model pair the Dolt summarizer will use.
 * This matches the legacy compaction fallback pattern:
 * explicit override -> provided pair -> defaults.
 */
export function resolveDoltSummaryModelSelection(
  params: Pick<DoltSummarizeParams, "provider" | "model" | "providerOverride" | "modelOverride">,
): DoltSummaryModelSelection {
  const provider =
    (params.providerOverride ?? params.provider ?? DEFAULT_PROVIDER).trim() || DEFAULT_PROVIDER;
  const modelId = (params.modelOverride ?? params.model ?? DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  return { provider, modelId };
}

/**
 * Summarize source turns into a single Dolt leaf/bindle summary.
 * Runs synchronously inline and enforces output caps + source floor.
 */
export async function summarizeDoltRollup(
  params: DoltSummarizeParams,
): Promise<DoltSummarizeResult> {
  const template = PROMPT_TEMPLATE_MAP[params.mode];
  const sourceTurns = params.sourceTurns ?? [];
  if (template.summaryType === "leaf" && sourceTurns.length < DOLT_LEAF_MIN_SOURCE_TURNS) {
    throw new Error(
      `Leaf rollups require at least ${DOLT_LEAF_MIN_SOURCE_TURNS} source turns; received ${sourceTurns.length}.`,
    );
  }
  const finalizedAtReset = resolveFinalizedAtReset(params.mode, params.finalizedAtReset);
  const metadata: DoltSummaryMetadata = {
    summary_type: template.summaryType,
    finalized_at_reset: finalizedAtReset,
    prompt_template: template.id,
    max_output_tokens: DOLT_SUMMARY_MAX_OUTPUT_TOKENS,
  };

  const instructionText = await resolveDoltPromptTemplate(params.mode, params.promptOverrides);
  const prompt = buildDoltSummaryPrompt({
    template,
    sourceTurns,
    childPointers: params.childPointers,
    datesCovered: params.datesCovered,
    finalizedAtReset,
    instructionText,
  });
  const modelSelection = resolveDoltSummaryModelSelection(params);
  const runPrompt = params.runPrompt ?? runDoltSummaryPromptWithEmbeddedSession;
  const rawSummary = (
    await runPrompt({
      prompt,
      modelSelection,
      maxOutputTokens: DOLT_SUMMARY_MAX_OUTPUT_TOKENS,
      config: params.config,
      authProfileId: params.authProfileId,
      agentDir: params.agentDir,
      workspaceDir: params.workspaceDir,
    })
  ).trim();
  if (!rawSummary) {
    throw new Error("Dolt summarizer returned an empty response.");
  }

  const summaryWithFrontmatter = prefixSummaryFrontmatter({
    summary: rawSummary,
    summaryType: metadata.summary_type,
    datesCovered: params.datesCovered,
    childPointers: params.childPointers,
    finalizedAtReset,
  });
  return {
    summary: summaryWithFrontmatter,
    metadata,
    modelSelection,
  };
}

/**
 * Build the model prompt for a Dolt rollup.
 * Combines the resolved instruction text (from file override or built-in default)
 * with the front-matter shape and formatted source material.
 */
export function buildDoltSummaryPrompt(params: {
  template: DoltSummaryPromptTemplate;
  sourceTurns: DoltSummarySourceTurn[];
  childPointers: string[];
  datesCovered: { startEpochMs: number; endEpochMs: number };
  finalizedAtReset: boolean;
  instructionText: string;
}): string {
  const sourceBlock = params.sourceTurns
    .map((turn, index) => {
      const safetyTag = turn.safetyRelevantToolOutcome ? " safety_relevant_tool_outcome=true" : "";
      const ts = typeof turn.timestampMs === "number" ? ` ts=${turn.timestampMs}` : "";
      return `${index + 1}. pointer=${turn.pointer} role=${turn.role}${ts}${safetyTag}\n${turn.content}`;
    })
    .join("\n\n");

  const frontmatterPreview = renderSummaryFrontmatter({
    summaryType: params.template.summaryType,
    datesCovered: params.datesCovered,
    childPointers: params.childPointers,
    finalizedAtReset: params.finalizedAtReset,
  });

  return [
    params.instructionText,
    "",
    `Output must begin with this exact YAML front-matter shape (values filled for this rollup):`,
    frontmatterPreview,
    "",
    "Source material:",
    sourceBlock,
  ].join("\n");
}

function resolveFinalizedAtReset(mode: DoltRollupPromptTemplateId, explicit?: boolean): boolean {
  if (mode === "reset-short-bindle") {
    return true;
  }
  return explicit === true;
}

function renderSummaryFrontmatter(params: {
  summaryType: DoltRollupSummaryType;
  datesCovered: { startEpochMs: number; endEpochMs: number };
  childPointers: string[];
  finalizedAtReset: boolean;
}): string {
  return serializeDoltSummaryFrontmatter({
    summaryType: params.summaryType,
    datesCovered: params.datesCovered,
    children: params.childPointers,
    finalizedAtReset: params.finalizedAtReset,
  });
}

function prefixSummaryFrontmatter(params: {
  summary: string;
  summaryType: DoltRollupSummaryType;
  datesCovered: { startEpochMs: number; endEpochMs: number };
  childPointers: string[];
  finalizedAtReset: boolean;
}): string {
  return prefixDoltSummaryFrontmatter({
    summary: params.summary,
    frontmatter: {
      summaryType: params.summaryType,
      datesCovered: params.datesCovered,
      children: params.childPointers,
      finalizedAtReset: params.finalizedAtReset,
    },
  });
}

async function runDoltSummaryPromptWithEmbeddedSession(
  params: DoltSummaryPromptRunParams,
): Promise<string> {
  const agentDir = params.agentDir ?? resolveOpenClawAgentDir();
  await ensureOpenClawModelsJson(params.config, agentDir);
  const { model, error, authStorage, modelRegistry } = resolveModel(
    params.modelSelection.provider,
    params.modelSelection.modelId,
    agentDir,
    params.config,
  );
  if (!model) {
    throw new Error(
      error ?? `Unknown model: ${params.modelSelection.provider}/${params.modelSelection.modelId}`,
    );
  }

  const apiKeyInfo = await getApiKeyForModel({
    model,
    cfg: params.config,
    profileId: params.authProfileId,
    agentDir,
  });
  if (!apiKeyInfo.apiKey) {
    if (apiKeyInfo.mode !== "aws-sdk") {
      throw new Error(
        `No API key resolved for provider "${model.provider}" (auth mode: ${apiKeyInfo.mode}).`,
      );
    }
  } else if (model.provider === "github-copilot") {
    const { resolveCopilotApiToken } = await import("../../providers/github-copilot-token.js");
    const copilotToken = await resolveCopilotApiToken({ githubToken: apiKeyInfo.apiKey });
    authStorage.setRuntimeApiKey(model.provider, copilotToken.token);
  } else {
    authStorage.setRuntimeApiKey(model.provider, apiKeyInfo.apiKey);
  }

  const workspaceDir = resolveUserPath(params.workspaceDir ?? process.cwd());
  await fs.mkdir(workspaceDir, { recursive: true });
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-dolt-summary-"));
  const sessionFile = path.join(tempDir, "session.jsonl");
  try {
    await ensureSessionHeader({
      sessionFile,
      sessionId: "dolt-summarizer",
      cwd: workspaceDir,
    });
    const sessionManager = SessionManager.open(sessionFile);
    const settingsManager = SettingsManager.create(workspaceDir, agentDir);
    const { session } = await createAgentSession({
      cwd: workspaceDir,
      agentDir,
      authStorage,
      modelRegistry,
      model,
      tools: [],
      customTools: [],
      sessionManager,
      settingsManager,
    });
    try {
      applyExtraParamsToAgent(
        session.agent,
        params.config,
        params.modelSelection.provider,
        params.modelSelection.modelId,
        { maxTokens: params.maxOutputTokens },
      );
      await session.prompt(params.prompt);
      const summary = extractLastAssistantText(session.messages);
      if (!summary.trim()) {
        throw new Error("Summary model returned no assistant text.");
      }
      return summary;
    } finally {
      session.dispose();
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

function extractLastAssistantText(messages: AgentMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") {
      continue;
    }
    const directContent = (message as { content?: unknown }).content;
    if (typeof directContent === "string" && directContent.trim()) {
      return directContent;
    }
    if (Array.isArray(directContent)) {
      const text = directContent
        .map((block) => {
          if (!block || typeof block !== "object") {
            return "";
          }
          const blockText = (block as { text?: unknown }).text;
          return typeof blockText === "string" ? blockText : "";
        })
        .join("")
        .trim();
      if (text) {
        return text;
      }
    }
  }
  return "";
}
