import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import {
  activateSecretsRuntimeSnapshot,
  clearSecretsRuntimeSnapshot,
  type PreparedSecretsRuntimeSnapshot,
} from "../secrets/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../test-utils/channel-plugins.js";
import { createGatewayAuxHandlers } from "./server-aux-handlers.js";

function asConfig(value: unknown): OpenClawConfig {
  return value as OpenClawConfig;
}

function makeChannelPluginWithReloadPrefix(id: "slack" | "zalo" | "discord"): ChannelPlugin {
  const plugin = createChannelTestPluginBase({ id, label: id }) as ChannelPlugin;
  plugin.reload = { configPrefixes: [`channels.${id}`] };
  return plugin;
}

function registerChannelPluginsWithReloadPrefixes(): void {
  // Channel reload-plan entries come from the active plugin registry via
  // `listChannelPlugins()`. Unit tests start with an empty registry, so we
  // register slack/zalo/discord channel plugins whose `reload.configPrefixes`
  // map `channels.<id>.*` diff paths to `restart-channel:<id>` actions. Without
  // this, `channels.slack.signingSecret` would fall through to the default
  // gateway-restart rule and skip the per-channel restart branch entirely.
  const plugins: ChannelPlugin[] = [
    makeChannelPluginWithReloadPrefix("slack"),
    makeChannelPluginWithReloadPrefix("zalo"),
    makeChannelPluginWithReloadPrefix("discord"),
  ];
  setActivePluginRegistry(
    createTestRegistry(
      plugins.map((plugin) => ({ pluginId: plugin.id, plugin, source: "test" })),
    ),
  );
}

function createSnapshot(config: OpenClawConfig): PreparedSecretsRuntimeSnapshot {
  return {
    sourceConfig: asConfig({}),
    config,
    authStores: [],
    warnings: [],
    webTools: {
      search: { providerSource: "none", diagnostics: [] },
      fetch: { providerSource: "none", diagnostics: [] },
      diagnostics: [],
    },
  };
}

async function invokeSecretsReload(params: {
  handlers: ReturnType<typeof createGatewayAuxHandlers>["extraHandlers"];
  respond: ReturnType<typeof vi.fn>;
}) {
  await params.handlers["secrets.reload"]({
    req: { type: "req", id: "1", method: "secrets.reload" },
    params: {},
    client: null,
    isWebchatConnect: () => false,
    respond: params.respond as Parameters<
      ReturnType<typeof createGatewayAuxHandlers>["extraHandlers"]["secrets.reload"]
    >[0]["respond"],
    context: {} as never,
  });
}

beforeEach(() => {
  registerChannelPluginsWithReloadPrefixes();
});

afterEach(() => {
  clearSecretsRuntimeSnapshot();
  setActivePluginRegistry(createTestRegistry());
  delete process.env.OPENCLAW_SKIP_CHANNELS;
  delete process.env.OPENCLAW_SKIP_PROVIDERS;
});

describe("gateway aux handlers", () => {
  it("restarts only channels whose resolved secret-backed config changed on secrets.reload", async () => {
    activateSecretsRuntimeSnapshot(
      createSnapshot(
        asConfig({
          channels: {
            slack: { signingSecret: "old-slack-secret" },
            zalo: { webhookSecret: "old-zalo-secret" },
            discord: { token: "unchanged-discord-token" },
          },
        }),
      ),
    );
    const activateRuntimeSecrets = vi.fn().mockResolvedValue(
      createSnapshot(
        asConfig({
          channels: {
            slack: { signingSecret: "new-slack-secret" },
            zalo: { webhookSecret: "new-zalo-secret" },
            discord: { token: "unchanged-discord-token" },
          },
        }),
      ),
    );
    const stopChannel = vi.fn().mockResolvedValue(undefined);
    const startChannel = vi.fn().mockResolvedValue(undefined);
    const respond = vi.fn();

    const { extraHandlers } = createGatewayAuxHandlers({
      log: {},
      activateRuntimeSecrets,
      sharedGatewaySessionGenerationState: { current: undefined, required: null },
      resolveSharedGatewaySessionGenerationForConfig: () => undefined,
      clients: [],
      startChannel,
      stopChannel,
      logChannels: { info: vi.fn() },
    });

    await invokeSecretsReload({ handlers: extraHandlers, respond });

    expect(activateRuntimeSecrets).toHaveBeenCalledTimes(1);
    // Assertion is order-independent: plan.restartChannels iterates in Set
    // insertion order, which in turn depends on diff/plugin iteration order
    // that is not a stable contract of this handler.
    expect(stopChannel.mock.calls.map(([ch]) => ch).toSorted()).toEqual(["slack", "zalo"]);
    expect(startChannel.mock.calls.map(([ch]) => ch).toSorted()).toEqual(["slack", "zalo"]);
    expect(respond).toHaveBeenCalledWith(true, { ok: true, warningCount: 0 });
  });

  it("serializes concurrent secrets.reload calls so channels are not restarted twice", async () => {
    const initialActive = createSnapshot(
      asConfig({
        channels: {
          slack: { signingSecret: "old-slack-secret" },
        },
      }),
    );
    activateSecretsRuntimeSnapshot(initialActive);

    const preparedFirst = createSnapshot(
      asConfig({
        channels: {
          slack: { signingSecret: "new-slack-secret" },
        },
      }),
    );
    // The second activation has no further changes — a concurrent caller
    // that raced past activation without serialization would still see the
    // pre-first-activation snapshot and trigger another restart.
    const preparedSecond = createSnapshot(
      asConfig({
        channels: {
          slack: { signingSecret: "new-slack-secret" },
        },
      }),
    );
    const activationOrder: string[] = [];
    const activateRuntimeSecrets = vi
      .fn()
      .mockImplementationOnce(async () => {
        activationOrder.push("first-start");
        // Yield the event loop to let a concurrent caller enter if the
        // handler were not serialized.
        await Promise.resolve();
        await Promise.resolve();
        activateSecretsRuntimeSnapshot(preparedFirst);
        activationOrder.push("first-end");
        return preparedFirst;
      })
      .mockImplementationOnce(async () => {
        activationOrder.push("second-start");
        activateSecretsRuntimeSnapshot(preparedSecond);
        activationOrder.push("second-end");
        return preparedSecond;
      });
    const stopChannel = vi.fn().mockResolvedValue(undefined);
    const startChannel = vi.fn().mockResolvedValue(undefined);
    const respond = vi.fn();

    const { extraHandlers } = createGatewayAuxHandlers({
      log: {},
      activateRuntimeSecrets,
      sharedGatewaySessionGenerationState: { current: undefined, required: null },
      resolveSharedGatewaySessionGenerationForConfig: () => undefined,
      clients: [],
      startChannel,
      stopChannel,
      logChannels: { info: vi.fn() },
    });

    await Promise.all([
      invokeSecretsReload({ handlers: extraHandlers, respond }),
      invokeSecretsReload({ handlers: extraHandlers, respond }),
    ]);

    expect(activationOrder).toEqual([
      "first-start",
      "first-end",
      "second-start",
      "second-end",
    ]);
    expect(stopChannel.mock.calls).toEqual([["slack"]]);
    expect(startChannel.mock.calls).toEqual([["slack"]]);
  });

  it("isolates per-channel restart failures, then surfaces an error so partial rotation is visible", async () => {
    activateSecretsRuntimeSnapshot(
      createSnapshot(
        asConfig({
          channels: {
            slack: { signingSecret: "old-slack-secret" },
            zalo: { webhookSecret: "old-zalo-secret" },
          },
        }),
      ),
    );
    const activateRuntimeSecrets = vi.fn().mockResolvedValue(
      createSnapshot(
        asConfig({
          channels: {
            slack: { signingSecret: "new-slack-secret" },
            zalo: { webhookSecret: "new-zalo-secret" },
          },
        }),
      ),
    );
    const stopChannel = vi.fn().mockResolvedValue(undefined);
    const startChannel = vi
      .fn()
      .mockImplementationOnce(async () => {
        throw new Error("slack refused to start");
      })
      .mockResolvedValue(undefined);
    const logChannelsInfo = vi.fn();
    const respond = vi.fn();

    const { extraHandlers } = createGatewayAuxHandlers({
      log: {},
      activateRuntimeSecrets,
      sharedGatewaySessionGenerationState: { current: undefined, required: null },
      resolveSharedGatewaySessionGenerationForConfig: () => undefined,
      clients: [],
      startChannel,
      stopChannel,
      logChannels: { info: logChannelsInfo },
    });

    await invokeSecretsReload({ handlers: extraHandlers, respond });

    // Both channels were attempted even though slack's startChannel threw,
    // so zalo still got its rotation applied.
    expect(stopChannel.mock.calls.map(([ch]) => ch).toSorted()).toEqual(["slack", "zalo"]);
    expect(startChannel.mock.calls.map(([ch]) => ch).toSorted()).toEqual(["slack", "zalo"]);
    expect(
      logChannelsInfo.mock.calls.some(([msg]) =>
        String(msg).startsWith("failed to restart slack channel after secrets reload"),
      ),
    ).toBe(true);
    // The handler surfaces the partial-failure so the caller can retry/alert
    // instead of treating a swallowed restart error as a successful rotation.
    expect(respond.mock.calls).toHaveLength(1);
    const [okFlag, successPayload, errorPayload] = respond.mock.calls[0];
    expect(okFlag).toBe(false);
    expect(successPayload).toBeUndefined();
    expect(String(errorPayload?.message ?? "")).toContain("slack");
  });

  it("does not restart channels when resolved secrets do not change channel config", async () => {
    activateSecretsRuntimeSnapshot(
      createSnapshot(
        asConfig({
          gateway: {
            auth: { mode: "token", token: "old-token" },
          },
          channels: {
            slack: { signingSecret: "same-secret" },
          },
        }),
      ),
    );
    const activateRuntimeSecrets = vi.fn().mockResolvedValue(
      createSnapshot(
        asConfig({
          gateway: {
            auth: { mode: "token", token: "new-token" },
          },
          channels: {
            slack: { signingSecret: "same-secret" },
          },
        }),
      ),
    );
    const stopChannel = vi.fn().mockResolvedValue(undefined);
    const startChannel = vi.fn().mockResolvedValue(undefined);
    const respond = vi.fn();

    const { extraHandlers } = createGatewayAuxHandlers({
      log: {},
      activateRuntimeSecrets,
      sharedGatewaySessionGenerationState: { current: undefined, required: null },
      resolveSharedGatewaySessionGenerationForConfig: () => undefined,
      clients: [],
      startChannel,
      stopChannel,
      logChannels: { info: vi.fn() },
    });

    await invokeSecretsReload({ handlers: extraHandlers, respond });

    expect(stopChannel).not.toHaveBeenCalled();
    expect(startChannel).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(true, { ok: true, warningCount: 0 });
  });
});
