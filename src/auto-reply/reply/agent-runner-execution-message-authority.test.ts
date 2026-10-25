import "../../agents/auth-profiles/external-auth.test-support.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createClaudeCliBackends,
  testing as cliBackendsTesting,
} from "../../agents/cli-backends.test-support.js";
import type { RunCliAgentParams } from "../../agents/cli-runner/types.js";
import type { RunEmbeddedAgentInternalParams } from "../../agents/embedded-agent-runner/run/internal-params.js";
import { resolveMessageActionTurnCapability } from "../../gateway/message-action-turn-capability.js";
import {
  createFollowupRun,
  createMinimalRunAgentTurnParams,
  fallbackAttemptOptions,
  getExecuteAgentTurnForTest,
  initialFallbackAttemptOptions,
  setupAgentRunnerExecutionTestState,
  type FallbackRunnerParams,
} from "./agent-runner-execution.test-support.js";

const { testing: externalAuthTesting } =
  await import("../../agents/auth-profiles/external-auth.test-support.js");

const state = await setupAgentRunnerExecutionTestState();
const executeChannelTurn = await getExecuteAgentTurnForTest();
const { mintReplyMessageActionTurnCapability } =
  await vi.importActual<typeof import("./agent-runner-utils.js")>("./agent-runner-utils.js");
const sessionKey = "agent:main:discord:channel:100000000000000003";
const policySessionKey = "agent:main:discord:policy:100000000000000003";
const runId = "channel-message-authority";
const currentChannelId = "100000000000000003";
const provider = "claude-cli";
const model = "claude-sonnet-4-6";

async function cliCandidate(params: FallbackRunnerParams, fallback = false) {
  return {
    result: await params.run(
      provider,
      model,
      fallback ? fallbackAttemptOptions(params, "unknown") : initialFallbackAttemptOptions(params),
    ),
    provider,
    model,
    attempts: [],
  };
}

beforeEach(() => {
  state.isCliProviderMock.mockImplementation((id) => id === provider);
  state.runWithModelFallbackMock.mockImplementation(cliCandidate);
  state.mintReplyMessageActionTurnCapabilityMock.mockImplementation(
    mintReplyMessageActionTurnCapability,
  );
  externalAuthTesting.setResolveExternalAuthProfilesForTest(() => []);
  cliBackendsTesting.setDepsForTest({
    resolveRuntimeCliBackends: createClaudeCliBackends,
    resolvePluginSetupCliBackend: () => undefined,
  });
});

afterEach(() => externalAuthTesting.resetResolveExternalAuthProfilesForTest());

function channelTurn() {
  const followupRun = createFollowupRun();
  Object.assign(followupRun.run, {
    sessionKey,
    provider,
    model,
    messageProvider: "discord",
    agentAccountId: "default",
    senderId: "100000000000000009",
  });
  followupRun.originatingChannel = "discord";
  followupRun.originatingTo = currentChannelId;
  return {
    ...createMinimalRunAgentTurnParams({
      followupRun,
      opts: { runId },
      sessionCtx: {
        Provider: "discord",
        ChatType: "channel",
        To: currentChannelId,
        AccountId: "default",
        SenderId: "100000000000000009",
        MessageSid: "100000000000000020",
      },
    }),
    sessionKey,
  };
}

function resolveCapability(token: string | undefined, key = sessionKey) {
  return resolveMessageActionTurnCapability({
    token,
    agentId: "main",
    runId,
    sessionKey: key,
    sessionId: "session",
  });
}

it.each(["failure", "policy-session", "untrusted-ingress"] as const)(
  "scopes CLI source authority to trusted turns through %s settlement",
  async (outcome) => {
    const turn = channelTurn();
    const authorityKey = outcome === "policy-session" ? policySessionKey : sessionKey;
    const trusted = outcome === "failure" || outcome === "policy-session";
    let token: string | undefined;
    state.runCliAgentMock.mockImplementationOnce(async (run: RunCliAgentParams) => {
      token = run.messageActionTurnCapability;
      if (!trusted) {
        expect(token).toBeUndefined();
      } else {
        expect(resolveCapability(token, authorityKey)).toMatchObject({
          sourceReplySessionKey: sessionKey,
          requesterAccountId: "default",
          requesterSenderId: "100000000000000009",
          toolContext: {
            currentChannelProvider: "discord",
            currentChannelId,
            currentMessageId: "100000000000000020",
          },
        });
      }
      if (outcome === "failure") {
        throw new Error("CLI execution failed");
      }
      return { payloads: [{ text: "done" }], meta: {} };
    });

    const result = await executeChannelTurn({
      ...turn,
      ...(outcome === "policy-session" ? { runtimePolicySessionKey: policySessionKey } : {}),

      sessionCtx: {
        ...turn.sessionCtx,
        Provider: outcome === "untrusted-ingress" ? "webchat" : "discord",
      },
    });

    expect(result.kind).toBe(outcome === "failure" ? "final" : "success");
    expect(state.runCliAgentMock).toHaveBeenCalledOnce();
    if (outcome === "failure") {
      await expect(state.runCliAgentMock.mock.results[0]?.value).rejects.toThrow(
        "CLI execution failed",
      );
    }
    if (trusted) {
      expect(token).toBeDefined();
    }
    expect(resolveCapability(token, authorityKey)).toBeUndefined();
  },
);

it("fences the previous candidate while preserving the admitted run for CLI fallback", async () => {
  let embeddedToken: string | undefined;
  let cliToken: string | undefined;
  let admission: RunCliAgentParams["preparedRunAdmission"];
  state.runEmbeddedAgentMock.mockImplementationOnce(async (run: RunEmbeddedAgentInternalParams) => {
    embeddedToken = run.messageActionTurnCapability;
    admission = run.preparedRunAdmission;
    expect(resolveCapability(embeddedToken)).toBeDefined();
    return { payloads: [], meta: {} };
  });
  state.runCliAgentMock.mockImplementationOnce(async (run: RunCliAgentParams) => {
    cliToken = run.messageActionTurnCapability;
    expect(resolveCapability(cliToken)).toBeDefined();
    expect(cliToken).not.toBe(embeddedToken);
    expect(resolveCapability(embeddedToken)).toBeUndefined();
    expect(run.preparedRunAdmission).toBe(admission);
    return { payloads: [{ text: "done" }], meta: {} };
  });
  state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => {
    await params.run("anthropic", "claude", initialFallbackAttemptOptions(params));
    return cliCandidate(params, true);
  });

  expect((await executeChannelTurn(channelTurn())).kind).toBe("success");
  expect(embeddedToken).toBeDefined();
  expect(cliToken).toBeDefined();
  expect(resolveCapability(embeddedToken)).toBeUndefined();
  expect(resolveCapability(cliToken)).toBeUndefined();
});
