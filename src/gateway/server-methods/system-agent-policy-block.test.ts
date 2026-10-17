import "./system-agent.mocks.test-support.js";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { runEmbeddedAttemptBeforeAgentRun } from "../../agents/embedded-agent-runner/run/attempt-before-agent-run.js";
import { buildEmbeddedRunBlockedResult } from "../../agents/embedded-agent-runner/run/blocked-run-result.js";
import type { AgentMessage } from "../../agents/runtime/index.js";
import { guardSessionManager } from "../../agents/session-tool-result-guard-wrapper.js";
import type { PluginHookBeforeAgentRunEvent } from "../../plugins/hook-types.js";
import { createHookRunner } from "../../plugins/hooks.js";
import {
  runSystemAgentTurnWithDeps,
  type SystemAgentTurnDeps,
} from "../../system-agent/agent-turn.test-support.js";
import { SystemAgentChatEngine } from "../../system-agent/chat-engine.js";
import {
  createSystemAgentPluginMetadataTestSnapshot,
  createSystemAgentVerifiedInferenceTestFixture,
} from "../../system-agent/system-agent.test-helpers.js";
import type { SystemAgentChatSession } from "./system-agent.js";
import {
  callChat,
  makeContext,
  transcriptStoreMocks,
  useSystemAgentGatewayTestFixture,
  verifiedConfig,
} from "./system-agent.test-support.js";

const { requireVerifiedInferenceDeps, systemAgentTempDirs, seededSession } =
  useSystemAgentGatewayTestFixture();

it("retains a policy-blocked conversation and safely runs its next allowed turn", async () => {
  vi.stubEnv("OPENCLAW_STATE_DIR", systemAgentTempDirs.make("system-agent-policy-block-"));
  const metadata = createSystemAgentPluginMetadataTestSnapshot(verifiedConfig);
  const proof = await metadata.run(
    () => createSystemAgentVerifiedInferenceTestFixture(verifiedConfig),
    verifiedConfig,
  );
  const privateInput = "synthetic private policy input";
  const internalReason = "synthetic internal policy reason";
  const safeReplacement = "Please send an allowed request.";
  type EmbeddedParams = Parameters<NonNullable<SystemAgentTurnDeps["runEmbeddedAgent"]>>[0];
  const admittedTurns: EmbeddedParams[] = [];
  const allowedModel = vi.fn(async () => ({
    meta: { durationMs: 0, finalAssistantVisibleText: "Allowed follow-up complete." },
  }));
  const hookRunner = createHookRunner({
    hooks: [],
    plugins: [],
    typedHooks: [
      {
        pluginId: "synthetic-policy",
        hookName: "before_agent_run",
        source: "test",
        handler: async (event: PluginHookBeforeAgentRunEvent) =>
          event.prompt === privateInput
            ? { outcome: "block" as const, reason: internalReason, message: safeReplacement }
            : { outcome: "pass" as const },
      },
    ],
  });
  const runEmbeddedAgent: NonNullable<SystemAgentTurnDeps["runEmbeddedAgent"]> = async (params) => {
    admittedTurns.push(params);
    await expectDefined(params.preparedRunAdmission, "prepared turn admission").admit("embedded");
    const runId = expectDefined(params.runId, "admitted turn run ID");
    const sessionManager = guardSessionManager(
      expectDefined(params.sessionManager, "turn manager"),
    );
    const state: { messages: AgentMessage[] } = {
      messages: sessionManager.buildSessionContext().messages,
    };
    const outcome = await runEmbeddedAttemptBeforeAgentRun({
      attempt: { runId, agentAccountId: undefined, senderId: undefined, senderIsOwner: true },
      activeSession: {
        get messages() {
          return state.messages;
        },
        agent: { state },
      },
      hookContext: {
        runId: params.runId,
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
      },
      hookMessages: state.messages,
      hookRunner,
      modelPrompt: params.prompt,
      sessionManager,
      systemPrompt: params.extraSystemPrompt ?? "",
      withOwnedTranscriptWrite: async (operation) => await operation(),
    });
    if (!outcome) {
      return allowedModel();
    }
    return buildEmbeddedRunBlockedResult({
      text: outcome.promptError.message,
      errorKind: "hook_block",
      errorMessage: outcome.promptError.message,
      durationMs: 0,
      agentMeta: {
        sessionId: params.sessionId,
        provider: params.provider ?? "openai",
        model: params.model ?? "fixture",
      },
      replayInvalid: false,
    });
  };
  const deps = {
    ...proof.deps,
    readConfigFileSnapshot: requireVerifiedInferenceDeps().readConfigFileSnapshot,
  };
  const engine = new SystemAgentChatEngine({
    verifiedInference: proof.binding,
    surface: "gateway",
    deps,
    runAgentTurn: (params) =>
      metadata.run(() => runSystemAgentTurnWithDeps(params, { ...deps, runEmbeddedAgent })),
  });
  const dispose = vi.spyOn(engine, "dispose");
  const sessions = new Map<string, SystemAgentChatSession>([
    ["policy-session", seededSession({ engine })],
  ]);
  const context = makeContext(sessions);
  try {
    const blocked = await callChat(context, { sessionId: "policy-session", message: privateInput });
    expect(admittedTurns).toHaveLength(1);
    expect(blocked).toEqual({
      ok: true,
      payload: {
        sessionId: "policy-session",
        reply: expect.stringContaining(safeReplacement),
        action: "none",
      },
      error: undefined,
    });
    expect(sessions.get("policy-session")?.engine).toBe(engine);
    expect(dispose).not.toHaveBeenCalled();
    expect(allowedModel).not.toHaveBeenCalled();
    const allowed = await callChat(context, {
      sessionId: "policy-session",
      message: "Allowed follow-up",
    });
    expect(allowed).toMatchObject({ ok: true });
    expect(allowedModel).toHaveBeenCalledOnce();
    expect(admittedTurns).toHaveLength(2);
    expect(admittedTurns[1]?.sessionId).toBe(admittedTurns[0]?.sessionId);
    expect(admittedTurns[1]?.sessionKey).toBe(admittedTurns[0]?.sessionKey);
    expect(admittedTurns[1]?.sessionManager).toBe(admittedTurns[0]?.sessionManager);
    expect(transcriptStoreMocks.appendTurn).toHaveBeenCalled();
    const recorded = JSON.stringify({
      history: engine.historySince(0),
      transcript: transcriptStoreMocks.appendTurn.mock.calls,
      session: admittedTurns[0]?.sessionManager?.buildSessionContext().messages,
    });
    expect(recorded).toContain(safeReplacement);
    expect(recorded).not.toContain(privateInput);
    expect(recorded).not.toContain(internalReason);
  } finally {
    await engine.dispose();
  }
});
