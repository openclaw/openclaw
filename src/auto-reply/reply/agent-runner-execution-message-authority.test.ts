import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { testing as externalAuthTesting } from "../../agents/auth-profiles/external-auth.test-support.js";
import { testing as cliBackendsTesting } from "../../agents/cli-backends.test-support.js";
import type { RunCliAgentParams } from "../../agents/cli-runner/types.js";
import type { RunEmbeddedAgentInternalParams } from "../../agents/embedded-agent-runner/run/internal-params.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../../agents/tools/gateway-caller-context.js";
import {
  clearRuntimeConfigSnapshot,
  getRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import * as sessionEntryRuntime from "../../config/sessions/session-entry-read-runtime.js";
import { resolveMessageActionTurnCapability } from "../../gateway/message-action-turn-capability.js";
import { useBundledProviderPolicyArtifactsForTest } from "../../plugin-sdk/test-helpers/provider-policy-artifacts.test-support.js";
import {
  createFollowupRun,
  createMinimalRunAgentTurnParams,
  createScheduledAutomation,
  expectMockCallArgFields,
  fallbackAttemptOptions,
  getExecuteAgentTurnForTest,
  initialFallbackAttemptOptions,
  setupAgentRunnerExecutionTestState,
  type FallbackRunnerParams,
} from "./agent-runner-execution.test-support.js";
import type { SessionEventTarget } from "./session-event-contract.js";
import { captureSessionEventTargetForHost } from "./session-event-target.js";

const state = await setupAgentRunnerExecutionTestState();
const { mintReplyMessageActionTurnCapability } =
  await vi.importActual<typeof import("./agent-runner-utils.js")>("./agent-runner-utils.js");
const sessionKey = "agent:main:discord:channel:100000000000000003";
const policySessionKey = "agent:main:discord:policy:100000000000000003";
const runId = "channel-message-authority";
const currentChannelId = "100000000000000003";

beforeEach(() => {
  state.mintReplyMessageActionTurnCapabilityMock.mockImplementation(
    mintReplyMessageActionTurnCapability,
  );
});

function channelTurn() {
  const followupRun = createFollowupRun();
  Object.assign(followupRun.run, {
    sessionKey,
    provider: "claude-cli",
    model: "claude-sonnet-4-6",
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

describe("channel reply message authority", () => {
  beforeEach(() => {
    state.isCliProviderMock.mockImplementation((provider) => provider === "claude-cli");
    state.runWithModelFallbackMock.mockImplementation(async (params: FallbackRunnerParams) => ({
      result: await params.run(
        "claude-cli",
        "claude-sonnet-4-6",
        initialFallbackAttemptOptions(params),
      ),
      provider: "claude-cli",
      model: "claude-sonnet-4-6",
      attempts: [],
    }));
    externalAuthTesting.setResolveExternalAuthProfilesForTest(() => []);
    cliBackendsTesting.setDepsForTest({
      resolveRuntimeCliBackends: () => [
        {
          id: "claude-cli",
          modelProvider: "anthropic",
          pluginId: "anthropic",
          config: { command: "claude" },
        },
      ],
      resolvePluginSetupCliBackend: () => undefined,
    });
  });

  afterEach(() => externalAuthTesting.resetResolveExternalAuthProfilesForTest());

  it.each(["failure", "policy-session"] as const)(
    "retains the CLI source authority until %s settlement",
    async (outcome) => {
      const turn = channelTurn();
      const authorityKey = outcome === "policy-session" ? policySessionKey : sessionKey;
      let token: string | undefined;
      state.runCliAgentMock.mockImplementationOnce(async (run: RunCliAgentParams) => {
        token = run.messageActionTurnCapability;
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
        if (outcome === "failure") {
          throw new Error("CLI execution failed");
        }
        return { payloads: [{ text: "done" }], meta: {} };
      });

      const execute = await getExecuteAgentTurnForTest();
      const result = await execute({
        ...turn,
        ...(outcome === "policy-session" ? { runtimePolicySessionKey: policySessionKey } : {}),
      });

      expect(result.kind).toBe(outcome === "failure" ? "final" : "success");
      expect(token).toBeDefined();
      expect(resolveCapability(token, authorityKey)).toBeUndefined();
    },
  );

  it("fences the previous candidate while preserving the admitted run for CLI fallback", async () => {
    let embeddedToken: string | undefined;
    let cliToken: string | undefined;
    let admission: RunCliAgentParams["preparedRunAdmission"];
    state.runEmbeddedAgentMock.mockImplementationOnce(
      async (run: RunEmbeddedAgentInternalParams) => {
        embeddedToken = run.messageActionTurnCapability;
        admission = run.preparedRunAdmission;
        expect(resolveCapability(embeddedToken)).toBeDefined();
        return { payloads: [], meta: {} };
      },
    );
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
      return {
        result: await params.run(
          "claude-cli",
          "claude-sonnet-4-6",
          fallbackAttemptOptions(params, "unknown"),
        ),
        provider: "claude-cli",
        model: "claude-sonnet-4-6",
        attempts: [],
      };
    });

    const execute = await getExecuteAgentTurnForTest();
    expect((await execute(channelTurn())).kind).toBe("success");
    expect(embeddedToken).toBeDefined();
    expect(cliToken).toBeDefined();
    expect(resolveCapability(embeddedToken)).toBeUndefined();
    expect(resolveCapability(cliToken)).toBeUndefined();
  });

  it.each(["event", "untrusted-ingress"] as const)(
    "does not mint channel authority for %s routing metadata",
    async (mode) => {
      const turn = channelTurn();
      if (mode === "event") {
        turn.followupRun.run.internalEventExecution = { onStarted: vi.fn(), onTerminal: vi.fn() };
        turn.followupRun.run.senderId = undefined;
      }
      let observedCapability: string | undefined;
      state.runCliAgentMock.mockImplementationOnce(async (run: RunCliAgentParams) => {
        observedCapability = run.messageActionTurnCapability;
        return { payloads: [{ text: "done" }], meta: {} };
      });
      const execute = await getExecuteAgentTurnForTest();
      await execute({
        ...turn,
        opts: { ...turn.opts, internalEventExecution: turn.followupRun.run.internalEventExecution },
        sessionCtx: {
          ...turn.sessionCtx,
          Provider: mode === "untrusted-ingress" ? "webchat" : "discord",
          ...(mode === "event"
            ? {
                InternalTurnSource: "event" as const,
                InputProvenance: { kind: "internal_system" as const, sourceTool: "exec" },
                MessageSid: "event-occurrence",
                SenderId: undefined,
              }
            : {}),
        },
      });
      expect(state.runCliAgentMock).toHaveBeenCalledOnce();
      expect(observedCapability).toBeUndefined();
    },
  );
});

describe("background completion delivery authority", () => {
  useBundledProviderPolicyArtifactsForTest(["openai", "anthropic"]);

  it.each([
    { source: "scheduled", deliver: false },
    { source: "nested event", deliver: false },
    { source: "ordinary", deliver: undefined },
  ] as const)("preserves completion delivery custody for $source embedded runs", async (row) => {
    const registry = await import("../../infra/agent-run-registry.js");
    const actualRegistry = await vi.importActual<typeof registry>(
      "../../infra/agent-run-registry.js",
    );
    const readEntry = vi.spyOn(sessionEntryRuntime, "withSessionEntryReadOnlyInWorker");
    readEntry.mockImplementation(async (_scope, assertCurrent, consume) => {
      assertCurrent();
      return await consume({ ok: true, value: undefined }, { kind: "unresolved", assertCurrent });
    });
    const previousConfig = getRuntimeConfigSnapshot();
    setRuntimeConfigSnapshot({ agents: { entries: { main: {} } } });
    const completionRunId = `completion-delivery-${row.source.replaceAll(" ", "-")}`;
    const params = createMinimalRunAgentTurnParams({ opts: { runId: completionRunId } });
    if (row.source !== "ordinary") {
      params.followupRun.run.internalEventExecution = {
        deliver: row.deliver,
        onStarted: vi.fn(),
        onTerminal: vi.fn(),
      };
    }
    if (row.source === "scheduled") {
      params.followupRun.run.scheduledAutomation = createScheduledAutomation();
      params.followupRun.run.scheduledAutomation.job.delivery = { mode: "none" };
    }
    let target: SessionEventTarget | undefined;
    state.runEmbeddedAgentMock.mockImplementationOnce(
      async (run: RunEmbeddedAgentInternalParams) => {
        assert(run.preparedRunAdmission && run.agentId && run.sessionKey);
        const admitted = await run.preparedRunAdmission.admit("gateway", run.runId);
        const caller = createAdmittedGatewayToolCallerIdentity({
          admittedRunContext: admitted,
          agentId: run.agentId,
          sessionKey: run.sessionKey,
        });
        assert(caller);
        target = await withGatewayToolCallerIdentity(caller, () =>
          captureSessionEventTargetForHost(caller.agentId, caller.sessionKey),
        );
        return { payloads: [{ text: "NO_REPLY" }], meta: {} };
      },
    );
    try {
      const executeAgentTurn = await getExecuteAgentTurnForTest();
      await vi
        .mocked(registry.registerAgentRunContext)
        .withImplementation(actualRegistry.registerAgentRunContext, () => executeAgentTurn(params));
      expect(state.runEmbeddedAgentMock).toHaveBeenCalledOnce();
      expect(state.runCliAgentMock).not.toHaveBeenCalled();
      expect(target).toMatchObject({ deliver: row.deliver });
      if (row.source === "scheduled") {
        expectMockCallArgFields(state.runEmbeddedAgentMock, 0, "scheduled embedded run params", {
          trigger: "cron",
          requireExplicitMessageTarget: true,
        });
      }
    } finally {
      actualRegistry.clearAgentRunContext(completionRunId);
      readEntry.mockRestore();
      if (previousConfig) {
        setRuntimeConfigSnapshot(previousConfig);
      } else {
        clearRuntimeConfigSnapshot();
      }
    }
  });
});
