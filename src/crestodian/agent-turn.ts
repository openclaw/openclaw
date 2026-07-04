// Crestodian agent turns run the real embedded agent loop with the ring-zero tool.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { buildAgentMainSessionKey } from "../routing/session-key.js";
import { selectCrestodianLocalPlannerBackends } from "./assistant-backends.js";
import { CRESTODIAN_AGENT_SYSTEM_PROMPT } from "./assistant-prompts.js";
import type { CrestodianOverview } from "./overview.js";

/**
 * Crestodian is a real agent: same embedded loop, session transcript, and tool
 * pipeline as regular agents — restricted to the single ring-zero `crestodian`
 * tool. Turns share one persistent session so the conversation has genuine
 * multi-turn memory. When no loop-capable backend exists (fresh machine with
 * only a CLI harness that cannot enforce a restricted toolset), the caller
 * falls back to the single-turn planner.
 */
export const CRESTODIAN_AGENT_ID = "crestodian";

const AGENT_TURN_TIMEOUT_MS = 120_000;

export type CrestodianAgentTurnRunner = (params: {
  input: string;
  overview: CrestodianOverview;
  surface: "cli" | "gateway";
  /** Host-verified: the user's current message is an explicit approval. */
  approvalArmed: boolean;
  session: CrestodianAgentSession;
}) => Promise<{ text: string; modelLabel?: string } | null>;

export type CrestodianAgentSession = {
  sessionId: string;
  /** Host-owned pending-proposal fingerprint; see crestodian-tool.ts. */
  proposalRef: { current?: string };
};

export function createCrestodianAgentSession(): CrestodianAgentSession {
  return { sessionId: `crestodian-${randomUUID()}`, proposalRef: {} };
}

type EmbeddedRunResult = {
  payloads?: Array<{ text?: string }>;
  meta?: {
    finalAssistantVisibleText?: string;
    finalAssistantRawText?: string;
  };
};

function extractRunText(result: EmbeddedRunResult): string | undefined {
  return (
    result.meta?.finalAssistantVisibleText ??
    result.meta?.finalAssistantRawText ??
    result.payloads
      ?.map((payload) => payload.text?.trim())
      .filter(Boolean)
      .join("\n")
  );
}

async function ensureCrestodianDirs(): Promise<{ workspaceDir: string; sessionFile: string }> {
  const base = path.join(resolveStateDir(), "crestodian");
  const workspaceDir = path.join(base, "workspace");
  await fs.mkdir(workspaceDir, { recursive: true });
  await fs.mkdir(path.join(base, "sessions"), { recursive: true });
  return { workspaceDir, sessionFile: path.join(base, "sessions", "agent.jsonl") };
}

/**
 * Run one Crestodian turn through the embedded agent loop. Returns null when
 * no loop-capable backend is available or the run fails, so the caller can
 * degrade to the planner.
 */
export const runCrestodianAgentTurn: CrestodianAgentTurnRunner = async (params) => {
  const { overview } = params;
  const configuredModel = overview.defaultModel;
  // CLI-harness models (e.g. claude-cli/*) cannot enforce a restricted
  // toolset; runEmbeddedAgent rejects toolsAllow for them, and we fall back.
  const embeddedFallback = configuredModel
    ? null
    : (selectCrestodianLocalPlannerBackends(overview).find(
        (backend) => backend.runner === "embedded",
      ) ?? null);
  if (!configuredModel && !embeddedFallback) {
    return null;
  }

  const { workspaceDir, sessionFile } = await ensureCrestodianDirs();
  const { runEmbeddedAgent } = await import("../agents/embedded-agent.js");
  const { readConfigFileSnapshot } = await import("../config/config.js");

  let runConfig: import("../config/types.openclaw.js").OpenClawConfig;
  let provider: string | undefined;
  let model: string | undefined;
  let agentHarnessId: string | undefined;
  let modelLabel: string;
  if (configuredModel) {
    const snapshot = await readConfigFileSnapshot();
    runConfig = snapshot.runtimeConfig ?? snapshot.config ?? {};
    modelLabel = configuredModel;
  } else {
    runConfig = embeddedFallback!.buildConfig(workspaceDir);
    provider = embeddedFallback!.provider;
    model = embeddedFallback!.model;
    agentHarnessId = "codex";
    modelLabel = embeddedFallback!.label;
  }

  try {
    const result = (await runEmbeddedAgent({
      sessionId: params.session.sessionId,
      sessionKey: buildAgentMainSessionKey({ agentId: CRESTODIAN_AGENT_ID }),
      agentId: CRESTODIAN_AGENT_ID,
      trigger: "manual",
      sessionFile,
      workspaceDir,
      config: runConfig,
      prompt: params.input,
      extraSystemPrompt: CRESTODIAN_AGENT_SYSTEM_PROMPT,
      toolsAllow: ["crestodian"],
      crestodianTool: {
        surface: params.surface,
        approvalArmed: params.approvalArmed,
        proposalRef: params.session.proposalRef,
      },
      disableMessageTool: true,
      timeoutMs: AGENT_TURN_TIMEOUT_MS,
      runId: `crestodian-turn-${randomUUID()}`,
      messageChannel: "crestodian",
      messageProvider: "crestodian",
      ...(provider ? { provider } : {}),
      ...(model ? { model } : {}),
      ...(agentHarnessId ? { agentHarnessId, cleanupBundleMcpOnRunEnd: true } : {}),
    })) as EmbeddedRunResult;
    const text = extractRunText(result)?.trim();
    if (!text) {
      return null;
    }
    return { text, modelLabel };
  } catch {
    // Loop unavailable for this backend (CLI harness, auth failure, timeout):
    // the conversation must keep working, so degrade to the planner path.
    return null;
  }
};
