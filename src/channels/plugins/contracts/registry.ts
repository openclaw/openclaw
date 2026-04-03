import { vi } from "vitest";
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
