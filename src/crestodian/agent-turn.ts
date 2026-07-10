// Crestodian agent turns run the real embedded agent loop with the ring-zero tool.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveCliBackendConfig, type ResolvedCliBackend } from "../agents/cli-backends.js";
import { normalizeCliModel } from "../agents/cli-runner/helpers.js";
import { resolveStateDir } from "../config/paths.js";
import type { CliSessionBinding } from "../config/sessions.js";
import { buildAgentMainSessionKey } from "../routing/session-key.js";
import { CRESTODIAN_AGENT_SYSTEM_PROMPT } from "./assistant-prompts.js";
import { CrestodianInferenceUnavailableError } from "./inference-error.js";
import {
  resolveCrestodianConfiguredRoute,
  type CrestodianConfiguredRoute,
} from "./inference-route.js";
import type { CrestodianOverview } from "./overview.js";

/**
 * Crestodian is a real agent: same loop, session transcript, and tool pipeline
 * as regular agents — restricted to the single ring-zero `crestodian` tool.
 * Embedded runtimes enforce that restriction with toolsAllow; CLI harnesses
 * (claude-cli, gemini-cli) cannot, so they get the tool over a dedicated stdio
 * MCP server that replaces the normal bundle MCP surface for the run. Turns
 * share one persistent session so the conversation has genuine multi-turn
 * memory. Inference setup must succeed before this runner is entered.
 */
export const CRESTODIAN_AGENT_ID = "crestodian";

const AGENT_TURN_TIMEOUT_MS = 120_000;

export type CrestodianAgentTurnDirective =
  import("../agents/tools/crestodian-tool.js").CrestodianToolDirective;

export type CrestodianAgentTurnReply = {
  text: string;
  modelLabel?: string;
  /** Interactive handoff the tool requested; the host chat executes it. */
  directive?: CrestodianAgentTurnDirective;
};

export type CrestodianAgentTurnRunner = (params: {
  input: string;
  overview: CrestodianOverview;
  surface: "cli" | "gateway";
  /** Host-verified: the user's current message is an explicit approval. */
  approvalArmed: boolean;
  session: CrestodianAgentSession;
}) => Promise<CrestodianAgentTurnReply | null>;

export type CrestodianAgentSession = {
  sessionId: string;
  /** Host-owned pending-proposal fingerprint; see crestodian-tool.ts. */
  proposalRef: { current?: string };
  /** Native CLI continuity, bound to the exact configured model/auth owner route. */
  cliSession?: {
    routeKey: string;
    binding: CliSessionBinding;
  };
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
      cliSessionBinding?: CliSessionBinding;
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
  delete session.cliSession;
  await fs.rm(sessionFile, { force: true });
}

type CrestodianAgentTurnParams = Parameters<CrestodianAgentTurnRunner>[0];

function clearCrestodianCliSession(session: CrestodianAgentSession): void {
  delete session.cliSession;
}

function clearFailedCrestodianSessionState(session: CrestodianAgentSession): void {
  session.proposalRef.current = undefined;
  clearCrestodianCliSession(session);
}

function throwCrestodianInferenceUnavailable(params: {
  session: CrestodianAgentSession;
  failures?: unknown[];
}): never {
  clearFailedCrestodianSessionState(params.session);
  throw new CrestodianInferenceUnavailableError("agent-turn", params.failures);
}

function cliRouteKey(route: CrestodianConfiguredRoute, backend: ResolvedCliBackend | null): string {
  return JSON.stringify({
    provider: route.provider,
    backendId: backend?.id ?? route.provider,
    model: backend ? normalizeCliModel(route.model, backend.config) : route.model,
    authProfileId: route.authProfileId ?? "",
    agentDir: path.resolve(route.agentDir),
    // Native resume arguments and the backend command are not represented in
    // CliSessionBinding. Bind them here so config changes cannot revive a
    // transcript owned by a different executable or resume protocol.
    backend: backend
      ? {
          config: backend.config,
          bundleMcp: backend.bundleMcp,
          bundleMcpMode: backend.bundleMcpMode,
          authEpochMode: backend.authEpochMode,
          nativeToolMode: backend.nativeToolMode,
          sideQuestionToolMode: backend.sideQuestionToolMode,
        }
      : null,
  });
}

function resolveCrestodianCliBackend(route: CrestodianConfiguredRoute): ResolvedCliBackend | null {
  // The helper owns the executable/session identity even though its model and
  // auth come from the configured default agent. Crestodian also forces a
  // process per turn so each approval gets fresh MCP authority; fingerprint
  // that effective execution identity rather than the configured live mode.
  const backend = resolveCliBackendConfig(route.provider, route.runConfig, {
    agentId: CRESTODIAN_AGENT_ID,
  });
  if (!backend) {
    return null;
  }
  const { liveSession: _liveSession, ...config } = backend.config;
  return { ...backend, config };
}

/**
 * CLI harnesses run the crestodian tool in a stdio MCP subprocess, so the
 * in-process proposalRef/directiveRef cannot be shared with the host. Mirror
 * the tool's transitions from the harness tool events instead: a denial
 * registers the exact-operation hash, a mismatch voids it, an executed
 * mutation consumes it, and directive actions replay the interactive handoff —
 * same lifecycle as crestodian-tool.ts enforces.
 */
async function mirrorCrestodianToolStateFromEvents(params: {
  runId: string;
  proposalRef: { current?: string };
  directiveRef: { current?: CrestodianAgentTurnDirective };
}): Promise<() => void> {
  const [
    { onAgentEvent },
    { extractToolResultText },
    { resolveCrestodianProposalTransition, resolveCrestodianDirectiveTransition },
  ] = await Promise.all([
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
    const resultText = extractToolResultText(evt.data.result) ?? "";
    const transition = resolveCrestodianProposalTransition({ args, resultText });
    if (transition) {
      params.proposalRef.current = transition.proposal;
    }
    const directive = resolveCrestodianDirectiveTransition({ args, resultText });
    if (directive) {
      params.directiveRef.current = directive;
    }
  });
}

/**
 * Run one Crestodian turn through the embedded agent loop. Route, runner, and
 * output failures are typed so callers may try another inference path without
 * mistaking the failure for deterministic setup authority.
 */
export async function runCrestodianAgentTurnWithDeps(
  params: CrestodianAgentTurnParams,
  deps: CrestodianAgentTurnDeps = {},
): Promise<CrestodianAgentTurnReply | null> {
  let plan: CrestodianConfiguredRoute | null;
  try {
    plan = await resolveCrestodianConfiguredRoute({
      ...(deps.readConfigFileSnapshot
        ? { readConfigFileSnapshot: deps.readConfigFileSnapshot }
        : {}),
    });
  } catch (error) {
    throwCrestodianInferenceUnavailable({
      session: params.session,
      failures: [error],
    });
  }
  if (!plan) {
    throwCrestodianInferenceUnavailable({ session: params.session });
  }
  let workspaceDir: string;
  let sessionFile: string;
  try {
    ({ workspaceDir, sessionFile } = await ensureCrestodianDirs(params.session.sessionId));
  } catch (error) {
    throwCrestodianInferenceUnavailable({
      session: params.session,
      failures: [error],
    });
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
  // Directives are per-turn: the tool records at most one interactive handoff
  // and the engine executes it after the reply.
  const directiveRef: { current?: CrestodianAgentTurnDirective } = {};
  const crestodianTool = {
    surface: params.surface,
    approvalArmed: params.approvalArmed,
    proposalRef: params.session.proposalRef,
    directiveRef,
  };
  try {
    let result: EmbeddedRunResult;
    if (plan.runner === "cli") {
      const backend = resolveCrestodianCliBackend(plan);
      const routeKey = cliRouteKey(plan, backend);
      const previousBinding =
        params.session.cliSession?.routeKey === routeKey
          ? params.session.cliSession.binding
          : undefined;
      if (!previousBinding) {
        clearCrestodianCliSession(params.session);
      }
      const runCli = deps.runCliAgent ?? (await import("../agents/cli-runner.js")).runCliAgent;
      const stopToolStateMirror = await mirrorCrestodianToolStateFromEvents({
        runId,
        proposalRef: params.session.proposalRef,
        directiveRef,
      });
      try {
        result = (await runCli({
          ...shared,
          provider: plan.provider,
          model: plan.model,
          agentDir: plan.agentDir,
          ...(plan.authProfileId ? { authProfileId: plan.authProfileId } : {}),
          extraSystemPrompt: CRESTODIAN_AGENT_SYSTEM_PROMPT,
          extraSystemPromptStatic: CRESTODIAN_AGENT_SYSTEM_PROMPT,
          crestodianTool,
          ...(previousBinding ? { cliSessionBinding: previousBinding } : {}),
          disableCliLiveSession: true,
          cleanupCliLiveSessionOnRunEnd: true,
        })) as EmbeddedRunResult;
      } finally {
        stopToolStateMirror();
      }
      // Thread the harness's own session forward so the next turn resumes the
      // native CLI transcript instead of reseeding from scratch.
      const agentMeta = result.meta?.agentMeta;
      if (agentMeta?.clearCliSessionBinding || !agentMeta?.cliSessionBinding?.sessionId) {
        clearCrestodianCliSession(params.session);
      } else if (agentMeta?.cliSessionBinding?.sessionId) {
        params.session.cliSession = {
          routeKey,
          binding: agentMeta.cliSessionBinding,
        };
      }
    } else {
      // An intervening embedded turn cannot be represented in the CLI's native
      // transcript. A later CLI route must reseed instead of reviving stale context.
      clearCrestodianCliSession(params.session);
      const runEmbedded =
        deps.runEmbeddedAgent ?? (await import("../agents/embedded-agent.js")).runEmbeddedAgent;
      result = (await runEmbedded({
        ...shared,
        extraSystemPrompt: CRESTODIAN_AGENT_SYSTEM_PROMPT,
        toolsAllow: ["crestodian"],
        crestodianTool,
        disableMessageTool: true,
        provider: plan.provider,
        model: plan.model,
        agentDir: plan.agentDir,
        agentHarnessRuntimeOverride: plan.agentHarnessRuntimeOverride,
        ...(plan.authProfileId
          ? { authProfileId: plan.authProfileId, authProfileIdSource: "user" as const }
          : {}),
      })) as EmbeddedRunResult;
    }
    const text = extractRunText(result)?.trim();
    if (!text) {
      throw new CrestodianInferenceUnavailableError("agent-turn");
    }
    return {
      text,
      modelLabel: plan.modelLabel,
      ...(directiveRef.current ? { directive: directiveRef.current } : {}),
    };
  } catch (error) {
    // A failed run may have registered a proposal or returned a CLI session id
    // before rejecting. Neither is safe to arm or resume on a later attempt.
    const failures =
      error instanceof CrestodianInferenceUnavailableError ? [...error.failures] : [error];
    throwCrestodianInferenceUnavailable({ session: params.session, failures });
  }
}

export const runCrestodianAgentTurn: CrestodianAgentTurnRunner = (params) =>
  runCrestodianAgentTurnWithDeps(params);
