// Control UI tests cover app channels behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChannelsStatusSnapshot } from "../../api/types.ts";
import type { RuntimeConfigCapability } from "../../lib/config/index.ts";
import { handleChannelConfigReload, handleChannelConfigSave } from "./actions.ts";
import type { ChannelsState } from "./data.ts";

type ChannelsActionHostForTest = ChannelsState & {
  hello?: { auth?: { deviceToken?: string | null } | null } | null;
  password?: string;
  settings: { token?: string };
  nostrProfileFormState: null;
  nostrProfileAccountId: string | null;
};
type ConfigCapabilityForTest = Pick<RuntimeConfigCapability, "refresh" | "save" | "state">;

function createChannelsSnapshot(name = "saved"): ChannelsStatusSnapshot {
  const nostrAccount = {
    accountId: "default",
    configured: true,
    profile: { name },
  } as ChannelsStatusSnapshot["channelAccounts"][string][number];
  return {
    ts: Date.now(),
    channelOrder: ["nostr"],
    channelLabels: { nostr: "Nostr" },
    channels: { nostr: { configured: true } },
    channelAccounts: {
      nostr: [nostrAccount],
    },
    channelDefaultAccountId: { nostr: "default" },
  };
}

function requireConfigSnapshot(
  config: ConfigCapabilityForTest,
): NonNullable<ConfigCapabilityForTest["state"]["configSnapshot"]> {
  if (!config.state.configSnapshot) {
    throw new Error("expected config snapshot");
  }
  return config.state.configSnapshot;
}

function createConfig(): ConfigCapabilityForTest {
  const state = {
    configForm: null,
    configFormDirty: false,
    configFormOriginal: null,
    configSnapshot: null,
    lastError: null,
  } as ConfigCapabilityForTest["state"];
  return {
    state,
    refresh: vi.fn(async () => undefined),
    save: vi.fn(async () => true),
  };
}

function createHost(request: ReturnType<typeof vi.fn> = vi.fn()): ChannelsActionHostForTest {
  return {
    channelsError: null,
    channelsLastSuccess: null,
    channelsLoading: false,
    channelsSnapshot: createChannelsSnapshot("old"),
    client: { request } as unknown as ChannelsState["client"],
    connected: true,
    nostrProfileAccountId: null,
    nostrProfileFormState: null,
    settings: {},
    whatsappBusy: false,
    whatsappLoginConnected: null,
    whatsappLoginMessage: null,
    whatsappLoginQrDataUrl: null,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("channel config actions", () => {
  it("discards stale dirty config state on explicit reload", async () => {
    const request = vi.fn().mockImplementation(async (method: string) => {
      if (method === "channels.status") {
        return createChannelsSnapshot();
      }
      return {};
    });
    const host = createHost(request);
    const config = createConfig();
    config.state.configFormDirty = true;
    config.state.configForm = { gateway: { mode: "local" } };
    vi.mocked(config.refresh).mockImplementation(async () => {
      config.state.configFormDirty = false;
      config.state.configForm = { gateway: { mode: "remote" } };
      config.state.configFormOriginal = { gateway: { mode: "remote" } };
    });

    await handleChannelConfigReload(host, config);

    expect(config.refresh).toHaveBeenCalledWith({ discardPendingChanges: true });
    expect(config.state.configFormDirty).toBe(false);
    expect(config.state.configForm).toEqual({ gateway: { mode: "remote" } });
    expect(config.state.configFormOriginal).toEqual({ gateway: { mode: "remote" } });
    expect(request).toHaveBeenCalledWith("channels.status", { probe: true, timeoutMs: 8000 });
  });

  it("keeps failed channel saves from discarding pending edits during recovery reload", async () => {
    const request = vi.fn().mockImplementation(async (method: string) => {
      if (method === "channels.status") {
        return createChannelsSnapshot();
      }
      return {};
    });
    const host = createHost(request);
    const config = createConfig();
    config.state.configSnapshot = { hash: "old-hash" };
    config.state.configFormDirty = true;
    config.state.configForm = { gateway: { mode: "local" } };
    vi.mocked(config.save).mockImplementation(async () => {
      config.state.lastError = "Error: Config hash mismatch";
      return false;
    });
    vi.mocked(config.refresh).mockImplementation(async () => {
      config.state.configSnapshot = {
        hash: "hash-new",
        config: { gateway: { mode: "remote" } },
      };
    });

    await handleChannelConfigSave(host, config);

    expect(config.save).toHaveBeenCalledTimes(1);
    expect(config.refresh).toHaveBeenCalledTimes(1);
    expect(config.state.lastError).toBe("Error: Config hash mismatch");
    expect(config.state.configFormDirty).toBe(true);
    expect(config.state.configForm).toEqual({ gateway: { mode: "local" } });
    expect(requireConfigSnapshot(config).config).toEqual({ gateway: { mode: "remote" } });
    expect(request).not.toHaveBeenCalledWith("channels.status", {
      probe: true,
      timeoutMs: 8000,
    });
  });
});
