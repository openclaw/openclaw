import { expect, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import {
  resolveDefaultLineAccountId,
  resolveLineAccount,
  listLineAccountIds,
} from "../../../line/accounts.js";
import { bundledChannelRuntimeSetters, requireBundledChannelPlugin } from "../bundled.js";
import type { ChannelPlugin } from "../types.js";

type PluginContractEntry = {
  id: string;
  plugin: Pick<ChannelPlugin, "id" | "meta" | "capabilities" | "config">;
};

type ActionsContractEntry = {
  id: string;
  plugin: Pick<ChannelPlugin, "id" | "actions">;
  unsupportedAction?: string;
  cases: Array<{
    name: string;
    cfg: OpenClawConfig;
    expectedActions: string[];
    expectedCapabilities?: string[];
    beforeTest?: () => void;
  }>;
};

type SetupContractEntry = {
  id: string;
  plugin: Pick<ChannelPlugin, "id" | "config" | "setup">;
  cases: Array<{
    name: string;
    cfg: OpenClawConfig;
    accountId?: string;
    input: Record<string, unknown>;
    expectedAccountId?: string;
    expectedValidation?: string | null;
    beforeTest?: () => void;
    assertPatchedConfig?: (cfg: OpenClawConfig) => void;
    assertResolvedAccount?: (account: unknown, cfg: OpenClawConfig) => void;
  }>;
};

type StatusContractEntry = {
  id: string;
  plugin: Pick<ChannelPlugin, "id" | "config" | "status">;
  cases: Array<{
    name: string;
    cfg: OpenClawConfig;
    accountId?: string;
    runtime?: Record<string, unknown>;
    probe?: unknown;
    beforeTest?: () => void;
    assertSnapshot?: (snapshot: Record<string, unknown>) => void;
    assertSummary?: (summary: Record<string, unknown>) => void;
  }>;
};

const telegramListActionsMock = vi.fn();
const telegramGetCapabilitiesMock = vi.fn();
const discordListActionsMock = vi.fn();
const discordGetCapabilitiesMock = vi.fn();

bundledChannelRuntimeSetters.setTelegramRuntime({
  channel: {
    telegram: {
      messageActions: {
        listActions: telegramListActionsMock,
        getCapabilities: telegramGetCapabilitiesMock,
      },
    },
  },
} as never);

bundledChannelRuntimeSetters.setDiscordRuntime({
  channel: {
    discord: {
      messageActions: {
        listActions: discordListActionsMock,
        getCapabilities: discordGetCapabilitiesMock,
      },
    },
  },
} as never);

bundledChannelRuntimeSetters.setLineRuntime({
  channel: {
    line: {
      listLineAccountIds,
      resolveDefaultLineAccountId,
      resolveLineAccount: ({ cfg, accountId }: { cfg: OpenClawConfig; accountId?: string }) =>
        resolveLineAccount({ cfg, accountId }),
    },
  },
} as never);

export const pluginContractRegistry: PluginContractEntry[] = [
  { id: "bluebubbles", plugin: requireBundledChannelPlugin("bluebubbles") },
  { id: "discord", plugin: requireBundledChannelPlugin("discord") },
  { id: "feishu", plugin: requireBundledChannelPlugin("feishu") },
  { id: "googlechat", plugin: requireBundledChannelPlugin("googlechat") },
  { id: "imessage", plugin: requireBundledChannelPlugin("imessage") },
  { id: "irc", plugin: requireBundledChannelPlugin("irc") },
  { id: "line", plugin: requireBundledChannelPlugin("line") },
  { id: "matrix", plugin: requireBundledChannelPlugin("matrix") },
  { id: "mattermost", plugin: requireBundledChannelPlugin("mattermost") },
  { id: "msteams", plugin: requireBundledChannelPlugin("msteams") },
  { id: "nextcloud-talk", plugin: requireBundledChannelPlugin("nextcloud-talk") },
  { id: "nostr", plugin: requireBundledChannelPlugin("nostr") },
  { id: "signal", plugin: requireBundledChannelPlugin("signal") },
  { id: "slack", plugin: requireBundledChannelPlugin("slack") },
  { id: "synology-chat", plugin: requireBundledChannelPlugin("synology-chat") },
  { id: "telegram", plugin: requireBundledChannelPlugin("telegram") },
  { id: "tlon", plugin: requireBundledChannelPlugin("tlon") },
  { id: "whatsapp", plugin: requireBundledChannelPlugin("whatsapp") },
  { id: "zalo", plugin: requireBundledChannelPlugin("zalo") },
  { id: "zalouser", plugin: requireBundledChannelPlugin("zalouser") },
];

export const actionContractRegistry: ActionsContractEntry[] = [
  {
    id: "slack",
    plugin: requireBundledChannelPlugin("slack"),
    unsupportedAction: "poll",
    cases: [
      {
        name: "configured account exposes default Slack actions",
        cfg: {
          channels: {
            slack: {
              botToken: "xoxb-test",
              appToken: "xapp-test",
            },
          },
        } as OpenClawConfig,
        expectedActions: [
          "send",
          "react",
          "reactions",
          "read",
          "edit",
          "delete",
          "download-file",
          "pin",
          "unpin",
          "list-pins",
          "member-info",
          "emoji-list",
        ],
        expectedCapabilities: ["blocks"],
      },
      {
        name: "interactive replies add the shared interactive capability",
        cfg: {
          channels: {
            slack: {
              botToken: "xoxb-test",
              appToken: "xapp-test",
              capabilities: {
                interactiveReplies: true,
              },
            },
          },
        } as OpenClawConfig,
        expectedActions: [
          "send",
          "react",
          "reactions",
          "read",
          "edit",
          "delete",
          "download-file",
          "pin",
          "unpin",
          "list-pins",
          "member-info",
          "emoji-list",
        ],
        expectedCapabilities: ["blocks", "interactive"],
      },
      {
        name: "missing tokens disables the actions surface",
        cfg: {
          channels: {
            slack: {
              enabled: true,
            },
          },
        } as OpenClawConfig,
        expectedActions: [],
        expectedCapabilities: [],
      },
    ],
  },
  {
    id: "mattermost",
    plugin: requireBundledChannelPlugin("mattermost"),
    unsupportedAction: "poll",
    cases: [
      {
        name: "configured account exposes send and react",
        cfg: {
          channels: {
            mattermost: {
              enabled: true,
              botToken: "test-token",
              baseUrl: "https://chat.example.com",
            },
          },
        } as OpenClawConfig,
        expectedActions: ["send", "react"],
        expectedCapabilities: ["buttons"],
      },
      {
        name: "reactions can be disabled while send stays available",
        cfg: {
          channels: {
            mattermost: {
              enabled: true,
              botToken: "test-token",
              baseUrl: "https://chat.example.com",
              actions: { reactions: false },
            },
          },
        } as OpenClawConfig,
        expectedActions: ["send"],
        expectedCapabilities: ["buttons"],
      },
      {
        name: "missing bot credentials disables the actions surface",
        cfg: {
          channels: {
            mattermost: {
              enabled: true,
            },
          },
        } as OpenClawConfig,
        expectedActions: [],
        expectedCapabilities: [],
      },
    ],
  },
  {
    id: "telegram",
    plugin: requireBundledChannelPlugin("telegram"),
    cases: [
      {
        name: "forwards runtime-backed Telegram actions and capabilities",
        cfg: {} as OpenClawConfig,
        expectedActions: ["send", "poll", "react"],
        expectedCapabilities: ["interactive", "buttons"],
        beforeTest: () => {
          telegramListActionsMock.mockReset();
          telegramGetCapabilitiesMock.mockReset();
          telegramListActionsMock.mockReturnValue(["send", "poll", "react"]);
          telegramGetCapabilitiesMock.mockReturnValue(["interactive", "buttons"]);
        },
      },
    ],
  },
  {
    id: "discord",
    plugin: requireBundledChannelPlugin("discord"),
    cases: [
      {
        name: "forwards runtime-backed Discord actions and capabilities",
        cfg: {} as OpenClawConfig,
        expectedActions: ["send", "react", "poll"],
        expectedCapabilities: ["interactive", "components"],
        beforeTest: () => {
          discordListActionsMock.mockReset();
          discordGetCapabilitiesMock.mockReset();
          discordListActionsMock.mockReturnValue(["send", "react", "poll"]);
          discordGetCapabilitiesMock.mockReturnValue(["interactive", "components"]);
        },
      },
    ],
  },
];

export const setupContractRegistry: SetupContractEntry[] = [
  {
    id: "slack",
    plugin: requireBundledChannelPlugin("slack"),
    cases: [
      {
        name: "default account stores tokens and enables the channel",
        cfg: {} as OpenClawConfig,
        input: {
          botToken: "xoxb-test",
          appToken: "xapp-test",
        },
        expectedAccountId: "default",
        assertPatchedConfig: (cfg) => {
          expect(cfg.channels?.slack?.enabled).toBe(true);
          expect(cfg.channels?.slack?.botToken).toBe("xoxb-test");
          expect(cfg.channels?.slack?.appToken).toBe("xapp-test");
        },
      },
      {
        name: "non-default env setup is rejected",
        cfg: {} as OpenClawConfig,
        accountId: "ops",
        input: {
          useEnv: true,
        },
        expectedAccountId: "ops",
        expectedValidation: "Slack env tokens can only be used for the default account.",
      },
    ],
  },
  {
    id: "mattermost",
    plugin: requireBundledChannelPlugin("mattermost"),
    cases: [
      {
        name: "default account stores token and normalized base URL",
        cfg: {} as OpenClawConfig,
        input: {
          botToken: "test-token",
          httpUrl: "https://chat.example.com/",
        },
        expectedAccountId: "default",
        assertPatchedConfig: (cfg) => {
          expect(cfg.channels?.mattermost?.enabled).toBe(true);
          expect(cfg.channels?.mattermost?.botToken).toBe("test-token");
          expect(cfg.channels?.mattermost?.baseUrl).toBe("https://chat.example.com");
        },
      },
      {
        name: "missing credentials are rejected",
        cfg: {} as OpenClawConfig,
        input: {
          httpUrl: "",
        },
        expectedAccountId: "default",
        expectedValidation: "Mattermost requires --bot-token and --http-url (or --use-env).",
      },
    ],
  },
  {
    id: "line",
    plugin: requireBundledChannelPlugin("line"),
    cases: [
      {
        name: "default account stores token and secret",
        cfg: {} as OpenClawConfig,
        input: {
          channelAccessToken: "line-token",
          channelSecret: "line-secret",
        },
        expectedAccountId: "default",
        assertPatchedConfig: (cfg) => {
          expect(cfg.channels?.line?.enabled).toBe(true);
          expect(cfg.channels?.line?.channelAccessToken).toBe("line-token");
          expect(cfg.channels?.line?.channelSecret).toBe("line-secret");
        },
      },
      {
        name: "non-default env setup is rejected",
        cfg: {} as OpenClawConfig,
        accountId: "ops",
        input: {
          useEnv: true,
        },
        expectedAccountId: "ops",
        expectedValidation: "LINE_CHANNEL_ACCESS_TOKEN can only be used for the default account.",
      },
    ],
  },
];

export const statusContractRegistry: StatusContractEntry[] = [
  {
    id: "slack",
    plugin: requireBundledChannelPlugin("slack"),
    cases: [
      {
        name: "configured account produces a configured status snapshot",
        cfg: {
          channels: {
            slack: {
              botToken: "xoxb-test",
              appToken: "xapp-test",
            },
          },
        } as OpenClawConfig,
        runtime: {
          accountId: "default",
          connected: true,
          running: true,
        },
        probe: { ok: true },
        assertSnapshot: (snapshot) => {
          expect(snapshot.accountId).toBe("default");
          expect(snapshot.enabled).toBe(true);
          expect(snapshot.configured).toBe(true);
        },
      },
    ],
  },
  {
    id: "mattermost",
    plugin: requireBundledChannelPlugin("mattermost"),
    cases: [
      {
        name: "configured account preserves connectivity details in the snapshot",
        cfg: {
          channels: {
            mattermost: {
              enabled: true,
              botToken: "test-token",
              baseUrl: "https://chat.example.com",
            },
          },
        } as OpenClawConfig,
        runtime: {
          accountId: "default",
          connected: true,
          lastConnectedAt: 1234,
        },
        probe: { ok: true },
        assertSnapshot: (snapshot) => {
          expect(snapshot.accountId).toBe("default");
          expect(snapshot.enabled).toBe(true);
          expect(snapshot.configured).toBe(true);
          expect(snapshot.connected).toBe(true);
          expect(snapshot.baseUrl).toBe("https://chat.example.com");
        },
      },
    ],
  },
  {
    id: "line",
    plugin: requireBundledChannelPlugin("line"),
    cases: [
      {
        name: "configured account produces a webhook status snapshot",
        cfg: {
          channels: {
            line: {
              enabled: true,
              channelAccessToken: "line-token",
              channelSecret: "line-secret",
            },
          },
        } as OpenClawConfig,
        runtime: {
          accountId: "default",
          running: true,
        },
        probe: { ok: true },
        assertSnapshot: (snapshot) => {
          expect(snapshot.accountId).toBe("default");
          expect(snapshot.enabled).toBe(true);
          expect(snapshot.configured).toBe(true);
          expect(snapshot.mode).toBe("webhook");
        },
      },
    ],
  },
];
