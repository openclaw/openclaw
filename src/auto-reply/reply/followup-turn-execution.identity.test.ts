import assert from "node:assert/strict";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
  resolveAdmittedRunActiveAssertion,
} from "../../agents/admitted-run-context.js";
import { buildEmbeddedAttemptToolRunContext } from "../../agents/embedded-agent-runner/run/attempt-tool-run-context.js";
import { resolveOpenClawPluginToolsForOptions } from "../../agents/openclaw-plugin-tools.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { bindPluginRuntimeArtifactSelection } from "../../plugins/plugin-runtime-artifact-binding.js";
import { resolvePluginRuntimeArtifactSelection } from "../../plugins/plugin-runtime-artifact-selection.js";
import { createTestPluginRegistry } from "../../plugins/registry-runtime.test-helpers.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import { setPluginRuntimeLoadContext } from "../../plugins/runtime/load-context.js";
import { createPluginRecord } from "../../plugins/status.test-helpers.js";
import type { OpenClawPluginToolContext } from "../../plugins/tool-types.js";
import type { AgentTurnParams } from "./agent-runner-execution.types.js";
import { buildEmbeddedRunExecutionParams } from "./agent-runner-utils.js";
import {
  createFollowupTurnTestTurn,
  executeFollowupTurnForTest,
  getFollowupTurnTestState,
  resetFollowupTurnTestState,
} from "./followup-turn-execution.test-support.js";
import { createMockTypingController } from "./test-helpers.js";

const state = getFollowupTurnTestState();

const identityProbeConfig = {
  plugins: { enabled: true, entries: { "identity-probe": { enabled: true } } },
} satisfies OpenClawConfig;

beforeEach(resetFollowupTurnTestState);

function createInvocationAuthority(runId: string) {
  const admission = prepareAgentRunAdmission({
    cfg: {},
    facts: {
      runId,
      agentId: "agent",
      ingress: { kind: "channel", boundary: "telegram", state: "present" },
    },
    operationalRunInstance: createOperationalRunInstanceRef(runId),
  });
  return {
    admit: async () => {
      const admitted = await admission.admit("embedded");
      const assertCurrent = resolveAdmittedRunActiveAssertion(admitted);
      assert(assertCurrent, "expected admitted run authority");
      return assertCurrent;
    },
    close: admission.close,
  };
}

function registerIdentityProbe(params: {
  expectedChatId: string;
  expectedRequesterId: string;
  beforeEffect?: () => Promise<void>;
  effect: () => void;
}) {
  const builder = createTestPluginRegistry();
  const artifact = {
    source: "/tmp/identity-probe/index.js",
    rootDir: "/tmp/identity-probe",
    origin: "bundled" as const,
  };
  const record = createPluginRecord({
    id: "identity-probe",
    ...artifact,
    contracts: { tools: ["identity_probe"] },
  });
  bindPluginRuntimeArtifactSelection(record, {
    ...artifact,
    preferBuiltPluginArtifacts: false,
    runtimeEntry: resolvePluginRuntimeArtifactSelection({
      ...artifact,
      entryKind: "runtime",
      preferBuiltPluginArtifacts: false,
    }),
  });
  builder.registry.plugins.push(record);
  const metadataSnapshot = createPluginMetadataSnapshotFixture({
    plugins: [{ id: record.id, ...artifact, contracts: record.contracts }],
  });
  setPluginRuntimeLoadContext(builder.registry, {
    rawConfig: identityProbeConfig,
    config: identityProbeConfig,
    activationSourceConfig: identityProbeConfig,
    autoEnabledReasons: {},
    workspaceDir: undefined,
    env: process.env,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    manifestRegistry: metadataSnapshot.manifestRegistry,
    metadataSnapshot,
  });
  const api = builder.createApi(record, {
    config: identityProbeConfig,
    registrationMode: "full",
  });
  api.registerTool(
    {
      contextVersion: 2,
      create: (context: OpenClawPluginToolContext<2>) => ({
        name: "identity_probe",
        label: "Identity probe",
        description: "Records a synthetic effect for an authorized queued turn",
        parameters: { type: "object", properties: {} },
        async execute() {
          await params.beforeEffect?.();
          context.assertInvocationCurrent();
          if (
            context.nativeChannelId !== params.expectedChatId ||
            context.requesterSenderId !== params.expectedRequesterId
          ) {
            throw new Error("queued identity mismatch");
          }
          params.effect();
          return { content: [{ type: "text" as const, text: "published" }], details: {} };
        },
      }),
    },
    { name: "identity_probe", workspaceAccess: "execute" },
  );
  return builder.registry;
}

async function invokeQueuedV2Tool(params: {
  turnParams: AgentTurnParams;
  assertInvocationCurrent: () => void;
  registry: ReturnType<typeof createTestPluginRegistry>["registry"];
}) {
  const run = params.turnParams.followupRun.run;
  const runId = params.turnParams.opts?.runId;
  assert(runId, "expected queued execution run id");
  const execution = await buildEmbeddedRunExecutionParams({
    run,
    replyRoute: params.turnParams.followupRun,
    sessionCtx: params.turnParams.sessionCtx,
    hasRepliedRef: undefined,
    provider: run.provider,
    model: run.model,
    runId,
  });
  const toolContext = buildEmbeddedAttemptToolRunContext({
    ...execution,
    model: { provider: run.provider, id: run.model },
  });
  const tools = withPluginRuntimeRegistryScope(params.registry, () =>
    resolveOpenClawPluginToolsForOptions({
      options: {
        config: execution.config,
        workspaceDir: execution.workspaceDir,
        agentSessionKey: execution.sessionKey,
        runSessionKey: execution.sessionKey,
        sessionId: execution.sessionId,
        runId: execution.runId,
        agentChannel: execution.messageProvider,
        agentAccountId: execution.agentAccountId,
        agentTo: execution.messageTo,
        currentChannelId: toolContext.currentChannelId,
        currentMessagingTarget: toolContext.currentMessagingTarget,
        agentThreadId: execution.messageThreadId,
        nativeChannelId: toolContext.nativeChannelId,
        requesterSenderId: execution.senderId,
        assertInvocationCurrent: params.assertInvocationCurrent,
      },
    }),
  );
  const tool = tools.find((candidate) => candidate.name === "identity_probe");
  assert(tool, "expected V2 identity probe tool");
  return await tool.execute("identity-probe", {});
}

async function executeIdentityTurn(params: {
  chatId: string;
  chatType: "direct" | "group";
  requesterId?: string;
  run: (turnParams: AgentTurnParams) => Promise<void>;
}) {
  const turn = createFollowupTurnTestTurn();
  turn.queued.originatingChannel = "telegram";
  turn.queued.originatingTo = params.chatType === "direct" ? "user:42" : "group:ops";
  turn.queued.originatingChatId = params.chatId;
  turn.queued.originatingChatType = params.chatType;
  turn.config = identityProbeConfig;
  turn.queued.run.config = identityProbeConfig;
  turn.queued.run.messageProvider = "telegram";
  turn.queued.run.senderId = params.requesterId ?? "requester-42";
  let runError: Error | undefined;
  state.execute.mockImplementationOnce(async (turnParams: AgentTurnParams) => {
    try {
      await params.run(turnParams);
      const runId = turnParams.opts?.runId;
      assert(runId, "expected queued execution run id");
      return {
        runId,
        outcome: { kind: "rejected", payload: { text: "done" } },
      };
    } catch (error) {
      runError =
        error instanceof Error
          ? error
          : new Error("queued identity test execution failed", { cause: error });
      throw runError;
    }
  });
  const result = await executeFollowupTurnForTest({
    turn,
    defaults: {
      typing: createMockTypingController(),
      typingMode: "never",
      defaultModel: "claude",
    },
    onToolResult: async () => {},
    onCompactionNoticePayload: async () => {},
  });
  if (runError) {
    throw runError;
  }
  return result;
}

describe("queued follow-up V2 plugin identity", () => {
  it.each([
    ["direct", "424242"],
    ["group", "-1001234567890"],
  ] as const)(
    "delivers the authenticated %s chat identity to a V2 tool",
    async (chatType, chatId) => {
      const effect = vi.fn();
      const authority = createInvocationAuthority(`allowed-${chatType}`);
      const assertInvocationCurrent = await authority.admit();
      const registry = registerIdentityProbe({
        expectedChatId: chatId,
        expectedRequesterId: "requester-42",
        effect,
      });
      try {
        await executeIdentityTurn({
          chatId,
          chatType,
          run: async (turnParams) => {
            await expect(
              invokeQueuedV2Tool({ turnParams, assertInvocationCurrent, registry }),
            ).resolves.toMatchObject({ details: {} });
          },
        });
        expect(effect).toHaveBeenCalledOnce();
      } finally {
        authority.close();
      }
    },
  );

  it("rejects a mismatched requester and chat before the plugin effect", async () => {
    const effect = vi.fn();
    const authority = createInvocationAuthority("mismatched-identity");
    const assertInvocationCurrent = await authority.admit();
    const registry = registerIdentityProbe({
      expectedChatId: "424242",
      expectedRequesterId: "requester-42",
      effect,
    });
    try {
      await executeIdentityTurn({
        chatId: "999999",
        chatType: "direct",
        requesterId: "other-requester",
        run: async (turnParams) => {
          await expect(
            invokeQueuedV2Tool({ turnParams, assertInvocationCurrent, registry }),
          ).rejects.toThrow("queued identity mismatch");
        },
      });
      expect(effect).not.toHaveBeenCalled();
    } finally {
      authority.close();
    }
  });

  it("rejects a retained invocation after run authority is revoked", async () => {
    const entered = createDeferred();
    const release = createDeferred();
    const effect = vi.fn();
    const authority = createInvocationAuthority("revoked-authority");
    const assertInvocationCurrent = await authority.admit();
    const registry = registerIdentityProbe({
      expectedChatId: "424242",
      expectedRequesterId: "requester-42",
      beforeEffect: async () => {
        entered.resolve();
        await release.promise;
      },
      effect,
    });
    await executeIdentityTurn({
      chatId: "424242",
      chatType: "direct",
      run: async (turnParams) => {
        const invocation = invokeQueuedV2Tool({ turnParams, assertInvocationCurrent, registry });
        void invocation.catch(() => undefined);
        await entered.promise;
        authority.close();
        release.resolve();
        await expect(invocation).rejects.toThrow("admitted run authority is no longer active");
      },
    });
    expect(effect).not.toHaveBeenCalled();
  });
});
