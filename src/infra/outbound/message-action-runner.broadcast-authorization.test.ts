import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { AuthorizationInvocationContext } from "../../plugins/authorization-policy.types.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createDeferred } from "../../shared/deferred.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import {
  installMessageActionPolicy,
  resetMessageActionPolicyRegistry,
} from "./message-action-runner.authorization.test-helpers.js";
import { runMessageAction } from "./message-action-runner.js";

const gatewayMocks = vi.hoisted(() => ({
  callGatewayLeastPrivilege: vi.fn(),
  isGatewayTransportError: vi.fn<(value: unknown) => boolean>(() => false),
}));

vi.mock("./message.gateway.runtime.js", () => ({
  callGatewayLeastPrivilege: gatewayMocks.callGatewayLeastPrivilege,
  isGatewayTransportError: gatewayMocks.isGatewayTransportError,
  randomIdempotencyKey: () => "broadcast-idempotency-key",
}));

afterEach(() => {
  resetMessageActionPolicyRegistry();
  gatewayMocks.callGatewayLeastPrivilege.mockReset();
  gatewayMocks.isGatewayTransportError.mockReset();
  gatewayMocks.isGatewayTransportError.mockReturnValue(false);
});

describe("message action broadcast authorization", () => {
  it("authorizes every real channel leaf before denying a multi-channel broadcast", async () => {
    const sendText = vi.fn().mockResolvedValue({
      channel: "directchat",
      messageId: "message-1",
      chatId: "channel-1",
    });
    const configured = (plugin: ReturnType<typeof createOutboundTestPlugin>) => ({
      ...plugin,
      config: { ...plugin.config, listAccountIds: () => ["default"] },
    });
    const seen: Array<{
      channel: string;
      accountId?: string;
      target?: string;
      targets?: readonly string[];
    }> = [];
    installMessageActionPolicy(
      (request) => {
        if (request.action === "broadcast") {
          seen.push({
            channel: request.channel,
            accountId: request.accountId,
            target: request.target,
            targets: request.targets,
          });
          if (request.channel === "gatewaychat" && request.target === "channel:two") {
            return { effect: "deny", code: "gateway-broadcast-denied" };
          }
        }
        return { effect: "pass" };
      },
      [
        configured(
          createOutboundTestPlugin({
            id: "directchat",
            outbound: { deliveryMode: "direct", sendText },
          }),
        ),
        configured(
          createOutboundTestPlugin({
            id: "gatewaychat",
            outbound: { deliveryMode: "gateway" },
          }),
        ),
      ],
    );
    const resolveAgentRuntimeIdentityToken = vi.fn(async () => "runtime-token");

    await expect(
      runMessageAction({
        cfg: {
          channels: {
            directchat: { enabled: true },
            gatewaychat: { enabled: true },
          },
          tools: { message: { broadcast: { enabled: true } } },
        } as OpenClawConfig,
        action: "broadcast",
        params: {
          targets: ["channel:one", "channel:two"],
          accountId: "ops",
          message: "hello",
        },
        agentId: "main",
        gateway: {
          resolveAgentRuntimeIdentityToken,
          clientName: "cli",
          mode: "cli",
        },
      }),
    ).rejects.toThrow("Message action blocked by authorization policy.");

    expect(seen).toEqual([
      {
        channel: "directchat",
        accountId: "ops",
        target: "channel:one",
        targets: undefined,
      },
      {
        channel: "directchat",
        accountId: "ops",
        target: "channel:two",
        targets: undefined,
      },
      {
        channel: "gatewaychat",
        accountId: "ops",
        target: "channel:one",
        targets: undefined,
      },
      {
        channel: "gatewaychat",
        accountId: "ops",
        target: "channel:two",
        targets: undefined,
      },
    ]);
    expect(sendText).not.toHaveBeenCalled();
    expect(resolveAgentRuntimeIdentityToken).not.toHaveBeenCalled();
    expect(gatewayMocks.callGatewayLeastPrivilege).not.toHaveBeenCalled();
  });

  it("finishes every promoted broadcast leaf after caller cancellation", async () => {
    const abortController = new AbortController();
    const sendText = vi.fn(async () => {
      if (sendText.mock.calls.length === 1) {
        abortController.abort(new Error("caller stopped after promotion"));
      }
      return {
        channel: "testchat",
        messageId: `message-${sendText.mock.calls.length}`,
        chatId: "channel-1",
      };
    });
    installMessageActionPolicy(
      () => ({ effect: "pass" }),
      createOutboundTestPlugin({
        id: "testchat",
        outbound: { deliveryMode: "direct", sendText },
      }),
    );

    const result = await runMessageAction({
      cfg: { channels: { testchat: { enabled: true } } } as OpenClawConfig,
      action: "broadcast",
      params: {
        channel: "testchat",
        targets: ["channel:one", "channel:two"],
        message: "hello",
      },
      dryRun: false,
      agentId: "main",
      abortSignal: abortController.signal,
    });

    expect(result).toMatchObject({
      kind: "broadcast",
      payload: {
        results: [
          { to: expect.stringContaining("one"), ok: true },
          { to: expect.stringContaining("two"), ok: true },
        ],
      },
    });
    expect(sendText).toHaveBeenCalledTimes(2);
  });

  it("cancels every broadcast leaf when caller cancellation wins before promotion", async () => {
    const abortController = new AbortController();
    const secondPolicyEntered = createDeferred();
    const releaseSecondPolicy = createDeferred();
    const sendText = vi.fn().mockResolvedValue({
      channel: "testchat",
      messageId: "message-1",
      chatId: "channel-1",
    });
    installMessageActionPolicy(
      async (request) => {
        if (request.action === "send" && request.target?.endsWith("two")) {
          secondPolicyEntered.resolve();
          await releaseSecondPolicy.promise;
        }
        return { effect: "pass" };
      },
      createOutboundTestPlugin({
        id: "testchat",
        outbound: { deliveryMode: "direct", sendText },
      }),
    );

    const pending = runMessageAction({
      cfg: { channels: { testchat: { enabled: true } } } as OpenClawConfig,
      action: "broadcast",
      params: {
        channel: "testchat",
        targets: ["channel:one", "channel:two"],
        message: "hello",
      },
      dryRun: false,
      agentId: "main",
      abortSignal: abortController.signal,
    });
    await secondPolicyEntered.promise;
    abortController.abort(new Error("caller stopped before promotion"));
    releaseSecondPolicy.resolve();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(sendText).not.toHaveBeenCalled();
  });

  it("preserves a signed unknown principal and session agent across Gateway delegation", async () => {
    const sendText = vi.fn().mockResolvedValue({
      channel: "directchat",
      messageId: "message-1",
      chatId: "channel-1",
    });
    const configured = (plugin: ReturnType<typeof createOutboundTestPlugin>) => ({
      ...plugin,
      config: { ...plugin.config, listAccountIds: () => ["default"] },
    });
    let broadcastContext: AuthorizationInvocationContext | undefined;
    installMessageActionPolicy(
      (request, context) => {
        if (request.action === "broadcast") {
          broadcastContext = context;
        }
        return { effect: "pass" };
      },
      [
        configured(
          createOutboundTestPlugin({
            id: "directchat",
            outbound: { deliveryMode: "direct", sendText },
          }),
        ),
        configured(
          createOutboundTestPlugin({
            id: "gatewaychat",
            outbound: { deliveryMode: "gateway" },
          }),
        ),
      ],
    );
    gatewayMocks.callGatewayLeastPrivilege.mockResolvedValue({
      results: [
        { channel: "directchat", to: "channel:one", ok: true },
        { channel: "gatewaychat", to: "channel:one", ok: true },
      ],
    });
    const cfg = {
      channels: {
        directchat: { enabled: true },
        gatewaychat: { enabled: true },
      },
      tools: { message: { broadcast: { enabled: true } } },
    } as OpenClawConfig;
    const resolveAgentRuntimeIdentityToken = vi.fn(async () => "unknown-principal-token");

    const result = await runMessageAction({
      cfg,
      action: "broadcast",
      params: { targets: ["channel:one"], message: "hello" },
      dryRun: false,
      sessionKey: "agent:molty:main",
      messageActionAuthorization: {},
      gateway: {
        resolveAgentRuntimeIdentityToken,
        clientName: "cli",
        mode: "cli",
      },
    });

    expect(result).toMatchObject({ kind: "broadcast" });
    expect(broadcastContext).toMatchObject({
      principal: { kind: "unknown" },
      agentId: "molty",
      sessionKey: "agent:molty:main",
    });
    expect(sendText).not.toHaveBeenCalled();
    expect(gatewayMocks.callGatewayLeastPrivilege).toHaveBeenCalledOnce();
    expect(gatewayMocks.callGatewayLeastPrivilege).toHaveBeenCalledWith(
      expect.objectContaining({
        agentRuntimeIdentityToken: "unknown-principal-token",
        method: "message.action",
        params: expect.objectContaining({
          action: "broadcast",
          agentId: "molty",
          params: expect.objectContaining({ channel: "all" }),
        }),
      }),
    );
  });

  it("fails closed before Gateway delegation for an unsigned unknown principal", async () => {
    const plugin = createOutboundTestPlugin({
      id: "gatewaychat",
      outbound: { deliveryMode: "gateway" },
    });
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: plugin.id,
          source: "test",
          plugin: { ...plugin, config: { ...plugin.config, listAccountIds: () => ["default"] } },
        },
      ]),
    );
    const resolveAgentRuntimeIdentityToken = vi.fn(async () => undefined);

    await expect(
      runMessageAction({
        cfg: {
          channels: { gatewaychat: { enabled: true } },
          tools: { message: { broadcast: { enabled: true } } },
        } as OpenClawConfig,
        action: "broadcast",
        params: { targets: ["channel:one"], message: "hello" },
        agentId: "main",
        messageActionAuthorization: {},
        gateway: {
          resolveAgentRuntimeIdentityToken,
          clientName: "cli",
          mode: "cli",
        },
      }),
    ).rejects.toThrow("Message action blocked by authorization policy.");

    expect(resolveAgentRuntimeIdentityToken).toHaveBeenCalledOnce();
    expect(gatewayMocks.callGatewayLeastPrivilege).not.toHaveBeenCalled();
  });

  it("fails closed before Gateway delegation for explicit unknown authorization", async () => {
    const plugin = createOutboundTestPlugin({
      id: "gatewaychat",
      outbound: { deliveryMode: "gateway" },
    });
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: plugin.id,
          source: "test",
          plugin: { ...plugin, config: { ...plugin.config, listAccountIds: () => ["default"] } },
        },
      ]),
    );
    const resolveAgentRuntimeIdentityToken = vi.fn(async () => undefined);

    await expect(
      runMessageAction({
        cfg: {
          channels: { gatewaychat: { enabled: true } },
          tools: { message: { broadcast: { enabled: true } } },
        } as OpenClawConfig,
        action: "broadcast",
        params: { targets: ["channel:one"], message: "hello" },
        authorization: { principal: { kind: "unknown" } },
        gateway: {
          resolveAgentRuntimeIdentityToken,
          clientName: "cli",
          mode: "cli",
        },
      }),
    ).rejects.toThrow("Message action blocked by authorization policy.");

    expect(resolveAgentRuntimeIdentityToken).toHaveBeenCalledOnce();
    expect(gatewayMocks.callGatewayLeastPrivilege).not.toHaveBeenCalled();
  });

  it("keeps unsigned Gateway delegation for callers without authority context", async () => {
    const plugin = createOutboundTestPlugin({
      id: "gatewaychat",
      outbound: { deliveryMode: "gateway" },
    });
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: plugin.id,
          source: "test",
          plugin: { ...plugin, config: { ...plugin.config, listAccountIds: () => ["default"] } },
        },
      ]),
    );
    gatewayMocks.callGatewayLeastPrivilege.mockResolvedValue({
      results: [{ channel: "gatewaychat", to: "channel:one", ok: true }],
    });

    await expect(
      runMessageAction({
        cfg: {
          channels: { gatewaychat: { enabled: true } },
          tools: { message: { broadcast: { enabled: true } } },
        } as OpenClawConfig,
        action: "broadcast",
        params: { targets: ["channel:one"], message: "hello" },
        gateway: { clientName: "cli", mode: "cli" },
      }),
    ).resolves.toMatchObject({ kind: "broadcast" });

    expect(gatewayMocks.callGatewayLeastPrivilege).toHaveBeenCalledOnce();
    expect(gatewayMocks.callGatewayLeastPrivilege).toHaveBeenCalledWith(
      expect.objectContaining({ agentRuntimeIdentityToken: undefined }),
    );
  });

  it("reattaches a timed-out Gateway-owned broadcast with the same idempotency key", async () => {
    const directSend = vi.fn();
    const configured = (plugin: ReturnType<typeof createOutboundTestPlugin>) => ({
      ...plugin,
      config: { ...plugin.config, listAccountIds: () => ["default"] },
    });
    setActivePluginRegistry(
      createTestRegistry(
        [
          configured(
            createOutboundTestPlugin({
              id: "directchat",
              outbound: { deliveryMode: "direct", sendText: directSend },
            }),
          ),
          configured(
            createOutboundTestPlugin({
              id: "gatewaychat",
              outbound: { deliveryMode: "gateway" },
            }),
          ),
        ].map((plugin) => ({ pluginId: plugin.id, source: "test", plugin })),
      ),
    );
    const timeout = Object.assign(new Error("Gateway timeout"), { kind: "timeout" });
    gatewayMocks.isGatewayTransportError.mockImplementation((error) => error === timeout);
    gatewayMocks.callGatewayLeastPrivilege.mockRejectedValueOnce(timeout).mockResolvedValueOnce({
      results: [
        { channel: "directchat", to: "channel:one", ok: true },
        { channel: "gatewaychat", to: "channel:one", ok: true },
      ],
    });

    await expect(
      runMessageAction({
        cfg: {
          channels: {
            directchat: { enabled: true },
            gatewaychat: { enabled: true },
          },
          tools: { message: { broadcast: { enabled: true } } },
        } as OpenClawConfig,
        action: "broadcast",
        defaultAccountId: "ops",
        params: {
          targets: ["channel:one"],
          message: "hello",
          idempotencyKey: "stable-broadcast-key",
        },
        gateway: {
          timeoutMs: 120_000,
          resolveAgentRuntimeIdentityToken: async () => "reattach-runtime-token",
          clientName: "cli",
          mode: "cli",
        },
      }),
    ).resolves.toMatchObject({ kind: "broadcast" });

    expect(directSend).not.toHaveBeenCalled();
    expect(gatewayMocks.callGatewayLeastPrivilege).toHaveBeenCalledTimes(2);
    const firstCall = gatewayMocks.callGatewayLeastPrivilege.mock.calls[0]?.[0];
    const secondCall = gatewayMocks.callGatewayLeastPrivilege.mock.calls[1]?.[0];
    expect(firstCall).toMatchObject({
      agentRuntimeIdentityToken: "reattach-runtime-token",
      timeoutMs: 30_000,
      params: { accountId: "ops", idempotencyKey: "stable-broadcast-key" },
    });
    expect(secondCall).toMatchObject({
      agentRuntimeIdentityToken: "reattach-runtime-token",
      timeoutMs: 60_000,
      params: { idempotencyKey: "stable-broadcast-key" },
    });
  });

  it("stops after one Gateway-owned broadcast reattachment", async () => {
    const plugin = createOutboundTestPlugin({
      id: "gatewaychat",
      outbound: { deliveryMode: "gateway" },
    });
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: plugin.id,
          source: "test",
          plugin: { ...plugin, config: { ...plugin.config, listAccountIds: () => ["default"] } },
        },
      ]),
    );
    const timeout = Object.assign(new Error("Gateway timeout"), { kind: "timeout" });
    gatewayMocks.isGatewayTransportError.mockImplementation((error) => error === timeout);
    gatewayMocks.callGatewayLeastPrivilege.mockRejectedValue(timeout);

    await expect(
      runMessageAction({
        cfg: {
          channels: { gatewaychat: { enabled: true } },
          tools: { message: { broadcast: { enabled: true } } },
        } as OpenClawConfig,
        action: "broadcast",
        params: {
          channel: "gatewaychat",
          targets: ["channel:one"],
          message: "hello",
          idempotencyKey: "bounded-broadcast-key",
        },
        gateway: { timeoutMs: 120_000, clientName: "cli", mode: "cli" },
      }),
    ).rejects.toBe(timeout);

    expect(gatewayMocks.callGatewayLeastPrivilege).toHaveBeenCalledTimes(2);
    expect(
      gatewayMocks.callGatewayLeastPrivilege.mock.calls.map(([call]) => ({
        timeoutMs: call.timeoutMs,
        idempotencyKey: call.params.idempotencyKey,
      })),
    ).toEqual([
      { timeoutMs: 30_000, idempotencyKey: "bounded-broadcast-key" },
      { timeoutMs: 60_000, idempotencyKey: "bounded-broadcast-key" },
    ]);
  });

  it("keeps single-leaf broadcast ownership on the core delivery path", async () => {
    const sendText = vi.fn().mockResolvedValue({ messageId: "owned-message" });
    const plugin = createOutboundTestPlugin({
      id: "gatewaychat",
      outbound: { deliveryMode: "gateway", sendText },
    });
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: plugin.id,
          source: "test",
          plugin: { ...plugin, config: { ...plugin.config, listAccountIds: () => ["default"] } },
        },
      ]),
    );

    await expect(
      runMessageAction({
        cfg: {
          channels: { gatewaychat: { enabled: true } },
          tools: { message: { broadcast: { enabled: true } } },
        } as OpenClawConfig,
        action: "broadcast",
        params: { targets: ["channel:one"], message: "owned" },
        preparedMessageId: "prepared-owned-message",
        gateway: { timeoutMs: 120_000, clientName: "cli", mode: "cli" },
      }),
    ).resolves.toMatchObject({ kind: "broadcast", handledBy: "core" });

    expect(gatewayMocks.callGatewayLeastPrivilege).toHaveBeenCalledOnce();
    expect(gatewayMocks.callGatewayLeastPrivilege.mock.calls[0]?.[0]).toMatchObject({
      method: "send",
    });
    expect(sendText).not.toHaveBeenCalled();
  });
});
