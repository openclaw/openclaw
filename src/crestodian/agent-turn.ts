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
 * Crestodian is a real agent: same loop, session transcript, and tool pipeline
 * as regular agents — restricted to the single ring-zero `crestodian` tool.
 * Embedded runtimes enforce that restriction with toolsAllow; CLI harnesses
 * (claude-cli, gemini-cli) cannot, so they get the tool over a dedicated stdio
 * MCP server that replaces the normal bundle MCP surface for the run. Turns
 * share one persistent session so the conversation has genuine multi-turn
 * memory. When no loop-capable backend exists, the caller falls back to the
 * single-turn planner.
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
  /** Native CLI session id captured after CLI-harness turns for --resume reuse. */
  cliSessionId?: string;
};

export function createCrestodianAgentSession(): CrestodianAgentSession {
  return { sessionId: `crestodian-${randomUUID()}`, proposalRef: {} };
}

export type CrestodianAgentTurnDeps = {
  runEmbeddedAgent?: typeof import("../agents/embedded-agent.js").runEmbeddedAgent;
  runCliAgent?: typeof import("../agents/cli-runner.js").runCliAgent;
  readConfigFileSnapshot?: typeof import("../config/config.js").readConfigFileSnapshot;
};

type EmbeddedRunResult = {
  payloads?: Array<{ text?: string }>;
  meta?: {
    finalAssistantVisibleText?: string;
    finalAssistantRawText?: string;
    agentMeta?: {
      cliSessionBinding?: { sessionId?: string };
      clearCliSessionBinding?: boolean;
    };
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

async function ensureCrestodianDirs(
  sessionId: string,
): Promise<{ workspaceDir: string; sessionFile: string }> {
  const base = path.join(resolveStateDir(), "crestodian");
  const workspaceDir = path.join(base, "workspace");
  await fs.mkdir(workspaceDir, { recursive: true });
  await fs.mkdir(path.join(base, "sessions"), { recursive: true });
  return { workspaceDir, sessionFile: path.join(base, "sessions", `${sessionId}.jsonl`) };
}

export async function cleanupCrestodianAgentSession(
  session: CrestodianAgentSession,
): Promise<void> {
  const sessionFile = path.join(
    resolveStateDir(),
    "crestodian",
    "sessions",
    `${session.sessionId}.jsonl`,
  );
  await fs.rm(sessionFile, { force: true });
}

type CrestodianAgentTurnParams = Parameters<CrestodianAgentTurnRunner>[0];

type RunConfig = import("../config/types.openclaw.js").OpenClawConfig;

type CrestodianAgentTurnPlan =
  | { runner: "cli"; runConfig: RunConfig; modelLabel: string; provider: string; model: string }
  | {
      runner: "embedded";
      runConfig: RunConfig;
      modelLabel: string;
      provider?: string;
      model?: string;
      agentHarnessId?: string;
    };

async function planCrestodianAgentTurn(
  params: CrestodianAgentTurnParams,
  deps: CrestodianAgentTurnDeps,
  workspaceDir: string,
): Promise<CrestodianAgentTurnPlan | null> {
  const configuredModel = params.overview.defaultModel;
  if (configuredModel) {
    const readSnapshot =
      deps.readConfigFileSnapshot ?? (await import("../config/config.js")).readConfigFileSnapshot;
    const snapshot = await readSnapshot();
    const runConfig = snapshot.runtimeConfig ?? snapshot.config ?? {};
    const { isCliProvider, resolveDefaultModelForAgent } =
      await import("../agents/model-selection.js");
    const ref = resolveDefaultModelForAgent({ cfg: runConfig, agentId: CRESTODIAN_AGENT_ID });
    if (isCliProvider(ref.provider, runConfig)) {
      return {
        runner: "cli",
        runConfig,
        modelLabel: configuredModel,
        provider: ref.provider,
        model: ref.model,
      };
    }
    return { runner: "embedded", runConfig, modelLabel: configuredModel };
  }
  // No configured model: fall back to the first locally detected runtime, in
  // the same order setup would pick one (Claude Code CLI before Codex).
  const backend = selectCrestodianLocalPlannerBackends(params.overview)[0];
  if (!backend) {
    return null;
  }
  const base = {
    runConfig: backend.buildConfig(workspaceDir),
    modelLabel: backend.label,
    provider: backend.provider,
    model: backend.model,
  };
  return backend.runner === "cli"
    ? { runner: "cli", ...base }
    : { runner: "embedded", agentHarnessId: "codex", ...base };
}

/**
 * CLI harnesses run the crestodian tool in a stdio MCP subprocess, so the
 * in-process proposalRef cannot be shared with the host. Mirror the tool's
 * proposal transitions from the harness tool events instead: a denial
 * registers the exact-operation hash, a mismatch voids it, and an executed
 * mutation consumes it — same lifecycle as crestodian-tool.ts enforces.
 */
async function mirrorCrestodianProposalFromToolEvents(params: {
  runId: string;
  proposalRef: { current?: string };
}): Promise<() => void> {
  const [{ onAgentEvent }, { extractToolResultText }, { resolveCrestodianProposalTransition }] =
    await Promise.all([
      import("../infra/agent-events.js"),
      import("../agents/embedded-agent-subscribe.tools.js"),
      import("../agents/tools/crestodian-tool.js"),
    ]);
  return onAgentEvent((evt) => {
    if (evt.runId !== params.runId || evt.stream !== "tool" || evt.data.phase !== "result") {
      return;
    }
    const name = typeof evt.data.name === "string" ? evt.data.name : "";
    // CLI harnesses report MCP tools with transport prefixes (mcp__openclaw__crestodian).
    if (name !== "crestodian" && !name.endsWith("__crestodian")) {
      return;
    }
    const args =
      typeof evt.data.args === "object" && evt.data.args !== null
        ? (evt.data.args as Record<string, unknown>)
        : {};
    const transition = resolveCrestodianProposalTransition({
      args,
      resultText: extractToolResultText(evt.data.result) ?? "",
    });
    if (transition) {
      params.proposalRef.current = transition.proposal;
    }
  });
}

/**
 * Run one Crestodian turn through the embedded agent loop. Returns null when
 * no loop-capable backend is available or the run fails, so the caller can
 * degrade to the planner.
 */
export async function runCrestodianAgentTurnWithDeps(
  params: CrestodianAgentTurnParams,
  deps: CrestodianAgentTurnDeps = {},
): Promise<{ text: string; modelLabel?: string } | null> {
  const { workspaceDir, sessionFile } = await ensureCrestodianDirs(params.session.sessionId);
  const plan = await planCrestodianAgentTurn(params, deps, workspaceDir);
  if (!plan) {
    return null;
  }

  const runId = `crestodian-turn-${randomUUID()}`;
  const shared = {
    sessionId: params.session.sessionId,
    sessionKey: buildAgentMainSessionKey({ agentId: CRESTODIAN_AGENT_ID }),
    agentId: CRESTODIAN_AGENT_ID,
    trigger: "manual" as const,
    sessionFile,
    workspaceDir,
    config: plan.runConfig,
    prompt: params.input,
    timeoutMs: AGENT_TURN_TIMEOUT_MS,
    runId,
    messageChannel: "crestodian",
    messageProvider: "crestodian",
  };
  const crestodianTool = {
    surface: params.surface,
    approvalArmed: params.approvalArmed,
    proposalRef: params.session.proposalRef,
  };

  try {
    let result: EmbeddedRunResult;
    if (plan.runner === "cli") {
      const runCli = deps.runCliAgent ?? (await import("../agents/cli-runner.js")).runCliAgent;
      const stopProposalMirror = await mirrorCrestodianProposalFromToolEvents({
        runId,
        proposalRef: params.session.proposalRef,
      });
      try {
        result = (await runCli({
          ...shared,
          provider: plan.provider,
          model: plan.model,
          extraSystemPrompt: CRESTODIAN_AGENT_SYSTEM_PROMPT,
          extraSystemPromptStatic: CRESTODIAN_AGENT_SYSTEM_PROMPT,
          crestodianTool,
          ...(params.session.cliSessionId ? { cliSessionId: params.session.cliSessionId } : {}),
          cleanupCliLiveSessionOnRunEnd: true,
        })) as EmbeddedRunResult;
      } finally {
        stopProposalMirror();
      }
      // Thread the harness's own session forward so the next turn resumes the
      // native CLI transcript instead of reseeding from scratch.
      const agentMeta = result.meta?.agentMeta;
      if (agentMeta?.clearCliSessionBinding) {
        delete params.session.cliSessionId;
      } else if (agentMeta?.cliSessionBinding?.sessionId) {
        params.session.cliSessionId = agentMeta.cliSessionBinding.sessionId;
      }
    } else {
      const runEmbedded =
        deps.runEmbeddedAgent ?? (await import("../agents/embedded-agent.js")).runEmbeddedAgent;
      result = (await runEmbedded({
        ...shared,
        extraSystemPrompt: CRESTODIAN_AGENT_SYSTEM_PROMPT,
        toolsAllow: ["crestodian"],
        crestodianTool,
        disableMessageTool: true,
        ...(plan.provider ? { provider: plan.provider } : {}),
        ...(plan.model ? { model: plan.model } : {}),
        ...(plan.agentHarnessId
          ? { agentHarnessId: plan.agentHarnessId, cleanupBundleMcpOnRunEnd: true }
          : {}),
      })) as EmbeddedRunResult;
    }
    const text = extractRunText(result)?.trim();
    if (!text) {
      return null;
    }
    return { text, modelLabel: plan.modelLabel };
  } catch {
    // Loop unavailable for this backend (missing CLI, auth failure, timeout):
    // the conversation must keep working, so degrade to the planner path.
    return null;
  }
}

export const runCrestodianAgentTurn: CrestodianAgentTurnRunner = (params) =>
  runCrestodianAgentTurnWithDeps(params);
