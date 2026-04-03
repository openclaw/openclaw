import { expect, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import {
  listLineAccountIds,
  resolveDefaultLineAccountId,
  resolveLineAccount,
} from "../../../plugin-sdk/line.js";
import {
  listBundledChannelPlugins,
  requireBundledChannelPlugin,
  setBundledChannelRuntime,
} from "../bundled.js";
import type { ChannelPlugin } from "../types.js";
import { channelPluginSurfaceKeys, type ChannelPluginSurface } from "./manifest.js";

function buildBundledPluginModuleId(pluginId: string, artifactBasename: string): string {
  return ["..", "..", "..", "..", "extensions", pluginId, artifactBasename].join("/");
}

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

type SurfaceContractEntry = {
  id: string;
  plugin: Pick<
    ChannelPlugin,
    | "id"
    | "actions"
    | "setup"
    | "status"
    | "outbound"
    | "messaging"
    | "threading"
    | "directory"
    | "gateway"
  >;
  surfaces: readonly ChannelPluginSurface[];
};

type ThreadingContractEntry = {
  id: string;
  plugin: Pick<ChannelPlugin, "id" | "threading">;
};

type DirectoryContractEntry = {
  id: string;
  plugin: Pick<ChannelPlugin, "id" | "directory">;
  coverage: "lookups" | "presence";
  cfg?: OpenClawConfig;
  accountId?: string;
};

const sendMessageMatrixMock = vi.hoisted(() =>
  vi.fn(async (to: string, _message: string, opts?: { threadId?: string }) => ({
    messageId: opts?.threadId ? "$matrix-thread" : "$matrix-root",
    roomId: to.replace(/^room:/, ""),
  })),
);

setBundledChannelRuntime("line", {
  channel: {
    line: {
      listLineAccountIds,
      resolveDefaultLineAccountId,
      resolveLineAccount: ({ cfg, accountId }: { cfg: OpenClawConfig; accountId?: string }) =>
        resolveLineAccount({ cfg, accountId }),
    },
  },
} as never);

vi.mock(buildBundledPluginModuleId("matrix", "runtime-api.js"), async () => {
  const matrixRuntimeApiModuleId = buildBundledPluginModuleId("matrix", "runtime-api.js");
  const actual = await vi.importActual(matrixRuntimeApiModuleId);
  return {
    ...actual,
    sendMessageMatrix: sendMessageMatrixMock,
  };
});

let pluginContractRegistryCache: PluginContractEntry[] | undefined;
let actionContractRegistryCache: ActionsContractEntry[] | undefined;
let setupContractRegistryCache: SetupContractEntry[] | undefined;
let statusContractRegistryCache: StatusContractEntry[] | undefined;
let surfaceContractRegistryCache: SurfaceContractEntry[] | undefined;
let threadingContractRegistryCache: ThreadingContractEntry[] | undefined;
let directoryContractRegistryCache: DirectoryContractEntry[] | undefined;

export function getPluginContractRegistry(): PluginContractEntry[] {
  pluginContractRegistryCache ??= listBundledChannelPlugins().map((plugin) => ({
    id: plugin.id,
    plugin,
  }));
  return pluginContractRegistryCache;
}

export function getActionContractRegistry(): ActionsContractEntry[] {
  actionContractRegistryCache ??= [
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
            "upload-file",
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
            "upload-file",
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
          name: "exposes configured Telegram actions and capabilities",
          cfg: {
            channels: {
              telegram: {
                botToken: "123:telegram-test-token",
              },
            },
          } as OpenClawConfig,
          expectedActions: [
            "send",
            "poll",
            "react",
            "delete",
            "edit",
            "topic-create",
            "topic-edit",
          ],
          expectedCapabilities: ["interactive", "buttons"],
        },
      ],
    },
    {
      id: "discord",
      plugin: requireBundledChannelPlugin("discord"),
      cases: [
        {
          name: "describes configured Discord actions and capabilities",
          cfg: {
            channels: {
              discord: {
                token: "Bot token-main",
                actions: {
                  polls: true,
                  reactions: true,
                  permissions: false,
                  messages: false,
                  pins: false,
                  threads: false,
                  search: false,
                  stickers: false,
                  memberInfo: false,
                  roleInfo: false,
                  emojiUploads: false,
                  stickerUploads: false,
                  channelInfo: false,
                  channels: false,
                  voiceStatus: false,
                  events: false,
                  roles: false,
                  moderation: false,
                  presence: false,
                },
              },
            },
          } as OpenClawConfig,
          expectedActions: ["send", "poll", "react", "reactions", "emoji-list"],
          expectedCapabilities: ["interactive", "components"],
        },
      ],
    },
  ];
  return actionContractRegistryCache;
}

export function getSetupContractRegistry(): SetupContractEntry[] {
  setupContractRegistryCache ??= [
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
  return setupContractRegistryCache;
}

export function getStatusContractRegistry(): StatusContractEntry[] {
  statusContractRegistryCache ??= [
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
  return statusContractRegistryCache;
}

export function getSurfaceContractRegistry(): SurfaceContractEntry[] {
  surfaceContractRegistryCache ??= listBundledChannelPlugins().map((plugin) => ({
    id: plugin.id,
    plugin,
    surfaces: channelPluginSurfaceKeys.filter((surface) => Boolean(plugin[surface])),
  }));
  return surfaceContractRegistryCache;
}

export function getThreadingContractRegistry(): ThreadingContractEntry[] {
  threadingContractRegistryCache ??= getSurfaceContractRegistry()
    .filter((entry) => entry.surfaces.includes("threading"))
    .map((entry) => ({
      id: entry.id,
      plugin: entry.plugin,
    }));
  return threadingContractRegistryCache;
}

const directoryPresenceOnlyIds = new Set(["whatsapp", "zalouser"]);

export function getDirectoryContractRegistry(): DirectoryContractEntry[] {
  directoryContractRegistryCache ??= getSurfaceContractRegistry()
    .filter((entry) => entry.surfaces.includes("directory"))
    .map((entry) => ({
      id: entry.id,
      plugin: entry.plugin,
      coverage: directoryPresenceOnlyIds.has(entry.id) ? "presence" : "lookups",
    }));
  return directoryContractRegistryCache;
}
