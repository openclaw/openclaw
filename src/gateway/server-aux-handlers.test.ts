import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  activateSecretsRuntimeSnapshot,
  clearSecretsRuntimeSnapshot,
  getActiveSecretsRuntimeSnapshot,
  type PreparedSecretsRuntimeSnapshot,
} from "../secrets/runtime.js";
import type { GatewayReloadPlan } from "./config-reload.js";
import { createGatewayAuxHandlers } from "./server-aux-handlers.js";

function asConfig(value: unknown): OpenClawConfig {
  return value as OpenClawConfig;
}

function createReloadPlan(overrides?: Partial<GatewayReloadPlan>): GatewayReloadPlan {
  return {
    changedPaths: overrides?.changedPaths ?? [],
    restartGateway: overrides?.restartGateway ?? false,
    restartReasons: overrides?.restartReasons ?? [],
    hotReasons: overrides?.hotReasons ?? [],
    reloadHooks: overrides?.reloadHooks ?? false,
    restartGmailWatcher: overrides?.restartGmailWatcher ?? false,
    restartCron: overrides?.restartCron ?? false,
    restartHeartbeat: overrides?.restartHeartbeat ?? false,
    restartHealthMonitor: overrides?.restartHealthMonitor ?? false,
    restartChannels: overrides?.restartChannels ?? new Set(),
    noopPaths: overrides?.noopPaths ?? [],
  };
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

afterEach(() => {
  clearSecretsRuntimeSnapshot();
  delete process.env.OPENCLAW_SKIP_CHANNELS;
  delete process.env.OPENCLAW_SKIP_PROVIDERS;
});

describe("gateway aux handlers", () => {
  it("restarts only channels whose resolved secret-backed config changed on secrets.reload", async () => {
    const buildReloadPlan = vi.fn().mockReturnValue(
      createReloadPlan({
        restartChannels: new Set(["slack", "zalo"]),
      }),
    );
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
    const prepared = createSnapshot(
      asConfig({
        channels: {
          slack: { signingSecret: "new-slack-secret" },
          zalo: { webhookSecret: "new-zalo-secret" },
          discord: { token: "unchanged-discord-token" },
        },
      }),
    );
    const activateRuntimeSecrets = vi.fn().mockImplementation(async () => {
      activateSecretsRuntimeSnapshot(prepared);
      return prepared;
    });
    const stopChannel = vi.fn().mockResolvedValue(undefined);
    const startChannel = vi.fn().mockResolvedValue(undefined);
    const respond = vi.fn();

    const { extraHandlers } = createGatewayAuxHandlers({
      log: {},
      activateRuntimeSecrets,
      buildReloadPlan,
      sharedGatewaySessionGenerationState: { current: undefined, required: null },
      resolveSharedGatewaySessionGenerationForConfig: () => undefined,
      clients: [],
      startChannel,
      stopChannel,
      logChannels: { info: vi.fn() },
    });

    await invokeSecretsReload({ handlers: extraHandlers, respond });

    expect(activateRuntimeSecrets).toHaveBeenCalledTimes(1);
    expect(buildReloadPlan).toHaveBeenCalledWith([
      "channels.slack.signingSecret",
      "channels.zalo.webhookSecret",
    ]);
    expect(stopChannel.mock.calls.map(([ch]) => ch).toSorted((a, b) => a.localeCompare(b))).toEqual(
      ["slack", "zalo"],
    );
    expect(
      startChannel.mock.calls.map(([ch]) => ch).toSorted((a, b) => a.localeCompare(b)),
    ).toEqual(["slack", "zalo"]);
    expect(respond).toHaveBeenCalledWith(true, { ok: true, warningCount: 0 });
  });

  it("coalesces concurrent secrets.reload calls so channels are not restarted twice", async () => {
    const buildReloadPlan = vi.fn().mockReturnValue(
      createReloadPlan({
        restartChannels: new Set(["slack"]),
      }),
    );
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
    const activationOrder: string[] = [];
    const activateRuntimeSecrets = vi.fn().mockImplementationOnce(async () => {
      activationOrder.push("first-start");
      // Yield the event loop to let a concurrent caller enter if the
      // handler were not serialized.
      await Promise.resolve();
      await Promise.resolve();
      activateSecretsRuntimeSnapshot(preparedFirst);
      activationOrder.push("first-end");
      return preparedFirst;
    });
    const stopChannel = vi.fn().mockResolvedValue(undefined);
    const startChannel = vi.fn().mockResolvedValue(undefined);
    const respond = vi.fn();

    const { extraHandlers } = createGatewayAuxHandlers({
      log: {},
      activateRuntimeSecrets,
      buildReloadPlan,
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

    expect(activationOrder).toEqual(["first-start", "first-end"]);
    expect(activateRuntimeSecrets).toHaveBeenCalledTimes(1);
    expect(stopChannel.mock.calls).toEqual([["slack"]]);
    expect(startChannel.mock.calls).toEqual([["slack"]]);
    expect(respond).toHaveBeenNthCalledWith(1, true, { ok: true, warningCount: 0 });
    expect(respond).toHaveBeenNthCalledWith(2, true, { ok: true, warningCount: 0 });
  });

  it("rolls back stopped channels when a later restart fails", async () => {
    const buildReloadPlan = vi.fn().mockReturnValue(
      createReloadPlan({
        restartChannels: new Set(["slack", "zalo"]),
      }),
    );
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
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(async () => {
        throw new Error("zalo refused to start");
      })
      .mockResolvedValue(undefined);
    const logChannelsInfo = vi.fn();
    const respond = vi.fn();

    const { extraHandlers } = createGatewayAuxHandlers({
      log: {},
      activateRuntimeSecrets,
      buildReloadPlan,
      sharedGatewaySessionGenerationState: { current: undefined, required: null },
      resolveSharedGatewaySessionGenerationForConfig: () => undefined,
      clients: [],
      startChannel,
      stopChannel,
      logChannels: { info: logChannelsInfo },
    });

    await invokeSecretsReload({ handlers: extraHandlers, respond });

    expect(stopChannel.mock.calls).toEqual([["slack"], ["zalo"], ["slack"]]);
    expect(startChannel.mock.calls).toEqual([["slack"], ["zalo"], ["slack"], ["zalo"]]);
    expect(
      logChannelsInfo.mock.calls.some(([msg]) =>
        String(msg).startsWith("failed to restart zalo channel after secrets reload"),
      ),
    ).toBe(true);
    expect(
      logChannelsInfo.mock.calls.some(([msg]) =>
        String(msg).startsWith("rolling back slack channel after secrets reload failure"),
      ),
    ).toBe(true);
    expect(
      logChannelsInfo.mock.calls.some(([msg]) =>
        String(msg).startsWith("rolling back zalo channel after secrets reload failure"),
      ),
    ).toBe(true);
    // The handler surfaces the partial-failure so the caller can retry/alert
    // instead of treating a swallowed restart error as a successful rotation.
    expect(respond.mock.calls).toHaveLength(1);
    const [okFlag, successPayload, errorPayload] = respond.mock.calls[0];
    expect(okFlag).toBe(false);
    expect(successPayload).toBeUndefined();
    expect(String(errorPayload?.message ?? "")).toBe("secrets.reload failed");
    expect(getActiveSecretsRuntimeSnapshot()?.config).toEqual(
      asConfig({
        channels: {
          slack: { signingSecret: "old-slack-secret" },
          zalo: { webhookSecret: "old-zalo-secret" },
        },
      }),
    );
  });

  it("fails reload when channel restarts are required but skip flags block them", async () => {
    const buildReloadPlan = vi.fn().mockReturnValue(
      createReloadPlan({
        restartChannels: new Set(["slack"]),
      }),
    );
    process.env.OPENCLAW_SKIP_CHANNELS = "1";
    activateSecretsRuntimeSnapshot(
      createSnapshot(
        asConfig({
          channels: {
            slack: { signingSecret: "old-slack-secret" },
          },
        }),
      ),
    );
    const activateRuntimeSecrets = vi.fn().mockResolvedValue(
      createSnapshot(
        asConfig({
          channels: {
            slack: { signingSecret: "new-slack-secret" },
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
      buildReloadPlan,
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
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "UNAVAILABLE",
        message: "secrets.reload failed",
      }),
    );
    expect(getActiveSecretsRuntimeSnapshot()?.config).toEqual(
      asConfig({
        channels: {
          slack: { signingSecret: "old-slack-secret" },
        },
      }),
    );
  });

  it("does not restart channels when resolved secrets do not change channel config", async () => {
    const buildReloadPlan = vi.fn().mockReturnValue(createReloadPlan());
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
      buildReloadPlan,
      sharedGatewaySessionGenerationState: { current: undefined, required: null },
      resolveSharedGatewaySessionGenerationForConfig: () => undefined,
      clients: [],
      startChannel,
      stopChannel,
      logChannels: { info: vi.fn() },
    });

    await invokeSecretsReload({ handlers: extraHandlers, respond });

    expect(buildReloadPlan).toHaveBeenCalledWith(["gateway.auth.token"]);
    expect(stopChannel).not.toHaveBeenCalled();
    expect(startChannel).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(true, { ok: true, warningCount: 0 });
  });
});
