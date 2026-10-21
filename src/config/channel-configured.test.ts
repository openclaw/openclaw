import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import { isChannelConfigured } from "./channel-configured.js";
import type { OpenClawConfig } from "./types.openclaw.js";

const bundledPlugins = vi.hoisted(() => ({
  getBundledChannelPlugin: vi.fn<() => ChannelPlugin | undefined>(),
  getBundledChannelSetupPlugin: vi.fn<() => ChannelPlugin | undefined>(),
}));

vi.mock("../channels/plugins/bundled.js", () => ({
  ...bundledPlugins,
  getBundledChannelSecrets: () => undefined,
  getBundledChannelSetupSecrets: () => undefined,
}));

function configuredStatePlugin(
  id: string,
  hasConfiguredState: NonNullable<ChannelPlugin["config"]["hasConfiguredState"]>,
): ChannelPlugin {
  return {
    id,
    meta: { id, label: id, selectionLabel: id, docsPath: "/testing", blurb: "Fixture" },
    capabilities: { chatTypes: ["direct"] },
    config: { listAccountIds: () => ["default"], resolveAccount: () => ({}), hasConfiguredState },
  };
}

function configured(channel: string, config: OpenClawConfig["channels"], env = {}) {
  return isChannelConfigured({ channels: config }, channel, env);
}

describe("isChannelConfigured", () => {
  beforeEach(() => {
    bundledPlugins.getBundledChannelPlugin.mockReset();
    bundledPlugins.getBundledChannelSetupPlugin.mockReset();
  });

  afterEach(() => vi.unstubAllEnvs());

  it("detects Telegram env configuration through the package metadata seam", () => {
    expect(isChannelConfigured({}, "telegram", { TELEGRAM_BOT_TOKEN: "token" })).toBe(true);
  });

  it("detects Discord env configuration through the package metadata seam", () => {
    expect(isChannelConfigured({}, "discord", { DISCORD_BOT_TOKEN: "token" })).toBe(true);
  });

  it("requires both Slack identity and transport tokens through the package metadata seam", () => {
    expect(isChannelConfigured({}, "slack", { SLACK_BOT_TOKEN: "xoxb-test" })).toBe(false);
    expect(
      isChannelConfigured({}, "slack", {
        SLACK_BOT_TOKEN: "xoxb-test",
        SLACK_APP_TOKEN: "xapp-test",
      }),
    ).toBe(true);
  });

  it("requires both IRC host and nick env vars through the package metadata seam", () => {
    expect(isChannelConfigured({}, "irc", { IRC_HOST: "irc.example.com" })).toBe(false);
    expect(
      isChannelConfigured({}, "irc", {
        IRC_HOST: "irc.example.com",
        IRC_NICK: "openclaw",
      }),
    ).toBe(true);
  });

  it("requires both Mattermost URL and token env vars through the package metadata seam", () => {
    const token = { MATTERMOST_BOT_TOKEN: "token" };
    const url = { MATTERMOST_URL: "https://mattermost.example.test" };
    expect(isChannelConfigured({}, "mattermost", token)).toBe(false);
    expect(isChannelConfigured({}, "mattermost", url)).toBe(false);
    expect(isChannelConfigured({}, "mattermost", { ...token, ...url })).toBe(true);
  });

  it("still falls back to generic config presence for channels without a custom hook", () => {
    expect(
      configured("signal", { signal: { transport: { kind: "managed-native", httpPort: 8080 } } }),
    ).toBe(true);
  });

  it("treats explicit enabled channel config as configured state", () => {
    expect(
      isChannelConfigured(
        {
          channels: {
            "openclaw-weixin": {
              enabled: true,
            },
          },
        },
        "openclaw-weixin",
        {},
      ),
    ).toBe(true);
  });

  it("does not treat disabled channel config as configured state", () => {
    expect(configured("openclaw-weixin", { "openclaw-weixin": { enabled: false } })).toBe(false);
  });

  it("honors Matrix bootstrap metadata without consulting operational credential hooks", () => {
    vi.stubEnv("MATRIX_HOMESERVER", "https://ambient.matrix.example");
    const hasConfiguredState = vi.fn(() => {
      throw new Error("operational credential storage must not be read during bootstrap");
    });
    bundledPlugins.getBundledChannelPlugin.mockReturnValue(
      configuredStatePlugin("matrix", () => false),
    );
    bundledPlugins.getBundledChannelSetupPlugin.mockReturnValue(
      configuredStatePlugin("matrix", hasConfiguredState),
    );

    expect(
      isChannelConfigured({}, "matrix", { OPENCLAW_STATE_DIR: "state-with-matrix-creds" }),
    ).toBe(false);
    expect(isChannelConfigured({}, "matrix", { MATRIX_ACCESS_TOKEN: "fixture-token" })).toBe(true);
    expect(
      configured("matrix", { matrix: { homeserver: "https://configured.matrix.example" } }),
    ).toBe(true);
    expect(hasConfiguredState).not.toHaveBeenCalled();
  });

  it("retains setup bootstrap hooks when no configured-state metadata is declared", () => {
    const hasConfiguredState = vi.fn(
      ({ env }: { env?: NodeJS.ProcessEnv }) => env?.FIXTURE_TOKEN === "configured",
    );
    bundledPlugins.getBundledChannelPlugin.mockReturnValue(
      configuredStatePlugin("fixture", () => false),
    );
    bundledPlugins.getBundledChannelSetupPlugin.mockReturnValue(
      configuredStatePlugin("fixture", hasConfiguredState),
    );
    const env = { FIXTURE_TOKEN: "configured" };

    expect(isChannelConfigured({}, "fixture", env)).toBe(true);
    expect(hasConfiguredState).toHaveBeenCalledWith({ cfg: {}, env });
    expect(isChannelConfigured({}, "fixture", {})).toBe(false);
  });
});
