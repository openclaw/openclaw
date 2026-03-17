import { expect, vi } from "vitest";
import {
  __testing as discordThreadBindingTesting,
  createThreadBindingManager as createDiscordThreadBindingManager,
} from "../../../../extensions/discord/runtime-api.js";
import { createFeishuThreadBindingManager } from "../../../../extensions/feishu/api.js";
import { setMatrixRuntime } from "../../../../extensions/matrix/api.js";
import { createTelegramThreadBindingManager } from "../../../../extensions/telegram/runtime-api.js";
import type { OpenClawConfig } from "../../../config/config.js";
import {
  getSessionBindingService,
  type SessionBindingCapabilities,
  type SessionBindingRecord,
} from "../../../infra/outbound/session-binding-service.js";
import {
  resolveDefaultLineAccountId,
  resolveLineAccount,
  listLineAccountIds,
} from "../../../line/accounts.js";
import {
  bundledChannelPlugins,
  bundledChannelRuntimeSetters,
  requireBundledChannelPlugin,
} from "../bundled.js";
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

export const channelPluginSurfaceKeys = [
  "actions",
  "setup",
  "status",
  "outbound",
  "messaging",
  "threading",
  "directory",
  "gateway",
] as const;

export type ChannelPluginSurface =
  | "actions"
  | "setup"
  | "status"
  | "outbound"
  | "messaging"
  | "threading"
  | "directory"
  | "gateway";

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

type SessionBindingContractEntry = {
  id: string;
  expectedCapabilities: SessionBindingCapabilities;
  getCapabilities: () => SessionBindingCapabilities;
  bindAndResolve: () => Promise<SessionBindingRecord>;
  unbindAndVerify: (binding: SessionBindingRecord) => Promise<void>;
  cleanup: () => Promise<void> | void;
};

function expectResolvedSessionBinding(params: {
  channel: string;
  accountId: string;
  conversationId: string;
  targetSessionKey: string;
}) {
  expect(
    getSessionBindingService().resolveByConversation({
      channel: params.channel,
      accountId: params.accountId,
      conversationId: params.conversationId,
    }),
  )?.toMatchObject({
    targetSessionKey: params.targetSessionKey,
  });
}

async function unbindAndExpectClearedSessionBinding(binding: SessionBindingRecord) {
  const service = getSessionBindingService();
  const removed = await service.unbind({
    bindingId: binding.bindingId,
    reason: "contract-test",
  });
  expect(removed.map((entry) => entry.bindingId)).toContain(binding.bindingId);
  expect(service.resolveByConversation(binding.conversation)).toBeNull();
}

function expectClearedSessionBinding(params: {
  channel: string;
  accountId: string;
  conversationId: string;
}) {
  expect(
    getSessionBindingService().resolveByConversation({
      channel: params.channel,
      accountId: params.accountId,
      conversationId: params.conversationId,
    }),
  ).toBeNull();
}

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

setMatrixRuntime({
  state: {
    resolveStateDir: (_env: unknown, homeDir?: () => string) => (homeDir ?? (() => "/tmp"))(),
  },
} as never);

export const pluginContractRegistry: PluginContractEntry[] = bundledChannelPlugins.map(
  (plugin) => ({
    id: plugin.id,
    plugin,
  }),
);

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

export const surfaceContractRegistry: SurfaceContractEntry[] = bundledChannelPlugins.map(
  (plugin) => ({
    id: plugin.id,
    plugin,
    surfaces: channelPluginSurfaceKeys.filter((surface) => Boolean(plugin[surface])),
  }),
);

export const threadingContractRegistry: ThreadingContractEntry[] = surfaceContractRegistry
  .filter((entry) => entry.surfaces.includes("threading"))
  .map((entry) => ({
    id: entry.id,
    plugin: entry.plugin,
  }));

const directoryPresenceOnlyIds = new Set(["whatsapp", "zalouser"]);
const matrixDirectoryCfg = {
  channels: {
    matrix: {
      enabled: true,
      homeserver: "https://matrix.example.com",
      userId: "@lobster:example.com",
      accessToken: "matrix-access-token",
      dm: {
        allowFrom: ["matrix:@alice:example.com"],
      },
      groupAllowFrom: ["matrix:@team:example.com"],
      groups: {
        "!room:example.com": {
          users: ["matrix:@alice:example.com"],
        },
      },
    },
  },
} as OpenClawConfig;

export const directoryContractRegistry: DirectoryContractEntry[] = surfaceContractRegistry
  .filter((entry) => entry.surfaces.includes("directory"))
  .map((entry) => ({
    id: entry.id,
    plugin: entry.plugin,
    coverage: directoryPresenceOnlyIds.has(entry.id) ? "presence" : "lookups",
    ...(entry.id === "matrix" ? { cfg: matrixDirectoryCfg } : {}),
  }));

const baseSessionBindingCfg = {
  session: { mainKey: "main", scope: "per-sender" },
} satisfies OpenClawConfig;

export const sessionBindingContractRegistry: SessionBindingContractEntry[] = [
  {
    id: "discord",
    expectedCapabilities: {
      adapterAvailable: true,
      bindSupported: true,
      unbindSupported: true,
      placements: ["current", "child"],
    },
    getCapabilities: () => {
      createDiscordThreadBindingManager({
        accountId: "default",
        persist: false,
        enableSweeper: false,
      });
      return getSessionBindingService().getCapabilities({
        channel: "discord",
        accountId: "default",
      });
    },
    bindAndResolve: async () => {
      createDiscordThreadBindingManager({
        accountId: "default",
        persist: false,
        enableSweeper: false,
      });
      const service = getSessionBindingService();
      const binding = await service.bind({
        targetSessionKey: "agent:discord:child:thread-1",
        targetKind: "subagent",
        conversation: {
          channel: "discord",
          accountId: "default",
          conversationId: "channel:123456789012345678",
        },
        placement: "current",
        metadata: {
          label: "codex-discord",
        },
      });
      expectResolvedSessionBinding({
        channel: "discord",
        accountId: "default",
        conversationId: "channel:123456789012345678",
        targetSessionKey: "agent:discord:child:thread-1",
      });
      return binding;
    },
    unbindAndVerify: unbindAndExpectClearedSessionBinding,
    cleanup: async () => {
      const manager = createDiscordThreadBindingManager({
        accountId: "default",
        persist: false,
        enableSweeper: false,
      });
      manager.stop();
      discordThreadBindingTesting.resetThreadBindingsForTests();
      expectClearedSessionBinding({
        channel: "discord",
        accountId: "default",
        conversationId: "channel:123456789012345678",
      });
    },
  },
  {
    id: "feishu",
    expectedCapabilities: {
      adapterAvailable: true,
      bindSupported: true,
      unbindSupported: true,
      placements: ["current"],
    },
    getCapabilities: () => {
      createFeishuThreadBindingManager({ cfg: baseSessionBindingCfg, accountId: "default" });
      return getSessionBindingService().getCapabilities({
        channel: "feishu",
        accountId: "default",
      });
    },
    bindAndResolve: async () => {
      createFeishuThreadBindingManager({ cfg: baseSessionBindingCfg, accountId: "default" });
      const service = getSessionBindingService();
      const binding = await service.bind({
        targetSessionKey: "agent:codex:acp:binding:feishu:default:abc123",
        targetKind: "session",
        conversation: {
          channel: "feishu",
          accountId: "default",
          conversationId: "oc_group_chat:topic:om_topic_root",
          parentConversationId: "oc_group_chat",
        },
        placement: "current",
        metadata: {
          agentId: "codex",
          label: "codex-main",
        },
      });
      expectResolvedSessionBinding({
        channel: "feishu",
        accountId: "default",
        conversationId: "oc_group_chat:topic:om_topic_root",
        targetSessionKey: "agent:codex:acp:binding:feishu:default:abc123",
      });
      return binding;
    },
    unbindAndVerify: unbindAndExpectClearedSessionBinding,
    cleanup: async () => {
      const manager = createFeishuThreadBindingManager({
        cfg: baseSessionBindingCfg,
        accountId: "default",
      });
      manager.stop();
      expectClearedSessionBinding({
        channel: "feishu",
        accountId: "default",
        conversationId: "oc_group_chat:topic:om_topic_root",
      });
    },
  },
  {
    id: "telegram",
    expectedCapabilities: {
      adapterAvailable: true,
      bindSupported: true,
      unbindSupported: true,
      placements: ["current"],
    },
    getCapabilities: () => {
      createTelegramThreadBindingManager({
        accountId: "default",
        persist: false,
        enableSweeper: false,
      });
      return getSessionBindingService().getCapabilities({
        channel: "telegram",
        accountId: "default",
      });
    },
    bindAndResolve: async () => {
      createTelegramThreadBindingManager({
        accountId: "default",
        persist: false,
        enableSweeper: false,
      });
      const service = getSessionBindingService();
      const binding = await service.bind({
        targetSessionKey: "agent:main:subagent:child-1",
        targetKind: "subagent",
        conversation: {
          channel: "telegram",
          accountId: "default",
          conversationId: "-100200300:topic:77",
        },
        placement: "current",
        metadata: {
          boundBy: "user-1",
        },
      });
      expectResolvedSessionBinding({
        channel: "telegram",
        accountId: "default",
        conversationId: "-100200300:topic:77",
        targetSessionKey: "agent:main:subagent:child-1",
      });
      return binding;
    },
    unbindAndVerify: unbindAndExpectClearedSessionBinding,
    cleanup: async () => {
      const manager = createTelegramThreadBindingManager({
        accountId: "default",
        persist: false,
        enableSweeper: false,
      });
      manager.stop();
      expectClearedSessionBinding({
        channel: "telegram",
        accountId: "default",
        conversationId: "-100200300:topic:77",
      });
    },
  },
];
