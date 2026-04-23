import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  activateSecretsRuntimeSnapshot,
  clearSecretsRuntimeSnapshot,
  type PreparedSecretsRuntimeSnapshot,
} from "../secrets/runtime.js";
import { createGatewayAuxHandlers } from "./server-aux-handlers.js";

function asConfig(value: unknown): OpenClawConfig {
  return value as OpenClawConfig;
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
    expect(stopChannel.mock.calls).toEqual([["slack"], ["zalo"]]);
    expect(startChannel.mock.calls).toEqual([["slack"], ["zalo"]]);
    expect(respond).toHaveBeenCalledWith(true, { ok: true, warningCount: 0 });
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
