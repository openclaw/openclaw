import { once } from "node:events";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { createDeferred, withTestTimeout } from "../../../test/helpers/promise.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  bindCronJobAdmittedRun,
  clearCronJobActive,
  markCronJobActive,
} from "../../cron/active-jobs.js";
import { prepareCronPromptRunAdmission } from "../../cron/isolated-agent/run-admission.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../../gateway/agent-runtime-approval-authority.js";
import {
  mintMessageActionTurnCapability,
  readMessageActionInvocationConfig,
  revokeMessageActionTurnCapability,
  withMessageActionInvocationConfig,
} from "../../gateway/message-action-turn-capability.js";
import { createGatewayMethodRegistry } from "../../gateway/methods/registry.js";
import {
  buildMinimalGatewayHelloOkPayload,
  closeMinimalGatewayServer,
  parseMinimalGatewayRequestFrame,
  sendMinimalGatewayConnectChallenge,
  sendMinimalGatewayResponse,
} from "../../gateway/minimal-gateway.test-helpers.js";
import { resolveTrustedMessageActionToolContext } from "../../gateway/server-methods/message-action-context.js";
import type {
  GatewayRequestContext,
  GatewayRequestHandler,
} from "../../gateway/server-methods/types.js";
import {
  claimAgentRunDelegatedAuthority,
  getActiveAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import { runMessageAction } from "../../infra/outbound/message-action-runner.js";
import { createTestPluginRegistry } from "../../plugins/registry-runtime.test-helpers.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import {
  getGatewayContextResolver,
  withPluginRuntimeGatewayContextResolver,
} from "../../plugins/runtime/gateway-request-scope.js";
import { createPluginRecord } from "../../plugins/status.test-fixtures.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createOperationalRunInstanceRef } from "../admitted-run-context.js";
import { resolveConversationCapabilityProfile } from "../conversation-capability-profile.js";
import { createEmbeddedMessageInvocationPolicy } from "../scheduled-message-invocation.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "./gateway-caller-context.js";
import { createMessageTool } from "./message-tool-execution.js";

// Real routing proves hosted actions do not connect to either configured endpoint.
// Provider receipt and pre-I/O authority checks remain in server-methods/send.test.ts.
it("dispatches a hosted message action without connecting to either Gateway endpoint", async () => {
  const state = await createOpenClawTestState({
    env: { OPENCLAW_GATEWAY_URL: undefined, OPENCLAW_GATEWAY_TOKEN: undefined },
  });
  const registry = captureActivePluginRegistrySnapshot();
  const listeners: WebSocketServer[] = [];
  const operationalRunInstance = createOperationalRunInstanceRef("hosted-transport-run");
  const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);
  const sessionKey = "agent:ops:gatewaychat:direct:alice";
  const capability = mintMessageActionTurnCapability({
    agentId: "ops",
    runId: operationalRunInstance.runId,
    sessionKey,
  });
  const assertDashboardReadCurrent = vi.fn();
  const dashboardCapability = mintMessageActionTurnCapability({
    agentId: "ops",
    runId: operationalRunInstance.runId,
    sessionKey,
    assertDashboardReadCurrent,
    expiresWithRun: true,
  });
  try {
    const openListener = async (listener: "hosted-local" | "remote-primary") => {
      const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
      listeners.push(server);
      const connections = vi.fn();
      const requests: ReturnType<typeof parseMinimalGatewayRequestFrame>[] = [];
      server.on("connection", (socket) => {
        connections();
        sendMinimalGatewayConnectChallenge(socket);
        socket.on("message", (data) => {
          const frame = parseMinimalGatewayRequestFrame(data);
          requests.push(frame);
          if (frame.id) {
            sendMinimalGatewayResponse(
              socket,
              frame.id,
              frame.method === "connect"
                ? buildMinimalGatewayHelloOkPayload({ methods: ["message.action"] })
                : { ok: true, listener },
            );
          }
        });
      });
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected a loopback listener address");
      }
      return { connections, requests, port: address.port, url: `ws://127.0.0.1:${address.port}` };
    };
    const local = await openListener("hosted-local");
    const remote = await openListener("remote-primary");
    const plugin: ChannelPlugin = {
      id: "gatewaychat",
      meta: {
        id: "gatewaychat",
        label: "Gateway Chat",
        selectionLabel: "Gateway Chat",
        docsPath: "/channels/gatewaychat",
        blurb: "Synthetic hosted transport fixture.",
      },
      capabilities: { chatTypes: ["direct"], reactions: true },
      outbound: { deliveryMode: "gateway" },
      config: {
        listAccountIds: () => ["default"],
        resolveAccount: () => ({ enabled: true }),
        isConfigured: () => true,
      },
      actions: {
        describeMessageTool: () => ({ actions: ["react"] }),
        supportsAction: ({ action }) => action === "react",
        resolveExecutionMode: () => "gateway",
        handleAction: () => {
          throw new Error("The action must cross the Gateway transport");
        },
      },
    };
    setActivePluginRegistry(createTestRegistry([{ pluginId: plugin.id, source: "test", plugin }]));
    const config: OpenClawConfig = {
      gateway: {
        mode: "remote",
        port: local.port,
        auth: { mode: "token", token: "synthetic-hosted-local-token" },
        remote: { url: remote.url, token: "synthetic-remote-primary-token" },
      },
      channels: { gatewaychat: { enabled: true } },
    };
    setRuntimeConfigSnapshot(config, config);
    process.env.OPENCLAW_GATEWAY_URL = remote.url;
    const dispatched = vi.fn<GatewayRequestHandler>(({ params, respond }) => {
      respond(true, { ok: true, listener: "hosted-local", action: params });
    });
    const methods = createGatewayMethodRegistry([
      {
        name: "message.action",
        owner: { kind: "core", area: "message" },
        scope: "operator.write",
        handler: dispatched,
      },
    ]);
    const context = {
      getRuntimeConfig: () => config,
      getGatewayMethodRegistry: () => methods,
      trackExecution: <T>(run: () => Promise<T>) => run(),
    } as GatewayRequestContext;
    const makeTool = (turnCapability?: string) =>
      createMessageTool({
        getRuntimeConfig: () => config,
        runMessageAction,
        agentId: "ops",
        agentSessionKey: sessionKey,
        runId: operationalRunInstance.runId,
        messageActionTurnCapability: turnCapability,
        getScopedChannelsCommandSecretTargets: () => ({ targetIds: new Set<string>() }),
        resolveCommandSecretRefsViaGateway: async ({ config: resolvedConfig }) => ({
          resolvedConfig,
          diagnostics: [],
          targetStatesByPath: {},
          hadUnresolvedTargets: false,
        }),
      });
    const tool = makeTool(capability);
    const execute = (selectedTool = tool, accountId?: string) =>
      withGatewayToolCallerIdentity(
        {
          agentId: "ops",
          sessionKey,
          operationalRunInstance,
          gatewayContextResolver: () => context,
          receiptAuthority: () =>
            getActiveAgentRunDelegatedAuthority(operationalRunInstance) === authority,
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
    const result = await execute();
    expect(result.details).toMatchObject({ ok: true, listener: "hosted-local" });
    expect(dispatched).toHaveBeenCalledOnce();
    expect(dispatched.mock.calls[0]?.[0].client?.internal?.agentRuntimeIdentity).toMatchObject({
      agentId: "ops",
      sessionKey,
      operationalRunInstance,
    });
    expect(result.details).toMatchObject({
      action: {
        channel: "gatewaychat",
        action: "react",
        sessionKey,
        params: { messageId: "message-1", emoji: "✅" },
      },
    });
    expect(local.connections).not.toHaveBeenCalled();
    expect(remote.connections).not.toHaveBeenCalled();
    const contextlessTool = makeTool();
    const dashboardTool = makeTool(dashboardCapability);
    for (const selectedTool of [contextlessTool, dashboardTool]) {
      await expect(execute(selectedTool, "default")).resolves.toMatchObject({
        details: { ok: true, listener: "hosted-local" },
      });
      expect(
        dispatched.mock.calls.at(-1)?.[0].client?.internal?.agentRuntimeIdentity,
      ).toBeUndefined();
    }
    expect(dispatched.mock.calls[2]?.[0].params).toEqual(dispatched.mock.calls[1]?.[0].params);
    expect(assertDashboardReadCurrent).not.toHaveBeenCalled();
    releaseAgentRunDelegatedAuthority(authority);
    for (const selectedTool of [tool, contextlessTool, dashboardTool]) {
      await expect(execute(selectedTool)).rejects.toThrow(
        /agent (?:runtime identity requires active delegated run|tool caller) authority/,
      );
    }
    expect(dispatched).toHaveBeenCalledTimes(3);
    expect(local.connections).not.toHaveBeenCalled();
    expect(remote.connections).not.toHaveBeenCalled();
  } finally {
    revokeMessageActionTurnCapability(capability);
    revokeMessageActionTurnCapability(dashboardCapability);
    releaseAgentRunDelegatedAuthority(authority);
    restoreActivePluginRegistrySnapshot(registry);
    try {
      await Promise.all(listeners.map(closeMinimalGatewayServer));
    } finally {
      await state.cleanup();
    }
  }
}, 30_000);

it("retains scheduled invocation config through bound Gateway dispatch after preparation waits", async () => {
  const state = await createOpenClawTestState({
    env: { OPENCLAW_GATEWAY_URL: undefined, OPENCLAW_GATEWAY_TOKEN: undefined },
  });
  const registry = captureActivePluginRegistrySnapshot();
  const source = new AbortController();
  const jobId = "scheduled-config-handoff";
  const runId = "scheduled-config-run";
  const sessionId = "scheduled-persistent-session";
  const sessionKey = `agent:ops:cron:${jobId}:run:${runId}`;
  const policy = { version: 1, mode: "trusted" } as const;
  // Only runtime config changes here; canonical job revocation has its own owner tests.
  const marker = markCronJobActive(jobId, { isMessageActionAuthorityCurrent: () => true });
  const entered = createDeferred<OpenClawConfig>();
  const release = createDeferred();
  let promptAdmission: ReturnType<typeof prepareCronPromptRunAdmission> | undefined;
  let pending: ReturnType<ReturnType<typeof createMessageTool>["execute"]> | undefined;
  try {
    const configA: OpenClawConfig = {
      agents: { entries: { ops: {} }, defaults: { workspace: state.workspaceDir } },
      tools: { allow: ["message"] },
      channels: { gatewaychat: { enabled: true } },
    };
    let currentConfig = configA;
    setRuntimeConfigSnapshot(configA, configA);
    const providerRead = vi.fn<NonNullable<NonNullable<ChannelPlugin["actions"]>["handleAction"]>>(
      async ({ cfg, accountId }) => ({
        content: [{ type: "text", text: "read" }],
        details: { ok: true, config: cfg.tools?.allow?.includes("message") ? "A" : "B", accountId },
      }),
    );
    const plugin: ChannelPlugin = {
      ...createChannelTestPluginBase({
        id: "gatewaychat",
        config: {
          resolveAccount: () => ({ enabled: true }),
          isConfigured: () => true,
        },
      }),
      outbound: { deliveryMode: "gateway" },
      actions: {
        providerOwnedReadGates: true,
        readAuthorityActions: ["read"],
        describeMessageTool: () => ({ actions: ["read"] }),
        supportsAction: ({ action }) => action === "read",
        resolveExecutionMode: () => "gateway",
        handleAction: providerRead,
      },
    };
    const owner = createTestPluginRegistry();
    const record = createPluginRecord({ id: plugin.id, origin: "bundled" });
    owner.registry.plugins.push(record);
    owner
      .createApi(record, { config: configA, registrationMode: "full" })
      .registerChannel({ plugin });
    setActivePluginRegistry(owner.registry);
    const { sendHandlers } = await import("../../gateway/server-methods/send.js");
    const dispatched = vi.fn(
      expectDefined(sendHandlers["message.action"], "Gateway message handler"),
    );
    const methods = createGatewayMethodRegistry([
      {
        name: "message.action",
        owner: { kind: "core", area: "message" },
        scope: "operator.write",
        handler: dispatched,
      },
    ]);
    const context = {
      getRuntimeConfig: () => currentConfig,
      getGatewayMethodRegistry: () => methods,
      validateAgentRuntimeApprovalAuthority: createAgentRuntimeApprovalAuthorityValidator(),
      trackExecution: <T>(run: () => Promise<T>) => run(),
      dedupe: new Map(),
    } as GatewayRequestContext;
    const resolveGatewayContext = () => context;
    promptAdmission = withPluginRuntimeGatewayContextResolver(resolveGatewayContext, () =>
      prepareCronPromptRunAdmission({
        cfg: configA,
        agentId: "ops",
        runId,
        sessionId,
        sessionKey,
        jobId,
        toolsAllow: ["message"],
        scheduledToolPolicy: policy,
        executionIdentity: {
          ingress: { kind: "schedule", boundary: "cron.isolated-agent", state: "present" },
          onPostAdmission: (admitted) => bindCronJobAdmittedRun(marker, admitted, source.signal),
        },
      }),
    );
    const admitted = await promptAdmission.preparedRunAdmission.admit("plugin-harness");
    expect(getGatewayContextResolver(admitted)?.()).toBe(context);
    const capability = expectDefined(
      promptAdmission.messageActionTurnCapability,
      "scheduled grant",
    );
    const caller = createAdmittedGatewayToolCallerIdentity({
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
        agentId: "ops",
        sessionKey,
        runId,
        sessionId,
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
    const prepareSecrets = vi.fn(async ({ config }: { config: OpenClawConfig }) => {
      entered.resolve(config);
      await release.promise;
      return {
        resolvedConfig: config,
        diagnostics: [],
        targetStatesByPath: {},
        hadUnresolvedTargets: false,
      };
    });
    const tool = createMessageTool({
      config: configA,
      agentId: "ops",
      agentSessionKey: sessionKey,
      agentAccountId: "default",
      runId,
      sessionId,
      messageActionTurnCapability: capability,
      admitScheduledInvocation: admitInvocation,
      getScopedChannelsCommandSecretTargets: () => ({ targetIds: new Set<string>() }),
      resolveCommandSecretRefsViaGateway: prepareSecrets,
    });
    catalog.push(tool);
    const execute = (callId: string) =>
      withGatewayToolCallerIdentity(caller, () =>
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
    expect(providerRead).toHaveBeenCalledOnce();
    expect(providerRead.mock.calls[0]?.[0].cfg).toMatchObject(configA);
    expect(admitInvocation).toHaveBeenCalledOnce();
    expect(readMessageActionInvocationConfig(capability)).toBeUndefined();

    const client = expectDefined(dispatched.mock.calls[0]?.[0].client, "bound Gateway client");
    const mismatched = withMessageActionInvocationConfig(
      "unrelated-host-token",
      () => configA,
      () =>
        resolveTrustedMessageActionToolContext({
          client,
          request: { sessionKey, sessionId },
        }),
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
    promptAdmission?.close();
    clearCronJobActive(jobId, marker);
    restoreActivePluginRegistrySnapshot(registry);
    await state.cleanup();
  }
}, 30_000);
