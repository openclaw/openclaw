import { randomUUID } from "node:crypto";
import { expectDefined } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import * as cliRunner from "../agents/cli-runner.js";
import { createSteeredCliMessageInjection } from "../agents/cli-runner/execute-plugin.steered-transcript.js";
import { attachCliReplyBackend } from "../agents/cli-runner/execution-target.js";
import { captureCliRunToolAuthority } from "../agents/cli-runner/tool-authority.js";
import { runWithCliTurn } from "../agents/cli-runner/turn-admission.js";
import {
  registerTestEmbeddedRun,
  clearTestEmbeddedRun,
  createEmbeddedRunHandle,
} from "../agents/embedded-agent-runner/runs.test-support.js";
import * as embeddedAgent from "../agents/embedded-agent.js";
import {
  finalizeRequesterFinalAttachment,
  promoteRequesterFinalAttachment,
} from "../agents/subagents/requester-final-attachment.js";
import { withGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import { getReplyFromConfig } from "../auto-reply/reply/get-reply.js";
import { clearConfigCache, getRuntimeConfig } from "../config/config.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import type { SessionEntry } from "../config/sessions/types.js";
import {
  captureSessionControllerSettlement,
  getCurrentSessionControllerOwner,
} from "../sessions/session-controller.lifecycle.js";
import { createDeferredCore } from "../shared/deferred.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { controlTalkAgentRun } from "../talk/agent-run-control.js";
import { createOrResumeClientVoiceSession } from "../talk/client-voice-session.js";
import { clientVoiceSessionTesting } from "../talk/client-voice-session.test-support.js";
import { observeGatewayRunExecution } from "./agent-command.test-helpers.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "./server-methods.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./server-methods/types.js";
import { gatewayConnect, gatewayProfile } from "./server/client-fixtures.test-support.js";
import { createTalkClientAgentConsultRunner } from "./talk/client-agent-consult.js";
import { retainTalkClientRunAuthority } from "./talk/client-run-authority.js";
import { resolveTalkAgentConsultAuthority } from "./talk/client-tool-authority.js";
import { prepareTalkSessionTarget } from "./talk/session-target.js";
import {
  createGatewaySuiteHarness,
  dispatchInboundMessageMock,
  gatewayReplyMock,
  installGatewayTestHooks,
  prepareGatewayReplyRuntimeForTest,
  testState,
  writeSessionStore,
} from "./test-helpers.js";

// mock-isolation: Declare a Claude CLI backend without loading the bundled Anthropic plugin;
// runtime selection, admission and dispatch stay real, and the CLI process is never spawned.
vi.mock("../plugins/cli-backends.runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/cli-backends.runtime.js")>();
  const backend = {
    id: "claude-cli",
    modelProvider: "anthropic",
    pluginId: "anthropic",
    config: { command: "claude" },
  };
  return {
    ...actual,
    resolveRuntimeCliBackends: (mode?: "metadata") => {
      const existing = (actual.resolveRuntimeCliBackends as (mode?: "metadata") => unknown[])(mode);
      return mode === "metadata"
        ? [
            ...existing,
            { id: backend.id, modelProvider: backend.modelProvider, pluginId: "anthropic" },
          ]
        : [...existing, backend];
    },
  };
});

const MODEL_REF = "anthropic/claude-sonnet-5-5";
const runCliAgent = vi.spyOn(cliRunner, "runCliAgent");
const runEmbeddedAgent = vi.spyOn(embeddedAgent, "runEmbeddedAgent");
installGatewayTestHooks({ scope: "suite" });
const sessionKey = "agent:main:main";
const connectionId = "talk-session-runtime-ui";
let harness: Awaited<ReturnType<typeof createGatewaySuiteHarness>>;
let context: GatewayRequestContext;
let client: GatewayClient;
let storePath: string;
let sessionId: string;
let voiceSessionId: string | undefined;
let requestExecution: Awaited<ReturnType<typeof observeGatewayRunExecution>>;

const answer = (text: string, provider: string) => ({
  payloads: [{ text }],
  meta: {
    durationMs: 0,
    terminalReply: { disposition: "visible" as const, text },
    agentMeta: { sessionId, provider, model: "claude-sonnet-5-5", usage: { input: 1, output: 1 } },
  },
});

beforeAll(async () => {
  harness = await createGatewaySuiteHarness();
});
afterAll(async () => {
  await harness.close();
});

async function prepare(entry: Partial<SessionEntry>, runtime = "claude-cli") {
  requestExecution = await observeGatewayRunExecution();
  sessionId = randomUUID();
  storePath = resolveSessionStorePathCore(undefined, { agentId: "main" });
  testState.sessionStorePath = storePath;
  await writeSessionStore({
    entries: {
      main: { sessionId, updatedAt: Date.now(), status: "done", ...entry },
      ...(entry.parentSessionKey && {
        [entry.parentSessionKey]: {
          sessionId: randomUUID(),
          providerOverride: "anthropic",
          modelOverride: "claude-sonnet-5-5",
        },
      }),
    },
  });
  const previous = getRuntimeConfig();
  await prepareGatewayReplyRuntimeForTest({
    force: true,
    config: {
      ...previous,
      agents: {
        ...previous.agents,
        defaults: {
          ...previous.agents?.defaults,
          model: entry.parentSessionKey ? undefined : { primary: MODEL_REF },
          models: { [MODEL_REF]: { agentRuntime: { id: runtime } } },
        },
      },
    },
  });
  context = createDirectChatContext({ getRuntimeConfig });
  client = {
    connId: connectionId,
    connect: gatewayConnect(["operator.read", "operator.write", "operator.admin"]),
    authenticatedUserProfile: gatewayProfile(
      ensureProfileForEmail("talk-session-runtime@example.test").id,
    ),
  };
  gatewayReplyMock.mockImplementation(getReplyFromConfig);
  dispatchInboundMessageMock.mockReset();
  voiceSessionId = await createOrResumeClientVoiceSession({
    agentId: "main",
    sessionKey,
    origin: "client",
    transcriptCapable: true,
  });
}

beforeEach(() => {
  runCliAgent.mockReset();
  runEmbeddedAgent.mockReset();
});
afterEach(async () => {
  try {
    await captureSessionControllerSettlement({
      scope: storePath,
      identities: [sessionKey, sessionId],
    });
    if (voiceSessionId) {
      await rpc("talk.client.close", { sessionKey, voiceSessionId });
    }
    await requestExecution.waitForCompletion();
  } finally {
    await requestExecution.restore();
    voiceSessionId = undefined;
    clientVoiceSessionTesting.reset();
    testState.sessionStorePath = undefined;
    gatewayReplyMock.mockReset();
    clearConfigCache();
  }
});

async function rpc(method: string, params: Record<string, unknown>) {
  const respond = vi.fn<RespondFn>();
  await handleGatewayRequest({
    req: { type: "req", id: randomUUID(), method, params },
    context,
    client,
    respond,
    isWebchatConnect: () => true,
  });
  expect(respond).toHaveBeenCalledOnce();
  const [ok, result, error] = expectDefined(respond.mock.calls[0], "Gateway RPC response");
  expect({ ok, error }).toEqual({ ok: true, error: undefined });
  return expectDefined(asOptionalRecord(result), "Gateway RPC result");
}

async function createRunner(
  getVoiceSessionId: () => string | undefined,
  runAuthority?: Awaited<ReturnType<typeof retainTalkClientRunAuthority>>,
) {
  return createTalkClientAgentConsultRunner({
    runAuthority,
    config: getRuntimeConfig(),
    context,
    sessionTarget: await prepareTalkSessionTarget(getRuntimeConfig(), sessionKey),
    ownerConnId: connectionId,
    authority: resolveTalkAgentConsultAuthority(client),
    getVoiceSessionId,
    initialItems: [],
    runIdPrefix: "talk-realtime-relay-consult",
  });
}

// The server realtime relay (runId prefix talk-realtime-relay-consult) and browser direct
// consults share this runner; the browser tool-call RPC already goes through chat.send.
async function consult(
  question: string,
  adoptCompletionClaims = false,
  invalidate?: "abort" | "voice",
  expectedClaim = !invalidate,
  requesterFinal?: { append: (text: string) => boolean },
) {
  const callId = expectDefined(voiceSessionId, "voice session");
  let currentCallId: string | undefined = callId;
  const runner = await createRunner(() => currentCallId);
  try {
    if (adoptCompletionClaims) {
      runner.runPrompt.adoptCompletionClaims();
      const controller = new AbortController();
      const result = await runner.runPrompt({
        prompt: question,
        signal: controller.signal,
        requesterFinal,
      });
      if (invalidate === "abort") {
        controller.abort();
      } else if (invalidate === "voice") {
        currentCallId = randomUUID();
      }
      expect(
        runner.runPrompt.claimAppend(),
        "completed CLI consultation owns its spoken result",
      ).toBe(expectedClaim);
      expect(runner.runPrompt.claimAppend(), "completion is claimed once").toBe(false);
      return result;
    }
    return await runner.runArgs({ question });
  } finally {
    await captureSessionControllerSettlement({
      scope: storePath,
      identities: [sessionKey, sessionId],
    });
    await requestExecution.waitForCompletion();
  }
}

it("routes a child chat's voice consult through its parent's Claude CLI model without a default", async () => {
  await prepare({ parentSessionKey: "agent:main:parent" });
  runCliAgent.mockImplementation(async () => answer("CLI_ANSWER", "claude-cli"));
  runEmbeddedAgent.mockImplementation(async () => {
    throw new Error("No API key found for provider anthropic");
  });
  await expect(consult("CLI_QUESTION_771: what is on my calendar?")).resolves.toEqual({
    text: "CLI_ANSWER",
  });
  expect(runEmbeddedAgent).not.toHaveBeenCalled();
  expect(runCliAgent).toHaveBeenCalledOnce();
  const run = expectDefined(runCliAgent.mock.calls[0]?.[0], "CLI dispatch");
  expect(run).toMatchObject({
    provider: "claude-cli",
    modelProvider: "anthropic",
    model: "claude-sonnet-5-5",
    agentId: "main",
    sessionKey,
    sessionId,
    senderIsOwner: true,
    trigger: "user",
  });
  expect(run.prompt).toContain("CLI_QUESTION_771");
  expect(run.runId).toMatch(/^talk-realtime-relay-consult-/);
  // Owner consults are not narrowed to a voice-specific allowlist.
  expect(run.toolsAllow).toBeUndefined();
});

it.each([
  // Same as main for every provider: chat thinking does not change the voice consult level.
  { persisted: "low" as const, voice: undefined, expected: "high" },
  { persisted: undefined, voice: undefined, expected: "high" },
  { persisted: "low" as const, voice: "medium" as const, expected: "medium" },
])(
  "keeps main's voice thinking (Talk config, else high) through the command owner (%j)",
  async ({ persisted, voice, expected }) => {
    await prepare({ thinkingLevel: persisted });
    if (voice) {
      await prepareGatewayReplyRuntimeForTest({
        force: true,
        config: {
          ...getRuntimeConfig(),
          talk: { ...getRuntimeConfig().talk, consultThinkingLevel: voice },
        },
      });
    }
    runCliAgent.mockImplementation(async () => answer("THINKING_ANSWER", "claude-cli"));
    await expect(consult("THINKING_QUESTION")).resolves.toEqual({ text: "THINKING_ANSWER" });
    expect(runCliAgent).toHaveBeenCalledOnce();
    expect(runCliAgent.mock.calls[0]?.[0].thinkLevel).toBe(expected);
  },
);

it.each([false, true])(
  "retains completed CLI speech with correlation receipt present=%s",
  async (withReceipt) => {
    await prepare({});
    runCliAgent.mockImplementation(async ({ runId }) => {
      const result = answer("CLI_SPOKEN_ANSWER", "claude-cli");
      if (!withReceipt) {
        return result;
      }
      const requested = { provider: "anthropic", model: "claude-sonnet-5-5" };
      const terminalReceipt = {
        runId,
        sessionId,
        turnId: runId,
        requested,
        effective: { ...requested, responseModel: requested.model },
        successfulToolNames: [],
        rerouted: false,
      };
      return {
        ...result,
        meta: { ...result.meta, agentMeta: { ...result.meta.agentMeta, terminalReceipt } },
      };
    });
    await expect(consult("CLI_SPOKEN_QUESTION", true)).resolves.toEqual({
      text: "CLI_SPOKEN_ANSWER",
    });
    expect(runCliAgent).toHaveBeenCalledOnce();
    expect(runEmbeddedAgent).not.toHaveBeenCalled();
  },
);

it.each([undefined, "abort", "voice"] as const)(
  "retains yielded CLI acknowledgement and late-result ownership unless invalidated (%s)",
  async (invalidate) => {
    await prepare({});
    const append = vi.fn(() => true);
    const batch = {
      requesterAgentId: "main",
      requesterSessionKey: sessionKey,
      batchRunIds: ["yield-child"],
      rearmGeneration: 1,
    };
    runCliAgent.mockImplementation(async ({ runId }) => {
      expect(promoteRequesterFinalAttachment({ ...batch, requesterTurnRunId: runId })).toBe(true);
      const result = answer("CLI_YIELD_ACK", "claude-cli");
      return {
        ...result,
        meta: { ...result.meta, yielded: true, yieldAcknowledgment: "CLI_YIELD_ACK" },
      };
    });
    await expect(
      consult("CLI_YIELD_QUESTION", true, invalidate, !invalidate, { append }),
    ).resolves.toEqual({
      text: "CLI_YIELD_ACK",
      yielded: true,
    });
    finalizeRequesterFinalAttachment({
      ...batch,
      requesterSessionId: sessionId,
      requesterYieldBatch: true,
      pause: false,
      delivered: true,
      finalAssistantVisibleText: "CLI_LATE_RESULT",
    });
    expect(append.mock.calls).toEqual(invalidate ? [] : [["CLI_LATE_RESULT"]]);
    expect(runCliAgent).toHaveBeenCalledOnce();
    expect(runEmbeddedAgent).not.toHaveBeenCalled();
  },
);

it("retains exactly one embedded yielded acknowledgement and late result through real command dispatch", async () => {
  await prepare({}, "openclaw");
  const append = vi.fn(() => true);
  const batch = {
    requesterAgentId: "main",
    requesterSessionKey: sessionKey,
    batchRunIds: ["embedded-yield-child"],
    rearmGeneration: 1,
  };
  runEmbeddedAgent.mockImplementation(async (params) => {
    const instance = expectDefined(
      params.preparedRunAdmission?.operationalRunInstance,
      "prepared run instance",
    );
    const handle = createEmbeddedRunHandle({ runId: params.runId });
    await withGatewayToolCallerIdentity(
      {
        agentId: "main",
        sessionKey,
        operationalRunInstance: instance,
        embeddedRunToolAuthorityBinding: () => ({
          acceptsRequesterOrigin: () => false,
          source: "attempt",
          project: () => "authority",
          projectAsync: async () => "authority",
          assertRegistrationActive: () => {},
          assertActive: () => {},
        }),
      },
      () => {
        registerTestEmbeddedRun(
          sessionId,
          handle,
          sessionKey,
          undefined,
          "main",
          expectDefined(getCurrentSessionControllerOwner(), "session controller owner"),
        );
      },
    );
    try {
      expect(promoteRequesterFinalAttachment({ ...batch, requesterTurnRunId: params.runId })).toBe(
        true,
      );
      const result = answer("EMBEDDED_YIELD_ACK", "anthropic");
      return {
        ...result,
        meta: { ...result.meta, yielded: true, yieldAcknowledgment: "EMBEDDED_YIELD_ACK" },
      };
    } finally {
      clearTestEmbeddedRun(sessionId, handle, sessionKey);
    }
  });
  await expect(
    consult("EMBEDDED_YIELD_QUESTION", true, undefined, true, { append }),
  ).resolves.toEqual({ text: "EMBEDDED_YIELD_ACK", yielded: true });
  finalizeRequesterFinalAttachment({
    ...batch,
    requesterSessionId: sessionId,
    requesterYieldBatch: true,
    pause: false,
    delivered: true,
    finalAssistantVisibleText: "EMBEDDED_LATE_RESULT",
  });
  expect(append.mock.calls).toEqual([["EMBEDDED_LATE_RESULT"]]);
  expect(runEmbeddedAgent).toHaveBeenCalledOnce();
  expect(runCliAgent).not.toHaveBeenCalled();
});

it("does not claim a visible CLI snapshot after incomplete settlement", async () => {
  await prepare({});
  runCliAgent.mockImplementation(async () => {
    const result = answer("CLI_VISIBLE_SNAPSHOT", "claude-cli");
    return {
      ...result,
      meta: {
        ...result.meta,
        stopReason: "error",
        error: { kind: "incomplete_turn" as const, message: "CLI stopped" },
      },
    };
  });
  await consult("CLI_INCOMPLETE_QUESTION", true, undefined, false);
});

it.each(["abort", "voice"] as const)(
  "rejects completed CLI speech after %s invalidation",
  async (invalidate) => {
    await prepare({});
    runCliAgent.mockImplementation(async () => answer("CLI_STALE_ANSWER", "claude-cli"));
    await expect(consult("CLI_STALE_QUESTION", true, invalidate)).resolves.toEqual({
      text: "CLI_STALE_ANSWER",
    });
  },
);

it("routes a locked native Codex chat's consult to its pinned harness instead of refusing it", async () => {
  await prepare({
    modelSelectionLocked: true,
    agentHarnessId: "codex",
    modelProvider: "openai",
    model: "gpt-6.1-sol",
  });
  runEmbeddedAgent.mockImplementation(async () => answer("CODEX_ANSWER", "openai"));
  // This fixture has no Codex plugin, so the typed-turn owner fails closed on the pinned
  // harness. The point is the route: stock refuses with the model-selection lock instead.
  await expect(consult("CODEX_QUESTION_772: summarise the thread.")).rejects.toThrow(
    /Agent harness runtime "codex" is unavailable/,
  );
  expect(runCliAgent).not.toHaveBeenCalled();
});

it.each([
  { injectable: false, foreign: false },
  { injectable: true, foreign: false },
  { injectable: true, foreign: true },
])(
  "settles CLI steering without an embedded registration (%j)",
  async ({ injectable, foreign }) => {
    await prepare({});
    let nativeWrites = 0;
    let activeRunId: string | undefined;
    const started = createDeferredCore();
    const finish = createDeferredCore();
    runCliAgent.mockImplementation(async (input) =>
      runWithCliTurn(input, async (params) => {
        using policy = captureCliRunToolAuthority(params, {
          agentId: "main",
          workspaceDir: params.workspaceDir!,
          cwd: params.cwd ?? params.workspaceDir!,
        });
        const { fingerprint } = await policy.bindQuestions(
          { provider: "anthropic", model: params.model! },
          () => undefined,
        );
        const detach = attachCliReplyBackend(
          { ...params, toolAuthorityFingerprint: fingerprint },
          () => {},
          injectable
            ? {
                supportsTranscriptCommitWait: true,
                messageInjectionV2: createSteeredCliMessageInjection({
                  signal: params.abortSignal ?? new AbortController().signal,
                  context: { params, backendResolved: { id: "claude-cli" } },
                  getInjection: () => ({
                    isAvailable: () => true,
                    queueMessage: async (_text, admitInput) => {
                      await admitInput(() => {
                        nativeWrites++;
                      });
                    },
                  }),
                }),
              }
            : undefined,
        );
        activeRunId = params.runId;
        started.resolve();
        try {
          await finish.promise;
          return answer("CLI_FIRST_ANSWER", "claude-cli");
        } finally {
          detach?.();
        }
      }),
    );
    const runAuthority = await retainTalkClientRunAuthority({ client, context });
    const runner = await createRunner(() => voiceSessionId, runAuthority);
    runner.runPrompt.adoptCompletionClaims();
    const first = runner.runPrompt({ prompt: "First spoken request" });
    await started.promise;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      // A plain CLI backend cannot inject. It must reject promptly, not deadlock
      // the provider's steeringPromise and prevent delivery of the first answer.
      if (foreign) {
        // The real CLI turn is signal-owned. An unrelated caller cannot borrow
        // its public run ID, even while a guarded injectable backend is active.
        const result = await controlTalkAgentRun({
          sessionKey,
          text: "Foreign spoken request",
          mode: "steer",
          runTarget: {
            runId: expectDefined(activeRunId, "active CLI run ID"),
            signal: new AbortController().signal,
            isCurrent: () => true,
          },
        });
        expect(result.ok).toBe(false);
        expect(nativeWrites).toBe(0);
        return;
      }
      const steering = Promise.race([
        runner.runPrompt.steer!({ prompt: "Second spoken request" }),
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error("STEERING_DEADLOCK")), 2000);
        }),
      ]);
      if (injectable) {
        await expect(steering).resolves.toEqual({ text: "" });
      } else {
        await expect(steering).rejects.not.toThrow("STEERING_DEADLOCK");
      }
      expect(nativeWrites).toBe(injectable ? 1 : 0);
    } finally {
      clearTimeout(timeout);
      finish.resolve();
      await first;
      expect(runner.runPrompt.claimAppend()).toBe(true);
      runAuthority.release();
    }
  },
);
