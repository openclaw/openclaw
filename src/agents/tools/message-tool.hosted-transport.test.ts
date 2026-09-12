import { once } from "node:events";
import { expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  mintMessageActionTurnCapability,
  revokeMessageActionTurnCapability,
} from "../../gateway/message-action-turn-capability.js";
import {
  buildMinimalGatewayHelloOkPayload,
  closeMinimalGatewayServer,
  parseMinimalGatewayRequestFrame,
  sendMinimalGatewayConnectChallenge,
  sendMinimalGatewayResponse,
} from "../../gateway/minimal-gateway.test-helpers.js";
import type { GatewayRequestContext } from "../../gateway/server-methods/types.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import { runMessageAction } from "../../infra/outbound/message-action-runner.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createOperationalRunInstanceRef } from "../admitted-run-context.js";
import { withGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import { createMessageTool } from "./message-tool-execution.js";

// The real client/transport proves endpoint selection here. Registered-handler
// session binding and pre-I/O revocation are covered by server-methods/send.test.ts.
it("delivers a hosted message action over the local socket without contacting the remote primary", async () => {
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
    const context = { getRuntimeConfig: () => config } as GatewayRequestContext;
    const tool = createMessageTool({
      getRuntimeConfig: () => config,
      runMessageAction,
      agentId: "ops",
      agentSessionKey: sessionKey,
      runId: operationalRunInstance.runId,
      messageActionTurnCapability: capability,
      getScopedChannelsCommandSecretTargets: () => ({ targetIds: new Set<string>() }),
      resolveCommandSecretRefsViaGateway: async ({ config: resolvedConfig }) => ({
        resolvedConfig,
        diagnostics: [],
        targetStatesByPath: {},
        hadUnresolvedTargets: false,
      }),
    });
    const execute = () =>
      withGatewayToolCallerIdentity(
        {
          agentId: "ops",
          sessionKey,
          operationalRunInstance,
          gatewayContextResolver: () => context,
        },
        () =>
          tool.execute("hosted-reaction", {
            action: "react",
            channel: "gatewaychat",
            target: "alice",
            messageId: "message-1",
            emoji: "✅",
          }),
      );
    const result = await execute();
    expect(result.details).toMatchObject({ ok: true, listener: "hosted-local" });
    expect(local.requests.map((request) => request.method)).toEqual(["connect", "message.action"]);
    expect(local.requests[0]?.params?.auth).toMatchObject({
      token: "synthetic-hosted-local-token",
      agentRuntimeIdentityToken: expect.any(String),
    });
    expect(local.requests[1]?.params).toMatchObject({
      channel: "gatewaychat",
      action: "react",
      sessionKey,
      params: { messageId: "message-1", emoji: "✅" },
    });
    expect(remote.connections).not.toHaveBeenCalled();
    releaseAgentRunDelegatedAuthority(authority);
    await expect(execute()).rejects.toThrow(
      "agent runtime identity requires active delegated run authority",
    );
    expect(local.requests.map((request) => request.method)).toEqual(["connect", "message.action"]);
    expect(remote.connections).not.toHaveBeenCalled();
  } finally {
    revokeMessageActionTurnCapability(capability);
    releaseAgentRunDelegatedAuthority(authority);
    restoreActivePluginRegistrySnapshot(registry);
    try {
      await Promise.all(listeners.map(closeMinimalGatewayServer));
    } finally {
      await state.cleanup();
    }
  }
}, 30_000);
