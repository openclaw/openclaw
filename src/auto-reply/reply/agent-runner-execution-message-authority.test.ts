import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { testing as externalAuthTesting } from "../../agents/auth-profiles/external-auth.test-support.js";
import * as cli from "../../agents/cli-backends.test-support.js";
import type { RunCliAgentParams } from "../../agents/cli-runner/types.js";
import type { RunEmbeddedAgentInternalParams } from "../../agents/embedded-agent-runner/run/internal-params.js";
import { resolveMessageActionTurnCapability } from "../../gateway/message-action-turn-capability.js";
import * as exec from "./agent-runner-execution.test-support.js";

const state = await exec.setupAgentRunnerExecutionTestState();
const executeChannelTurn = await exec.getExecuteAgentTurnForTest();
const { mintReplyMessageActionTurnCapability } =
  await vi.importActual<typeof import("./agent-runner-utils.js")>("./agent-runner-utils.js");
const sessionKey = "agent:main:discord:channel:100000000000000003";
const policySessionKey = "agent:main:discord:policy:100000000000000003";
const runId = "channel-message-authority";
const currentChannelId = "100000000000000003";
const provider = "claude-cli";
const model = "claude-sonnet-4-6";

function cliCandidate(params: exec.FallbackRunnerParams, fallback = false) {
  return exec.runFallbackCandidate(
    params,
    provider,
    model,
    fallback
      ? exec.fallbackAttemptOptions(params, "unknown")
      : exec.initialFallbackAttemptOptions(params),
  );
}

beforeEach(() => {
  state.isCliProviderMock.mockImplementation((id) => id === provider);
  state.runWithModelFallbackMock.mockImplementation(cliCandidate);
  state.mintReplyMessageActionTurnCapabilityMock.mockImplementation(
    mintReplyMessageActionTurnCapability,
  );
  externalAuthTesting.setResolveExternalAuthProfilesForTest(() => []);
  cli.testing.setDepsForTest({
    resolveRuntimeCliBackends: cli.createClaudeCliBackends,
    resolvePluginSetupCliBackend: () => undefined,
  });
});

afterEach(() => externalAuthTesting.resetResolveExternalAuthProfilesForTest());

function channelTurn() {
  const followupRun = exec.createFollowupRun({
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
    ...exec.createMinimalRunAgentTurnParams({
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

it.each(["failure", "policy-session", "untrusted-ingress", "fallback"] as const)(
  "scopes CLI source authority to trusted turns through %s settlement",
  async (outcome) => {
    const turn = channelTurn();
    const authorityKey = outcome === "policy-session" ? policySessionKey : sessionKey;
    const trusted = outcome !== "untrusted-ingress";
    let embeddedToken: string | undefined;
    let admission: RunCliAgentParams["preparedRunAdmission"];
    let token: string | undefined;
    if (outcome === "fallback") {
      state.runEmbeddedAgentMock.mockImplementationOnce(
        async (run: RunEmbeddedAgentInternalParams) => {
          embeddedToken = run.messageActionTurnCapability;
          admission = run.preparedRunAdmission;
          expect(resolveCapability(embeddedToken)).toBeDefined();
          return { payloads: [], meta: {} };
        },
      );
      state.runWithModelFallbackMock.mockImplementationOnce(
        async (params: exec.FallbackRunnerParams) => {
          await params.run("anthropic", "claude", exec.initialFallbackAttemptOptions(params));
          return cliCandidate(params, true);
        },
      );
    }
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
      if (outcome === "fallback") {
        expect(token).not.toBe(embeddedToken);
        expect(resolveCapability(embeddedToken)).toBeUndefined();
        expect(run.preparedRunAdmission).toBe(admission);
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
    expect(resolveCapability(token, authorityKey)).toBeUndefined();
    expect(resolveCapability(embeddedToken)).toBeUndefined();
  },
);
