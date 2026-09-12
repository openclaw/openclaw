import path from "node:path";
import type {
  AgentHarnessAttemptParamsV2,
  AgentMessage,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { isLiveTestEnabled } from "openclaw/plugin-sdk/test-live";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createNativeCopilotPolicyHarnessFixtureForTest,
  type CopilotSessionBindingForTest,
} from "../extensions/copilot/test-api.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../src/agents/admitted-run-context.js";
import type { EmbeddedRunAttemptParams } from "../src/agents/embedded-agent-runner/run/types.js";
import { clearAgentHarnesses, registerAgentHarness } from "../src/agents/harness/registry.js";
import { runAgentHarnessAttempt } from "../src/agents/harness/selection.js";
import { AuthStorage, ModelRegistry } from "../src/agents/sessions/index.js";
import { replaceSessionEntry } from "../src/config/sessions/session-accessor.js";
import { useAutoCleanupTempDirTracker } from "./helpers/temp-dir.js";

const gatewayFixture = vi.hoisted(() => {
  const calls: Array<{ method: string; params: unknown }> = [];
  return {
    calls,
    call: vi.fn(async (method: string, _options: unknown, params: unknown) => {
      calls.push({ method, params });
      const request = params as {
        answers?: { answers: Record<string, string[]> };
        cancel?: boolean;
        id: string;
      };
      if (method === "question.request") {
        return { id: request.id, expiresAtMs: Date.now() + 90_000 };
      }
      if (method === "question.waitAnswer") {
        return { status: "answered" as const, answers: { answers: { answer: ["Beta"] } } };
      }
      if (method === "question.resolve") {
        return request.cancel
          ? { status: "cancelled" as const }
          : { status: "answered" as const, answers: request.answers! };
      }
      throw new Error(`unexpected gateway method: ${method}`);
    }),
  };
});

vi.mock("../src/agents/harness/gateway-question-dispatch.runtime.js", () => ({
  callGatewayTool: gatewayFixture.call,
}));

const LIVE = isLiveTestEnabled(["OPENCLAW_COPILOT_POLICY_LIVE_TEST"]);
const describeLive = LIVE ? describe : describe.skip;
const harnesses: Array<ReturnType<typeof createNativeCopilotPolicyHarnessFixtureForTest>> = [];

type CopilotLiveAttemptParams = EmbeddedRunAttemptParams &
  AgentHarnessAttemptParamsV2 & {
    auth: { gitHubToken: string; profileId: string; profileVersion: string };
    authProfileId: string;
    messages: AgentMessage[];
    onAssistantDelta: (payload: { text: string }) => void | Promise<void>;
    profileVersion: string;
  };

afterEach(async () => {
  clearAgentHarnesses();
  await Promise.all(harnesses.splice(0).map((fixture) => fixture.dispose()));
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function createUserTurnRecorder(message: Extract<AgentMessage, { role: "user" }>) {
  let blocked = false;
  let persisted = false;
  return {
    message,
    resolveMessage: vi.fn(async () => message),
    markRuntimePersistencePending: vi.fn(),
    markRuntimePersisted: vi.fn(() => {
      persisted = true;
    }),
    markBlocked: vi.fn(() => {
      blocked = true;
    }),
    hasPersisted: () => persisted,
    isBlocked: () => blocked,
    hasRuntimePersistencePending: () => false,
    getAdmissionReceipt: () => undefined,
    waitForRuntimePersistence: vi.fn(async () => undefined),
    persistApproved: vi.fn(async () => undefined),
    persistBlocked: vi.fn(async () => undefined),
    persistFallback: vi.fn(async () => undefined),
  };
}

function createHostCapabilities(): AgentHarnessAttemptParamsV2["hostCapabilities"] {
  return Object.freeze({
    kind: "agent-harness-host-capability",
    version: 1,
    assertActive: () => {},
    bindToolSurface: (tools) => tools,
    runBeforeToolCall: async (request) => ({ blocked: false, params: request.params }),
    requestApproval: async () => undefined,
    waitForApproval: async () => undefined,
  });
}

async function runLiveCopilotTurn(params: {
  authStorage: AuthStorage;
  blockReplies: string[];
  modelRegistry: ModelRegistry;
  policy: Pick<EmbeddedRunAttemptParams, "disableTools" | "toolsAllow">;
  prompt: string;
  runId: string;
  sessionId: string;
  toolAuthorityFingerprint: string;
  workspaceDir: string;
}) {
  const admission = prepareAgentRunAdmission({
    cfg: {},
    facts: {
      runId: params.runId,
      agentId: "copilot-policy-live-proof",
      ingress: { kind: "system", boundary: "copilot-policy-live-proof", state: "present" },
    },
    operationalRunInstance: createOperationalRunInstanceRef(params.runId),
  });
  const admittedRunContext = await admission.admit("plugin-harness", "copilot");
  const sessionKey = `agent:copilot-policy-live-proof:${params.sessionId}`;
  const message = { role: "user" as const, content: params.prompt, timestamp: Date.now() };
  try {
    const attempt = {
      admittedRunContext,
      agentDir: params.workspaceDir,
      agentHarnessRuntimeOverride: "copilot",
      agentId: "copilot-policy-live-proof",
      auth: {
        gitHubToken: "copilot-policy-fixture-token",
        profileId: "copilot-policy-live-proof",
        profileVersion: "v1",
      },
      authProfileId: "copilot-policy-live-proof",
      authProfileStore: { version: 1, profiles: {} },
      authStorage: params.authStorage,
      config: {
        plugins: { enabled: false },
        tools: { codeMode: false, fs: { workspaceOnly: true }, toolSearch: false },
      },
      hostCapabilities: createHostCapabilities(),
      messages: [message],
      model: {
        api: "openai-responses" as const,
        baseUrl: "https://api.githubcopilot.com",
        contextWindow: 128_000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        id: "gpt-5.4-mini",
        input: ["text" as const],
        maxTokens: 4_096,
        name: "Copilot native policy live proof",
        provider: "github-copilot" as const,
        reasoning: true,
      },
      modelId: "gpt-5.4-mini",
      modelRegistry: params.modelRegistry,
      onAssistantDelta: () => {},
      onBlockReply: (payload) => {
        if (payload.text) {
          params.blockReplies.push(payload.text);
        }
      },
      profileVersion: "v1",
      prompt: message.content,
      provider: "github-copilot",
      runId: params.runId,
      sessionFile: path.join(params.workspaceDir, `${params.sessionId}.jsonl`),
      sessionId: params.sessionId,
      sessionKey,
      sessionTarget: {
        agentId: "copilot-policy-live-proof",
        sessionId: params.sessionId,
        sessionKey,
        storePath: path.join(params.workspaceDir, "openclaw-agent.sqlite"),
      },
      thinkLevel: "low" as const,
      timeoutMs: 90_000,
      toolAuthorityFingerprint: params.toolAuthorityFingerprint,
      userTurnTranscriptRecorder: createUserTurnRecorder(message),
      workspaceDir: params.workspaceDir,
      ...params.policy,
    } satisfies CopilotLiveAttemptParams;
    return await runAgentHarnessAttempt(attempt);
  } finally {
    admission.close();
  }
}

describeLive("Copilot tool policy live handoff", () => {
  it("blocks native ask_user before the Gateway when an allowed session resumes deny-all", async () => {
    gatewayFixture.calls.length = 0;
    gatewayFixture.call.mockClear();
    const workspaceDir = tempDirs.make("openclaw-copilot-policy-live-");
    const sessionId = "copilot-policy-live-session";
    const sessionKey = `agent:copilot-policy-live-proof:${sessionId}`;
    const toolAuthorityFingerprint = "copilot-policy-live-authority";
    const bindings = new Map<string, CopilotSessionBindingForTest>();
    const sessionStore = {
      delete(key: string) {
        return bindings.delete(key);
      },
      lookup(key: string) {
        return bindings.get(key);
      },
      register(key: string, value: CopilotSessionBindingForTest) {
        bindings.set(key, value);
      },
    };
    const fixture = createNativeCopilotPolicyHarnessFixtureForTest(sessionStore);
    harnesses.push(fixture);
    registerAgentHarness(fixture.harness, { ownerPluginId: "copilot" });
    await replaceSessionEntry(
      {
        agentId: "copilot-policy-live-proof",
        sessionKey,
        storePath: path.join(workspaceDir, "openclaw-agent.sqlite"),
      },
      { sessionId, updatedAt: Date.now() },
    );
    const authStorage = AuthStorage.inMemory();
    const modelRegistry = ModelRegistry.inMemory(authStorage);
    const blockReplies: string[] = [];

    const allowedTurn = runLiveCopilotTurn({
      authStorage,
      blockReplies,
      modelRegistry,
      policy: {},
      prompt:
        "Call ask_user exactly once. Ask 'Select the live proof mode' with choices Alpha and Beta and no freeform. After the answer, reply briefly. Do not use any other tool.",
      runId: "copilot-policy-live-allowed",
      sessionId,
      toolAuthorityFingerprint,
      workspaceDir,
    });
    const allowedResult = await allowedTurn;
    expect(allowedResult.terminal).toEqual({ kind: "ok" });
    expect(gatewayFixture.calls.filter((call) => call.method === "question.request")).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          questions: [expect.objectContaining({ question: "Select the live proof mode" })],
        }),
      }),
    ]);
    const allowedBinding = bindings.get(sessionId);
    expect(allowedBinding?.sdkSessionId).toBeTruthy();
    expect(
      fixture.requests.some(
        (request) => !request.restricted && request.toolNames.includes("ask_user"),
      ),
    ).toBe(true);

    const disabledCreateSessionId = "copilot-policy-live-disabled-create-session";
    const disabledCreateSessionKey = `agent:copilot-policy-live-proof:${disabledCreateSessionId}`;
    await replaceSessionEntry(
      {
        agentId: "copilot-policy-live-proof",
        sessionKey: disabledCreateSessionKey,
        storePath: path.join(workspaceDir, "openclaw-agent.sqlite"),
      },
      { sessionId: disabledCreateSessionId, updatedAt: Date.now() },
    );
    const disabledCreateRequestStart = fixture.requests.length;
    const disabledCreateResult = await runLiveCopilotTurn({
      authStorage,
      blockReplies,
      modelRegistry,
      policy: { disableTools: true },
      prompt:
        "Call ask_user exactly once and ask 'This question must be blocked'. If no such tool is available, reply exactly RESTRICTED-NO-ASK-USER.",
      runId: "copilot-policy-live-disabled-create",
      sessionId: disabledCreateSessionId,
      toolAuthorityFingerprint,
      workspaceDir,
    });
    expect(disabledCreateResult.terminal).toEqual({ kind: "ok" });
    expect(disabledCreateResult.assistantTexts.join("\n").trim()).toBe("RESTRICTED-NO-ASK-USER");
    expect(bindings.get(disabledCreateSessionId)?.sdkSessionId).toBeTruthy();
    expect(bindings.get(disabledCreateSessionId)?.sdkSessionId).not.toBe(
      allowedBinding?.sdkSessionId,
    );
    expect(
      fixture.requests
        .slice(disabledCreateRequestStart)
        .every((request) => !request.toolNames.includes("ask_user")),
    ).toBe(true);

    const restrictedResumeRequestStart = fixture.requests.length;
    const restrictedResult = await runLiveCopilotTurn({
      authStorage,
      blockReplies,
      modelRegistry,
      policy: { disableTools: true },
      prompt:
        "Call ask_user exactly once and ask 'This question must be blocked'. If no such tool is available, reply exactly RESTRICTED-NO-ASK-USER.",
      runId: "copilot-policy-live-restricted-resume",
      sessionId,
      toolAuthorityFingerprint,
      workspaceDir,
    });
    expect(restrictedResult.terminal).toEqual({ kind: "ok" });
    expect(blockReplies).toHaveLength(0);
    expect(gatewayFixture.calls.filter((call) => call.method === "question.request")).toHaveLength(
      1,
    );
    expect(bindings.get(sessionId)?.sdkSessionId).toBe(allowedBinding?.sdkSessionId);
    expect(restrictedResult.assistantTexts.join("\n").trim()).toBe("RESTRICTED-NO-ASK-USER");
    const restrictedModelRequests = fixture.requests.slice(restrictedResumeRequestStart);
    expect(restrictedModelRequests.length).toBeGreaterThan(0);
    expect(fixture.requests.every((request) => !request.streaming)).toBe(true);
    expect(
      restrictedModelRequests.every((request) => !request.toolNames.includes("ask_user")),
    ).toBe(true);

    console.info(
      "[copilot-policy-live-proof]",
      JSON.stringify({
        allowedGatewayQuestions: 1,
        allowedTerminal: allowedResult.terminal.kind,
        disabledCreateGatewayQuestions: 0,
        disabledCreateTerminal: disabledCreateResult.terminal.kind,
        nativeSessionResumed: true,
        restrictedGatewayQuestions: 0,
        restrictedReply: restrictedResult.assistantTexts.join("\n").trim(),
        restrictedTerminal: restrictedResult.terminal.kind,
      }),
    );
  }, 180_000);
});
