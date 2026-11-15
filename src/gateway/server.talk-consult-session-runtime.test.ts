import { randomUUID } from "node:crypto";
import { expectDefined } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import * as cliRunner from "../agents/cli-runner.js";
import * as embeddedAgent from "../agents/embedded-agent.js";
import { getReplyFromConfig } from "../auto-reply/reply/get-reply.js";
import { clearConfigCache, getRuntimeConfig } from "../config/config.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { captureSessionControllerSettlement } from "../sessions/session-controller.lifecycle.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { createOrResumeClientVoiceSession } from "../talk/client-voice-session.js";
import { clientVoiceSessionTesting } from "../talk/client-voice-session.test-support.js";
import { observeGatewayRunExecution } from "./agent-command.test-helpers.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "./server-methods.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./server-methods/types.js";
import { gatewayConnect, gatewayProfile } from "./server/client-fixtures.test-support.js";
import { createTalkClientAgentConsultRunner } from "./talk/client-agent-consult.js";
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

async function prepare(entry: Partial<SessionEntry>) {
  requestExecution = await observeGatewayRunExecution();
  sessionId = randomUUID();
  storePath = resolveSessionStorePathCore(undefined, { agentId: "main" });
  testState.sessionStorePath = storePath;
  await writeSessionStore({
    entries: { main: { sessionId, updatedAt: Date.now(), status: "done", ...entry } },
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
          model: { primary: MODEL_REF },
          models: { [MODEL_REF]: { agentRuntime: { id: "claude-cli" } } },
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

// The server realtime relay (runId prefix talk-realtime-relay-consult) and browser direct
// consults share this runner; the browser tool-call RPC already goes through chat.send.
async function consult(
  question: string,
  adoptCompletionClaims = false,
  invalidate?: "abort" | "voice",
) {
  const callId = expectDefined(voiceSessionId, "voice session");
  let currentCallId: string | undefined = callId;
  const runner = createTalkClientAgentConsultRunner({
    config: getRuntimeConfig(),
    context,
    sessionTarget: await prepareTalkSessionTarget(getRuntimeConfig(), sessionKey),
    ownerConnId: connectionId,
    authority: resolveTalkAgentConsultAuthority(client.connect?.scopes, client),
    getVoiceSessionId: () => currentCallId,
    initialItems: [],
    runIdPrefix: "talk-realtime-relay-consult",
  });
  try {
    if (adoptCompletionClaims) {
      runner.runPrompt.adoptCompletionClaims();
      const controller = new AbortController();
      const result = await runner.runPrompt({ prompt: question, signal: controller.signal });
      if (invalidate === "abort") {
        controller.abort();
      } else if (invalidate === "voice") {
        currentCallId = randomUUID();
      }
      expect(
        runner.runPrompt.claimAppend(),
        "completed CLI consultation owns its spoken result",
      ).toBe(!invalidate);
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

it("runs a Claude CLI chat's voice consult through the typed-turn CLI dispatch as its owner", async () => {
  await prepare({});
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

it.each([false, true])(
  "retains completed CLI speech with correlation receipt present=%s",
  async (withReceipt) => {
    await prepare({});
    runCliAgent.mockImplementation(async ({ runId }) => {
      const result = answer("CLI_SPOKEN_ANSWER", "claude-cli");
      return {
        ...result,
        meta: {
          ...result.meta,
          agentMeta: {
            ...result.meta.agentMeta,
            ...(withReceipt
              ? {
                  terminalReceipt: {
                    runId,
                    sessionId,
                    turnId: runId,
                    requested: { provider: "anthropic", model: "claude-sonnet-5-5" },
                    effective: {
                      provider: "anthropic",
                      model: "claude-sonnet-5-5",
                      responseModel: "claude-sonnet-5-5",
                    },
                    successfulToolNames: [],
                    rerouted: false,
                  },
                }
              : {}),
          },
        },
      };
    });
    await expect(consult("CLI_SPOKEN_QUESTION", true)).resolves.toEqual({
      text: "CLI_SPOKEN_ANSWER",
    });
    expect(runCliAgent).toHaveBeenCalledOnce();
    expect(runEmbeddedAgent).not.toHaveBeenCalled();
  },
);

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
