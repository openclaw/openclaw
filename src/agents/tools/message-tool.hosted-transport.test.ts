import { once } from "node:events";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { createDeferred, withTestTimeout } from "../../../test/helpers/promise.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import * as commandSecretGateway from "../../cli/command-secret-gateway.js";
import * as commandSecretTargets from "../../cli/command-secret-targets.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import * as cron from "../../cron/active-jobs.js";
import { prepareCronRunAdmission } from "../../cron/run-admission.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../../gateway/agent-runtime-approval-authority.js";
import * as turns from "../../gateway/message-action-turn-capability.js";
import { createGatewayMethodRegistry } from "../../gateway/methods/registry.js";
import { closeMinimalGatewayServer } from "../../gateway/minimal-gateway.test-helpers.js";
import { resolveTrustedMessageActionToolContext } from "../../gateway/server-methods/message-action-context.js";
import type {
  GatewayRequestContext,
  GatewayRequestHandler,
} from "../../gateway/server-methods/types.js";
import * as runs from "../../infra/agent-run-registry.js";
import { createTestPluginRegistry } from "../../plugins/registry-runtime.test-helpers.js";
import * as plugins from "../../plugins/runtime.js";
import { withPluginRuntimeGatewayContextResolver } from "../../plugins/runtime/gateway-request-scope.js";
import { createPluginRecord } from "../../plugins/status.test-fixtures.js";
import * as fixtures from "../../test-utils/channel-plugins.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createOperationalRunInstanceRef } from "../admitted-run-context.js";
import { resolveConversationCapabilityProfile } from "../conversation-capability-profile.js";
import { createEmbeddedMessageInvocationPolicy } from "../scheduled-message-invocation.js";
import * as callers from "./gateway-caller-context.js";
import { createMessageTool } from "./message-tool-execution.js";

let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
let registry: ReturnType<typeof plugins.captureActivePluginRegistrySnapshot>;
beforeEach(async () => {
  state = await createOpenClawTestState({
    env: { OPENCLAW_GATEWAY_URL: undefined, OPENCLAW_GATEWAY_TOKEN: undefined },
  });
  registry = plugins.captureActivePluginRegistrySnapshot();
  vi.spyOn(commandSecretTargets, "getScopedChannelsCommandSecretTargets").mockReturnValue({
    targetIds: new Set<string>(),
  });
  vi.spyOn(commandSecretGateway, "resolveCommandSecretRefsViaGateway").mockImplementation(
    async ({ config }) => resolvedSecrets(config),
  );
});
afterEach(async () => {
  vi.restoreAllMocks();
  plugins.restoreActivePluginRegistrySnapshot(registry);
  await state.cleanup();
});

function hostedConfig(overrides: Partial<OpenClawConfig> = {}): OpenClawConfig {
  return {
    agents: { entries: { ops: {} }, defaults: { workspace: state.workspaceDir } },
    channels: { gatewaychat: { enabled: true } },
    ...overrides,
  };
}

function gatewayContext(
  getRuntimeConfig: () => OpenClawConfig,
  handler: GatewayRequestHandler,
  overrides: Partial<GatewayRequestContext> = {},
) {
  const methods = createGatewayMethodRegistry([
    {
      name: "message.action",
      owner: { kind: "core", area: "message" },
      scope: "operator.write",
      handler,
    },
  ]);
  return {
    getRuntimeConfig,
    getGatewayMethodRegistry: () => methods,
    trackExecution: <T>(run: () => Promise<T>) => run(),
    ...overrides,
  } as GatewayRequestContext;
}

function resolvedSecrets(resolvedConfig: OpenClawConfig) {
  return { resolvedConfig, diagnostics: [], targetStatesByPath: {}, hadUnresolvedTargets: false };
}

function gatewayPlugin(
  action: "read" | "react",
  handleAction: NonNullable<ChannelPlugin["actions"]>["handleAction"],
): ChannelPlugin {
  return {
    ...fixtures.createChannelTestPluginBase({
      id: "gatewaychat",
      capabilities: { chatTypes: ["direct"], ...(action === "react" ? { reactions: true } : {}) },
      config: {
        resolveAccount: () => ({ enabled: true }),
        isConfigured: () => true,
      },
    }),
    outbound: { deliveryMode: "gateway" },
    actions: {
      ...(action === "read"
        ? { providerOwnedReadGates: true, readAuthorityActions: [action] }
        : {}),
      describeMessageTool: () => ({ actions: [action] }),
      supportsAction: (context) => context.action === action,
      resolveExecutionMode: () => "gateway",
      handleAction,
    },
  };
}

// Real routing proves hosted actions do not connect to either configured endpoint.
// Provider receipt and pre-I/O authority checks remain in server-methods/send.test.ts.
it("dispatches a hosted message action without connecting to either Gateway endpoint", async () => {
  const listeners: WebSocketServer[] = [];
  const operationalRunInstance = createOperationalRunInstanceRef("hosted-transport-run");
  const authority = runs.claimAgentRunDelegatedAuthority(operationalRunInstance);
  const sessionKey = "agent:ops:gatewaychat:direct:alice";
  const run = { agentId: "ops", runId: operationalRunInstance.runId };
  const capability = turns.mintMessageActionTurnCapability({ ...run, sessionKey });
  const assertDashboardReadCurrent = vi.fn();
  const dashboardCapability = turns.mintMessageActionTurnCapability({
    ...run,
    sessionKey,
    assertDashboardReadCurrent,
    expiresWithRun: true,
  });
  try {
    const openListener = async () => {
      const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
      listeners.push(server);
      const connections = vi.fn();
      server.on("connection", (socket) => {
        connections();
        socket.terminate();
      });
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected a loopback listener address");
      }
      return { connections, port: address.port, url: `ws://127.0.0.1:${address.port}` };
    };
    const local = await openListener();
    const remote = await openListener();
    const plugin = gatewayPlugin("react", () => {
      throw new Error("The action must cross the Gateway transport");
    });
    plugins.setActivePluginRegistry(
      fixtures.createTestRegistry([{ pluginId: plugin.id, source: "test", plugin }]),
    );
    const config = hostedConfig({
      gateway: {
        mode: "remote",
        port: local.port,
        auth: { mode: "token", token: "synthetic-hosted-local-token" },
        remote: { url: remote.url, token: "synthetic-remote-primary-token" },
      },
    });
    setRuntimeConfigSnapshot(config, config);
    process.env.OPENCLAW_GATEWAY_URL = remote.url;
    const dispatched = vi.fn<GatewayRequestHandler>(({ params, respond }) => {
      respond(true, { ok: true, listener: "hosted-local", action: params });
    });
    const context = gatewayContext(() => config, dispatched);
    const makeTool = (turnCapability?: string) =>
      createMessageTool({
        ...run,
        agentSessionKey: sessionKey,
        messageActionTurnCapability: turnCapability,
      });
    const tools = [makeTool(capability), makeTool(), makeTool(dashboardCapability)];
    const execute = (selectedTool: (typeof tools)[number], accountId?: string) =>
      callers.withGatewayToolCallerIdentity(
        {
          agentId: "ops",
          sessionKey,
          operationalRunInstance,
          gatewayContextResolver: () => context,
          receiptAuthority: () =>
            runs.getActiveAgentRunDelegatedAuthority(operationalRunInstance) === authority,
        },
        () =>
          selectedTool.execute("hosted-reaction", {
            action: "react",
            channel: "gatewaychat",
            target: "alice",
            messageId: "message-1",
            emoji: "✅",
            ...(accountId ? { accountId } : {}),
          }),
      );
    for (const [index, tool] of tools.entries()) {
      const result = await execute(tool, index === 0 ? undefined : "default");
      expect(dispatched).toHaveBeenCalledTimes(index + 1);
      expect(result.details).toMatchObject({
        ok: true,
        listener: "hosted-local",
        action: {
          channel: "gatewaychat",
          action: "react",
          sessionKey,
          params: { messageId: "message-1", emoji: "✅" },
        },
      });
      expect(dispatched.mock.calls.at(-1)?.[0].client?.internal?.agentRuntimeIdentity).toEqual(
        index === 0
          ? expect.objectContaining({ agentId: "ops", sessionKey, operationalRunInstance })
          : undefined,
      );
    }
    expect(dispatched.mock.calls[2]?.[0].params).toEqual(dispatched.mock.calls[1]?.[0].params);
    expect(assertDashboardReadCurrent).not.toHaveBeenCalled();
    runs.releaseAgentRunDelegatedAuthority(authority);
    for (const selectedTool of tools) {
      await expect(execute(selectedTool)).rejects.toThrow(
        /agent (?:runtime identity requires active delegated run|tool caller) authority/,
      );
    }
    expect(dispatched).toHaveBeenCalledTimes(3);
    expect(local.connections).not.toHaveBeenCalled();
    expect(remote.connections).not.toHaveBeenCalled();
  } finally {
    turns.revokeMessageActionTurnCapability(capability);
    turns.revokeMessageActionTurnCapability(dashboardCapability);
    runs.releaseAgentRunDelegatedAuthority(authority);
    await Promise.all(listeners.map(closeMinimalGatewayServer));
  }
}, 30_000);

it("retains scheduled invocation config through bound Gateway dispatch after preparation waits", async () => {
  const source = new AbortController();
  const jobId = "scheduled-config-handoff";
  const runId = "scheduled-config-run";
  const sessionId = "scheduled-persistent-session";
  const sessionKey = `agent:ops:cron:${jobId}:run:${runId}`;
  const run = { agentId: "ops", runId, sessionId };
  const policy = { version: 1, mode: "trusted" } as const;
  // Only runtime config changes here; canonical job revocation has its own owner tests.
  const marker = cron.markCronJobActive(jobId, { isMessageActionAuthorityCurrent: () => true });
  const entered = createDeferred<OpenClawConfig>();
  const release = createDeferred();
  let promptAdmission: ReturnType<typeof prepareCronRunAdmission> | undefined;
  let pending: ReturnType<ReturnType<typeof createMessageTool>["execute"]> | undefined;
  try {
    const configA = hostedConfig({ tools: { allow: ["message"] } });
    let currentConfig = configA;
    setRuntimeConfigSnapshot(configA, configA);
    const providerRead = vi.fn<NonNullable<NonNullable<ChannelPlugin["actions"]>["handleAction"]>>(
      async ({ cfg, accountId }) => ({
        content: [{ type: "text", text: "read" }],
        details: { ok: true, config: cfg.tools?.allow?.includes("message") ? "A" : "B", accountId },
      }),
    );
    const plugin = gatewayPlugin("read", providerRead);
    const owner = createTestPluginRegistry();
    const record = createPluginRecord({ id: plugin.id, origin: "bundled" });
    owner.registry.plugins.push(record);
    owner
      .createApi(record, { config: configA, registrationMode: "full" })
      .registerChannel({ plugin });
    plugins.setActivePluginRegistry(owner.registry);
    const { sendHandlers } = await import("../../gateway/server-methods/send.js");
    const dispatched = vi.fn(
      expectDefined(sendHandlers["message.action"], "Gateway message handler"),
    );
    const context = gatewayContext(() => currentConfig, dispatched, {
      validateAgentRuntimeApprovalAuthority: createAgentRuntimeApprovalAuthorityValidator(),
      dedupe: new Map(),
    });
    const resolveGatewayContext = () => context;
    promptAdmission = withPluginRuntimeGatewayContextResolver(resolveGatewayContext, () =>
      prepareCronRunAdmission({
        deliveryAttemptFence: { beforeAttempt: async () => {}, assertCurrent: () => {} },
        cfg: configA,
        ...run,
        sessionKey,
        jobId,
        toolsAllow: ["message"],
        scheduledToolPolicy: policy,
        executionIdentity: {
          ingress: { kind: "schedule", boundary: "cron.isolated-agent", state: "present" },
          onPostAdmission: (admitted) =>
            cron.bindCronJobAdmittedRun(marker, admitted, source.signal),
        },
      }),
    );
    const admitted = await promptAdmission.preparedRunAdmission.admit("plugin-harness");
    const capability = expectDefined(
      promptAdmission.messageActionTurnCapability,
      "scheduled grant",
    );
    const caller = callers.createAdmittedGatewayToolCallerIdentity({
      admittedRunContext: admitted,
      agentId: "ops",
      sessionKey,
      approvalSignals: [source.signal],
    });
    const catalog: ReturnType<typeof createMessageTool>[] = [];
    const invocationPolicy = createEmbeddedMessageInvocationPolicy({
      config: configA,
      capabilityProfile: resolveConversationCapabilityProfile({
        config: configA,
        ...run,
        sessionKey,
        agentAccountId: "default",
        scheduledToolPolicy: policy,
      }),
      runtimeProfileAlsoAllow: ["message"],
      toolSearchControlAllowlist: [],
      scheduledToolPolicy: policy,
      catalog: () => ({ tools: catalog }),
      isAvailable: () => catalog.some((tool) => tool.name === "message"),
    });
    const admitInvocation = vi.fn(invocationPolicy.admit);
    const prepareSecrets = vi
      .spyOn(commandSecretGateway, "resolveCommandSecretRefsViaGateway")
      .mockImplementation(async ({ config }) => {
        entered.resolve(config);
        await release.promise;
        return resolvedSecrets(config);
      });
    const tool = createMessageTool({
      config: configA,
      ...run,
      agentSessionKey: sessionKey,
      agentAccountId: "default",
      messageActionTurnCapability: capability,
      admitScheduledInvocation: admitInvocation,
    });
    catalog.push(tool);
    const execute = (callId: string) =>
      callers.withGatewayToolCallerIdentity(caller, () =>
        tool.execute(
          callId,
          { action: "read", channel: plugin.id, target: "alice", limit: 1 },
          source.signal,
        ),
      );
    pending = execute("admitted-before-publication");
    void pending.catch(() => undefined);
    expect(
      await withTestTimeout(entered.promise, 5000, "Secret preparation did not start"),
    ).toMatchObject(configA);
    expect(admitInvocation).toHaveBeenCalledOnce();
    expect(dispatched).not.toHaveBeenCalled();

    currentConfig = {
      ...configA,
      tools: { deny: ["message"] },
      channels: { gatewaychat: { enabled: false } },
    };
    setRuntimeConfigSnapshot(currentConfig, currentConfig);
    release.resolve();
    expect((await pending).details).toMatchObject({ ok: true, config: "A", accountId: "default" });
    expect(dispatched).toHaveBeenCalledOnce();
    expect(providerRead.mock.calls[0]?.[0].cfg).toMatchObject(configA);
    expect(turns.readMessageActionInvocationConfig(capability)).toBeUndefined();

    const client = expectDefined(dispatched.mock.calls[0]?.[0].client, "bound Gateway client");
    const mismatched = turns.withMessageActionInvocationConfig(
      "unrelated-host-token",
      () => configA,
      () => resolveTrustedMessageActionToolContext({ client, request: { sessionKey, sessionId } }),
    );
    expect(mismatched).toMatchObject({ ok: true, messageActionConfig: undefined });
    await expect(execute("after-publication")).rejects.toThrow(
      /not allowed by the current tool policy/,
    );
    expect(admitInvocation).toHaveBeenCalledTimes(2);
    expect(prepareSecrets).toHaveBeenCalledOnce();
    expect(providerRead).toHaveBeenCalledOnce();
  } finally {
    source.abort();
    release.resolve();
    await pending?.catch(() => undefined);
    vi.restoreAllMocks();
    promptAdmission?.close();
    cron.clearCronJobActive(jobId, marker);
  }
}, 30_000);
