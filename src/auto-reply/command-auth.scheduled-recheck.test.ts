import { beforeEach, describe, expect, it, vi } from "vitest";
import { getLoadedChannelPluginForRead } from "../channels/plugins/registry-loaded.js";
import { getChannelPlugin } from "../channels/plugins/registry.js";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  rollbackStagedPluginRegistry,
  stageActivePluginRegistry,
} from "../plugins/runtime.js";
import { createChannelTestPluginBase } from "../test-utils/channel-plugins.js";
import { isCommandsAllowFromAuthorized } from "./command-auth.js";

// No live transport: the prefixed-entry normalizer comes only from the bundled lookup.
const bundled = vi.hoisted(() => ({
  getBundledChannelPlugin: vi.fn<(id: string) => ChannelPlugin | undefined>(),
}));

vi.mock("../channels/plugins/bundled.js", async (importActual) => ({
  ...(await importActual<typeof import("../channels/plugins/bundled.js")>()),
  getBundledChannelPlugin: bundled.getBundledChannelPlugin,
}));

const CHANNEL = "discord";

function prefixNormalizingPlugin(): ChannelPlugin {
  return createChannelTestPluginBase({
    id: CHANNEL,
    config: {
      formatAllowFrom: ({ allowFrom }: { allowFrom: Array<string | number> }) =>
        allowFrom.map((entry) => String(entry).replace(/^discord:/i, "")),
    },
  }) as ChannelPlugin;
}

const allowFromConfig = (allowFrom: Record<string, Array<string | number>>): OpenClawConfig => ({
  commands: { allowFrom },
});

const requester = { channel: CHANNEL, senderId: "100" };

describe("isCommandsAllowFromAuthorized re-evaluates retained scheduled work", () => {
  beforeEach((ctx) => {
    const previous = captureActivePluginRegistrySnapshot();
    ctx.onTestFinished(() => {
      rollbackStagedPluginRegistry(previous);
    });
    // No channel transport is loaded for this occurrence; only the bundled fallback is available.
    stageActivePluginRegistry(createEmptyPluginRegistry(), null, "default");
    bundled.getBundledChannelPlugin.mockReset();
    bundled.getBundledChannelPlugin.mockImplementation((id: string) =>
      id === CHANNEL ? prefixNormalizingPlugin() : undefined,
    );
  });

  it("resolves the normalizer from the bundled fallback when the transport is not loaded", () => {
    expect(getLoadedChannelPluginForRead(CHANNEL)).toBeUndefined();
    expect(typeof getChannelPlugin(CHANNEL)?.config?.formatAllowFrom).toBe("function");
  });

  it("authorizes a prefixed allowFrom entry that normalizes to the requester via the bundled plugin", () => {
    expect(
      isCommandsAllowFromAuthorized(allowFromConfig({ [CHANNEL]: ["discord:100"] }), requester),
    ).toBe(true);
  });

  it("still refuses when a prefixed entry normalizes to a different id", () => {
    expect(
      isCommandsAllowFromAuthorized(allowFromConfig({ [CHANNEL]: ["discord:999"] }), requester),
    ).toBe(false);
  });

  it("falls back to the global list when the requester's provider has none", () => {
    expect(isCommandsAllowFromAuthorized(allowFromConfig({ "*": ["100"] }), requester)).toBe(true);
    expect(isCommandsAllowFromAuthorized(allowFromConfig({ "*": ["999"] }), requester)).toBe(false);
  });

  it("authorizes a wildcard provider list", () => {
    expect(isCommandsAllowFromAuthorized(allowFromConfig({ [CHANNEL]: ["*"] }), requester)).toBe(
      true,
    );
  });

  it("re-authorizes the next occurrence once the requester is listed again", () => {
    expect(isCommandsAllowFromAuthorized(allowFromConfig({ [CHANNEL]: ["999"] }), requester)).toBe(
      false,
    );
    expect(
      isCommandsAllowFromAuthorized(allowFromConfig({ [CHANNEL]: ["discord:100"] }), requester),
    ).toBe(true);
  });
});
