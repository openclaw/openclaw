// OpenClaw assistant planning converts fuzzy user text into one safe command.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { prepareSystemAgentRunAdmission } from "../agents/admitted-run-context.js";
import { extractAgentRunTerminalError, extractAgentRunText } from "../agents/agent-run-result.js";
import {
  PreparedModelRuntimeOwnerNotPublishedError,
  PreparedModelRuntimePublicationSupersededError,
} from "../agents/prepared-model-runtime.errors.js";
import {
  AGENT_RUN_SUPERSEDED_STOP_REASON,
  isAgentRunSupersededAbortReason,
} from "../agents/run-termination.js";
import { SessionManager } from "../agents/sessions/session-manager.js";
import { CommandLane } from "../process/lanes.js";
import {
  SYSTEM_AGENT_ASSISTANT_SYSTEM_PROMPT,
  SYSTEM_AGENT_GREETING_SYSTEM_PROMPT,
  buildSystemAgentAssistantUserPrompt,
  buildSystemAgentGreetingUserPrompt,
  parseSystemAgentAssistantPlanText,
  type SystemAgentAssistantPlan,
  type SystemAgentAssistantTurn,
} from "./assistant-prompts.js";
import { resolveSystemAgentAssistantTimeoutMs } from "./assistant-timeout.js";
import type { SystemAgentGreetingFacts, SystemAgentGreetingPlan } from "./greeting.js";
import { SystemAgentInferenceUnavailableError } from "./inference-error.js";
import type { SystemAgentOverview } from "./overview.js";
import {
  resolveSystemAgentExpectedAgentHarnessRuntimeArtifact,
  resolveSystemAgentVerifiedInferenceRoute,
  type SystemAgentVerifiedInferenceBinding,
  type SystemAgentVerifiedInferenceDeps,
} from "./verified-inference.js";

export {
  buildSystemAgentAssistantUserPrompt,
  parseSystemAgentAssistantPlanText,
  type SystemAgentAssistantPlan,
  type SystemAgentAssistantTurn,
} from "./assistant-prompts.js";

export type SystemAgentAssistantPlanner = (params: {
  input: string;
  overview: SystemAgentOverview;
  history?: SystemAgentAssistantTurn[];
  pendingOperation?: string;
  readonly verifiedInference: SystemAgentVerifiedInferenceBinding;
}) => Promise<SystemAgentAssistantPlan | null>;

const SYSTEM_AGENT_PLANNER_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    reply: { type: "string" },
    command: { type: "string" },
  },
  required: ["reply"],
  additionalProperties: false,
} as const;

/** Plan only through the configured default agent's verified route. */
export async function planSystemAgentCommand(params: {
  input: string;
  overview: SystemAgentOverview;
  history?: SystemAgentAssistantTurn[];
  pendingOperation?: string;
  readonly verifiedInference: SystemAgentVerifiedInferenceBinding;
  deps?: SystemAgentVerifiedInferenceDeps;
}): Promise<SystemAgentAssistantPlan | null> {
  const input = params.input.trim();
  if (!input) {
    return null;
  }
  const prompt = buildSystemAgentAssistantUserPrompt({
    input,
    overview: params.overview,
    ...(params.history ? { history: params.history } : {}),
    ...(params.pendingOperation ? { pendingOperation: params.pendingOperation } : {}),
  });
  const result = await runConfiguredSystemAgentText({
    prompt,
    systemPrompt: SYSTEM_AGENT_ASSISTANT_SYSTEM_PROMPT,
    runIdPrefix: "openclaw-planner",
    verifiedInference: params.verifiedInference,
    deps: params.deps,
    responseFormat: SYSTEM_AGENT_PLANNER_RESPONSE_SCHEMA,
  });
  const parsed = parseSystemAgentAssistantPlanText(result?.text);
  return parsed && result ? { ...parsed, modelLabel: result.modelLabel } : null;
}

/** One tool-free, verified inference turn for the cached caretaker greeting. */
export async function planSystemAgentGreetingWithConfiguredModel(params: {
  overview: SystemAgentOverview;
  facts: SystemAgentGreetingFacts;
  readonly verifiedInference: SystemAgentVerifiedInferenceBinding;
  deps?: SystemAgentVerifiedInferenceDeps;
  timeoutMs: number;
}): Promise<SystemAgentGreetingPlan | null> {
  const result = await runConfiguredSystemAgentText({
    prompt: buildSystemAgentGreetingUserPrompt(params),
    systemPrompt: SYSTEM_AGENT_GREETING_SYSTEM_PROMPT,
    runIdPrefix: "openclaw-greeting",
    verifiedInference: params.verifiedInference,
    deps: params.deps,
    timeoutMs: params.timeoutMs,
  });
  return result ? { text: result.text, modelRef: result.modelLabel } : null;
}

async function runConfiguredSystemAgentText(params: {
  prompt: string;
  systemPrompt: string;
  runIdPrefix: string;
  readonly verifiedInference: SystemAgentVerifiedInferenceBinding;
  deps?: SystemAgentVerifiedInferenceDeps;
  timeoutMs?: number;
  responseFormat?: Record<string, unknown>;
}): Promise<{ text: string; modelLabel: string } | null> {
  const route = await requireVerifiedPlannerRoute(params.verifiedInference, params.deps);
  let expectedAgentHarnessRuntimeArtifact: ReturnType<
    typeof resolveSystemAgentExpectedAgentHarnessRuntimeArtifact
  >;
  try {
    expectedAgentHarnessRuntimeArtifact = resolveSystemAgentExpectedAgentHarnessRuntimeArtifact(
      params.verifiedInference,
    );
  } catch (error) {
    throw new SystemAgentInferenceUnavailableError("planner", [error]);
  }
  // Provider transport options can select a different runtime. Plugin-owned
  // inference keeps its verified runtime and uses the JSON prompt/parser contract.
  const responseFormat = expectedAgentHarnessRuntimeArtifact ? undefined : params.responseFormat;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-planner-"));
  let text: string | undefined;
  let preparedRunAdmission: ReturnType<typeof prepareSystemAgentRunAdmission> | undefined;
  try {
    const runId = `${params.runIdPrefix}-${randomUUID()}`;
    const timeoutMs = params.timeoutMs ?? resolveSystemAgentAssistantTimeoutMs(route);
    preparedRunAdmission = prepareSystemAgentRunAdmission(
      route.runConfig,
      runId,
      route.agentId,
      "system-agent.assistant",
    );
    const shared = {
      sessionId: `${runId}-session`,
      // OpenClaw is the planner surface, but the configured roster owner supplies runtime policy.
      agentId: route.agentId,
      trigger: "manual" as const,
      sessionFile: `in-memory:${runId}`,
      sessionManager: SessionManager.inMemory(tempDir),
      workspaceDir: tempDir,
      cwd: tempDir,
      agentDir: route.agentDir,
      config: route.runConfig,
      prompt: params.prompt,
      provider: route.provider,
      model: route.model,
      timeoutMs,
      thinkLevel: "off" as const,
      runId,
      extraSystemPrompt: params.systemPrompt,
      extraSystemPromptStatic: params.systemPrompt,
      messageChannel: "openclaw",
      messageProvider: "openclaw",
      disableTools: true,
      disableTrajectory: true,
      ...(responseFormat ? { streamParams: { responseFormat } } : {}),
      ...(route.authProfileId ? { authProfileId: route.authProfileId } : {}),
    };
    const result =
      route.runner === "cli"
        ? await (
            await import("../agents/cli-runner.js")
          ).runCliAgent({
            ...shared,
            preparedRunAdmission,
            executionMode: "side-question",
            cleanupCliLiveSessionOnRunEnd: true,
          })
        : await (
            await import("../agents/embedded-agent.js")
          ).runEmbeddedAgent({
            ...shared,
            lane: CommandLane.SystemAgentInference,
            preparedRunAdmission,
            toolsAllow: [],
            agentHarnessRuntimeOverride: route.agentHarnessRuntimeOverride,
            ...(expectedAgentHarnessRuntimeArtifact ? { expectedAgentHarnessRuntimeArtifact } : {}),
            cleanupBundleMcpOnRunEnd: true,
            ...(route.authProfileId ? { authProfileIdSource: "user" as const } : {}),
          });
    const terminalError = extractAgentRunTerminalError(result);
    if (terminalError) {
      throw new SystemAgentInferenceUnavailableError(
        "planner",
        [new Error(terminalError)],
        result.meta?.stopReason === "timeout" || result.meta?.timeoutPhase
          ? "timeout"
          : result.meta?.stopReason === AGENT_RUN_SUPERSEDED_STOP_REASON
            ? "superseded"
            : "retry",
      );
    }
    text = extractAgentRunText(result);
  } catch (error) {
    if (error instanceof SystemAgentInferenceUnavailableError) {
      throw error;
    }
    if (
      isAgentRunSupersededAbortReason(error) ||
      error instanceof PreparedModelRuntimePublicationSupersededError
    ) {
      throw new SystemAgentInferenceUnavailableError("planner", [error], "superseded");
    }
    if (error instanceof PreparedModelRuntimeOwnerNotPublishedError) {
      throw new SystemAgentInferenceUnavailableError("planner", [error], "runtime-unavailable");
    }
    text = undefined;
  } finally {
    preparedRunAdmission?.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
  if (!text) {
    return null;
  }
  // Cleanup is the final suspension before callers can display model text, so
  // authority must still match after cleanup completes.
  await requireVerifiedPlannerRoute(params.verifiedInference, params.deps);
  return { text, modelLabel: route.modelLabel };
}

async function requireVerifiedPlannerRoute(
  binding: SystemAgentVerifiedInferenceBinding | undefined,
  deps: SystemAgentVerifiedInferenceDeps | undefined,
) {
  if (!binding) {
    throw new SystemAgentInferenceUnavailableError("planner", [], "setup");
  }
  try {
    const route = await resolveSystemAgentVerifiedInferenceRoute(binding, deps);
    if (route) {
      return route;
    }
  } catch (error) {
    throw new SystemAgentInferenceUnavailableError("planner", [error], "route-changed");
  }
  throw new SystemAgentInferenceUnavailableError("planner", [], "route-changed");
}
