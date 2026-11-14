import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PreparedMessageToolCatalog } from "../../channels/plugins/message-action-discovery.js";
import { resolveBundledChannelMessageToolDiscoveryAdapter } from "../../channels/plugins/message-tool-api.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import * as commandSecretGateway from "../../cli/command-secret-gateway.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import * as turns from "../../gateway/message-action-turn-capability.js";
import * as messageActionRunner from "../../infra/outbound/message-action-runner.js";
import * as plugins from "../../plugins/runtime.js";
import * as fixtures from "../../test-utils/channel-plugins.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import { createMessageTool, createMessageToolAsync } from "./message-tool-execution.js";
import { resolvedMessageSecrets } from "./message-tool-execution.test-support.js";

const target = "channel:100000000000000001";
const identity = { agentId: "main", runId: "scheduled-message-run" };
const sessionKey = "agent:main:cron:scheduled-message:run:fixture";
const grants: string[] = [];
const sessionDirs = useSessionStoreTempDirs(afterAll, "message-definition-binding-");
const catalog = (channels: PreparedMessageToolCatalog["channels"]): PreparedMessageToolCatalog => ({
  version: 1,
  channels,
  getChannel: (id) => channels.find((channel) => channel.id === id),
});
let registry: ReturnType<typeof plugins.captureActivePluginRegistrySnapshot>;
beforeEach(() => {
  registry = plugins.captureActivePluginRegistrySnapshot();
});
afterEach(() => {
  vi.restoreAllMocks();
  grants.splice(0).forEach(turns.revokeMessageActionTurnCapability);
  plugins.restoreActivePluginRegistrySnapshot(registry);
  clearRuntimeConfigSnapshot();
});
function grant(
  scheduled: NonNullable<Parameters<typeof turns.mintMessageActionTurnCapability>[0]["scheduled"]>,
) {
  const capability = turns.mintMessageActionTurnCapability({ ...identity, sessionKey, scheduled });
  grants.push(capability);
  return capability;
}
function toolOptions(config: OpenClawConfig, capability: string | undefined) {
  setRuntimeConfigSnapshot(config);
  return {
    config,
    ...identity,
    agentSessionKey: sessionKey,
    messageActionTurnCapability: capability,
    admitScheduledInvocation: () => config,
  };
}

function registerDiscord(
  actions: Array<"send" | "read" | "edit">,
  config?: Partial<ChannelPlugin["config"]>,
) {
  const plugin: ChannelPlugin = {
    ...fixtures.createChannelTestPluginBase({ id: "discord", config }),
    actions: { describeMessageTool: () => ({ actions }) },
  };
  plugins.setActivePluginRegistry(
    fixtures.createTestRegistry([{ pluginId: "discord", source: "test", plugin }]),
  );
}

function authority(message: string) {
  const permission = new AbortController();
  return {
    assertCurrent: vi.fn(() => permission.signal.throwIfAborted()),
    revoke: () => permission.abort(new Error(message)),
  };
}

it.each([true, false])(
  "keeps scheduled-session schema independent of authority: %s",
  async (scheduled) => {
    const channels: PreparedMessageToolCatalog["channels"] = ["signal", "discord"].map((id) => ({
      id,
      reconcilesUnknownSend: false,
      actions: {
        describeMessageTool: () => ({ actions: id === "signal" ? ["send"] : ["send", "poll"] }),
      },
    }));
    const config: OpenClawConfig = {
      bindings: [{ agentId: "main", match: { channel: "signal" } }],
      channels: { signal: { enabled: true }, discord: { enabled: true } },
    };
    const capability = scheduled
      ? grant({ policy: { version: 1, mode: "trusted" }, assertCurrent() {} })
      : undefined;
    const tool = await createMessageToolAsync({
      ...toolOptions(config, capability),
      currentChannelProvider: scheduled ? "signal" : undefined,
      preparedMessageToolCatalog: catalog(channels),
    });
    expect(tool.parameters).toHaveProperty("properties.action.enum", [
      "broadcast",
      "poll",
      "react",
      "send",
    ]);
    for (const property of ["pollQuestion", "pollOption", "pollMulti"]) {
      expect(tool.parameters).toHaveProperty(`properties.${property}`);
    }
  },
);

it.each([
  ["delivery", "async"],
  ["delivery", "sync"],
  ["scheduled", "async"],
  ["scheduled", "sync"],
] as const)(
  "preserves iMessage non-default %s account capabilities across recovery sources (%s)",
  async (binding, factory) => {
    const createTool = factory === "sync" ? createMessageTool : createMessageToolAsync;
    const storePath = `${sessionDirs.make()}/sessions.json`;
    const key = binding === "scheduled" ? sessionKey : "agent:main:imessage:direct:peer";
    const config: OpenClawConfig = {
      session: { store: storePath },
      channels: {
        imessage: {
          cliPath: "imsg",
          defaultAccount: "default",
          accounts: { default: { actions: { edit: false } }, ops: { actions: { edit: true } } },
        },
      },
    };
    const policy = {
      version: 1 as const,
      mode: "account" as const,
      ownerSessionKey: "agent:main:main",
      ownerAccountId: "ops",
    };
    await replaceSessionEntry(
      { agentId: "main", sessionKey: key, storePath },
      {
        sessionId: "bound-session",
        updatedAt: 1,
        ...(binding === "delivery"
          ? {
              delivery: normalizeSessionDeliveryState({
                context: { channel: "imessage", to: "peer", accountId: "ops" },
              }),
            }
          : {
              cronRunContinuation: {
                lifecycleRevision: "revision",
                phase: "running" as const,
                scheduledToolPolicy: policy,
                scheduledToolCallerOrigin: { kind: "local" as const },
              },
            }),
      },
    );
    const channels = [
      {
        id: "imessage",
        reconcilesUnknownSend: false,
        actions: resolveBundledChannelMessageToolDiscoveryAdapter("imessage"),
      },
    ];
    const options = {
      config,
      agentId: "main",
      agentSessionKey: key,
      sessionId: "bound-session",
      preparedMessageToolCatalog: catalog(channels),
    };
    const normal = await createTool({
      ...options,
      currentChannelProvider: "imessage",
      agentAccountId: "ops",
      ...(binding === "scheduled"
        ? {
            messageActionTurnCapability: grant({
              policy: { ...policy, ownerOrigin: { kind: "local" as const } },
              assertCurrent() {},
            }),
          }
        : {}),
    });
    expect(normal.parameters).toHaveProperty(
      "properties.action.enum",
      expect.arrayContaining(["edit"]),
    );
    const recovered = await createTool({
      ...options,
      currentChannelProvider: "webchat",
      agentAccountId: "default",
      currentMessageId: "recovery",
      requesterSenderId: "different-sender",
    });
    expect(recovered.parameters).toEqual(normal.parameters);
    expect(recovered.description).toBe(normal.description);
  },
);

it("separates generic sends, source reads, and simulated writes", async () => {
  const message = authority("message authority expired");
  const source = authority("source authorization expired");
  const capability = grant({
    policy: { version: 1, mode: "trusted" },
    assertCurrent: message.assertCurrent,
    assertSourceCurrent: source.assertCurrent,
  });
  const boundary = new Error("generic send reached outbound dispatch");
  registerDiscord(["send", "read"]);
  const config: OpenClawConfig = { channels: { discord: { token: "fixture-token" } } };
  vi.spyOn(messageActionRunner, "runMessageAction").mockImplementation(async (input) => {
    if (input.params.dryRun === true) {
      message.revoke();
      return {
        kind: "send",
        channel: "discord",
        action: "send",
        to: target,
        handledBy: "plugin",
        payload: { ok: true },
        dryRun: true,
      };
    }
    throw boundary;
  });
  const tool = createMessageTool(toolOptions(config, capability));

  const execute = (callId: string, params: Record<string, unknown>) =>
    tool.execute(callId, { channel: "discord", target, ...params });
  source.revoke();
  await expect(execute("send", { action: "send", message: "Hello" })).rejects.toBe(boundary);
  await expect(execute("read", { action: "read" })).rejects.toThrow("source authorization expired");
  expect(message.assertCurrent).toHaveBeenCalled();
  expect(source.assertCurrent).toHaveBeenCalledOnce();
  await expect(
    execute("dry-run", { action: "send", message: "Hello", dryRun: true }),
  ).rejects.toThrow("message authority expired");
});

it.each([
  ["edit", "ops"],
  ["send", "delivery"],
] as const)("selects the scheduled %s account %s", async (action, account) => {
  const capability = grant({
    policy: {
      version: 1,
      mode: "account",
      ownerSessionKey: "agent:main:discord:channel:creator",
      ownerAccountId: "ops",
      ownerOrigin: { kind: "external", channel: "discord" },
    },
    assertCurrent() {},
  });
  registerDiscord(["send", "edit"], {
    listAccountIds: (cfg) => Object.keys(cfg.channels?.discord?.accounts ?? {}),
    resolveAccount: (cfg, id) => cfg.channels?.discord?.accounts?.[id ?? "delivery"],
  });
  const discord: NonNullable<OpenClawConfig["channels"]>["discord"] = {
    enabled: true,
    defaultAccount: "delivery",
    accounts: {
      ops: { token: { source: "env", provider: "default", id: "OPS_TOKEN" } },
      delivery: { token: { source: "env", provider: "default", id: "DELIVERY_TOKEN" } },
    },
  };
  const config: OpenClawConfig = { channels: { discord } };
  const secretScopes: Array<ReadonlySet<string> | undefined> = [];
  const defaultAccounts: Array<string | undefined> = [];
  const outboundBoundary = new Error("account selection observed at the outbound boundary");
  vi.spyOn(commandSecretGateway, "resolveCommandSecretRefsViaGateway").mockImplementation(
    async ({ config: resolvedConfig, allowedPaths }) => {
      secretScopes.push(allowedPaths);
      return resolvedMessageSecrets(resolvedConfig);
    },
  );
  vi.spyOn(messageActionRunner, "runMessageAction").mockImplementation(
    async ({ defaultAccountId }) => {
      defaultAccounts.push(defaultAccountId);
      throw outboundBoundary;
    },
  );
  const tool = createMessageTool({
    ...toolOptions(config, capability),
    agentAccountId: "delivery",
  });

  await expect(
    tool.execute("scheduled-write-account", {
      action,
      channel: "discord",
      target,
      ...(action === "send" ? {} : { messageId: "100000000000000002" }),
      message: "Updated scheduled message",
    }),
  ).rejects.toBe(outboundBoundary);
  expect({ secretScopes, defaultAccounts }).toEqual({
    secretScopes: [
      new Set(["channels.discord.token", `channels.discord.accounts.${account}.token`]),
    ],
    defaultAccounts: [account],
  });
});
