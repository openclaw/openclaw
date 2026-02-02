import type { OpenClawConfig } from "../../../config/config.js";
import type { WizardPrompter } from "../../../wizard/prompts.js";
import type { ChannelOnboardingAdapter, ChannelOnboardingDmPolicy } from "../onboarding-types.js";
import {
  DEFAULT_ACCOUNT_ID,
  listKookAccountIds,
  normalizeAccountId,
  resolveKookAccount,
} from "../../../kook/accounts.js";
import { addWildcardAllowFrom, promptAccountId } from "./helpers.js";

const channel = "kook" as const;

function setKookDmPolicy(
  cfg: OpenClawConfig,
  dmPolicy: "pairing" | "allowlist" | "open" | "disabled",
) {
  const allowFrom =
    dmPolicy === "open" ? addWildcardAllowFrom(cfg.channels?.kook?.dm?.allowFrom) : undefined;
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      kook: {
        ...cfg.channels?.kook,
        dmPolicy,
        ...(allowFrom ? { allowFrom } : {}),
      },
    },
  } as OpenClawConfig;
}

async function noteKookTokenHelp(prompter: WizardPrompter): Promise<void> {
  await prompter.note(
    [
      "1) Open KOOK Developer Portal: https://developer.kookapp.cn",
      "2) Create a bot and get the token",
      "3) Token looks like a JWT string",
      "Tip: you can also set KOOK_BOT_TOKEN in your env.",
      "Docs: https://docs.openclaw.ai/channels/kook",
    ].join("\n"),
    "KOOK bot token",
  );
}

async function promptKookAllowFrom(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  accountId: string;
}): Promise<OpenClawConfig> {
  const { cfg, prompter, accountId } = params;
  const resolved = resolveKookAccount({ cfg, accountId });
  const existingAllowFrom = resolved.config.dm?.allowFrom ?? [];
  const entry = await prompter.text({
    message: "KOOK allowFrom (user id)",
    placeholder: "123456789",
    initialValue: existingAllowFrom[0] ? String(existingAllowFrom[0]) : undefined,
    validate: (value: unknown) => {
      const raw =
        typeof value === "string"
          ? value.trim()
          : typeof value === "number"
            ? String(value).trim()
            : "";
      if (!raw) {
        return "Required";
      }
      if (!/^\d+$/.test(raw)) {
        return "Use a numeric KOOK user id";
      }
      return undefined;
    },
  });
  const normalized = String(entry).trim();
  const merged = [
    ...existingAllowFrom.map((item) => String(item).trim()).filter(Boolean),
    normalized,
  ];
  const unique = [...new Set(merged)];

  if (accountId === DEFAULT_ACCOUNT_ID) {
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        kook: {
          ...cfg.channels?.kook,
          enabled: true,
          dm: {
            ...cfg.channels?.kook?.dm,
            policy: "allowlist",
            allowFrom: unique,
          },
        },
      },
    } as OpenClawConfig;
  }

  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      kook: {
        ...cfg.channels?.kook,
        enabled: true,
        accounts: {
          ...cfg.channels?.kook?.accounts,
          [accountId]: {
            ...cfg.channels?.kook?.accounts?.[accountId],
            enabled: cfg.channels?.kook?.accounts?.[accountId]?.enabled ?? true,
            dm: {
              ...cfg.channels?.kook?.accounts?.[accountId]?.dm,
              policy: "allowlist",
              allowFrom: unique,
            },
          },
        },
      },
    },
  } as OpenClawConfig;
}

async function promptKookNumericConfig(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
}): Promise<OpenClawConfig> {
  const { cfg, prompter } = params;

  const configureNumeric = await prompter.confirm({
    message: "Configure numeric settings (history limit, media size, text chunk)?",
    initialValue: false,
  });

  if (!configureNumeric) {
    return cfg;
  }

  const historyLimit = await prompter.text({
    message: "History limit (number of messages to fetch)",
    placeholder: "10",
    initialValue: String(cfg.channels?.kook?.historyLimit ?? 10),
    validate: (value) => {
      const num = Number(value);
      if (isNaN(num) || num < 1) {
        return "Must be a positive number";
      }
      return undefined;
    },
  });

  const mediaMaxMb = await prompter.text({
    message: "Media max size (MB)",
    placeholder: "10",
    initialValue: String(cfg.channels?.kook?.mediaMaxMb ?? 10),
    validate: (value) => {
      const num = Number(value);
      if (isNaN(num) || num < 1) {
        return "Must be a positive number";
      }
      return undefined;
    },
  });

  const textChunkLimit = await prompter.text({
    message: "Text chunk limit (characters)",
    placeholder: "2000",
    initialValue: String(cfg.channels?.kook?.textChunkLimit ?? 2000),
    validate: (value) => {
      const num = Number(value);
      if (isNaN(num) || num < 100) {
        return "Must be at least 100";
      }
      return undefined;
    },
  });

  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      kook: {
        ...cfg.channels?.kook,
        historyLimit: Number(historyLimit),
        mediaMaxMb: Number(mediaMaxMb),
        textChunkLimit: Number(textChunkLimit),
      },
    },
  } as OpenClawConfig;
}

async function promptKookGroupPolicy(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
}): Promise<OpenClawConfig> {
  const { cfg, prompter } = params;

  const configurePolicy = await prompter.confirm({
    message: "Configure group/server access policy?",
    initialValue: false,
  });

  if (!configurePolicy) {
    return cfg;
  }

  const policy = await prompter.select({
    message: "Group/Server access policy",
    options: [
      { value: "open", label: "Open - allow all servers" },
      { value: "allowlist", label: "Allowlist - only configured servers" },
      { value: "disabled", label: "Disabled - no server access" },
    ],
  });

  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      kook: {
        ...cfg.channels?.kook,
        groupPolicy: policy,
      },
    },
  } as OpenClawConfig;
}

async function promptKookGuilds(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
}): Promise<OpenClawConfig> {
  const { cfg, prompter } = params;

  const existingGuilds = cfg.channels?.kook?.guilds ?? {};
  const guildIds = Object.keys(existingGuilds);

  const addGuild = await prompter.confirm({
    message:
      guildIds.length > 0
        ? "Configure additional guilds/servers?"
        : "Configure specific guilds/servers?",
    initialValue: false,
  });

  if (!addGuild) {
    return cfg;
  }

  const newGuilds = { ...existingGuilds };

  while (true) {
    const guildId = await prompter.text({
      message: "Guild ID (numeric) or leave empty to finish",
      placeholder: "6367541001667830",
      validate: (value) => {
        if (!value?.trim()) {
          return undefined;
        }
        if (!/^\d+$/.test(value)) {
          return "Must be numeric";
        }
        return undefined;
      },
    });

    if (!guildId?.trim()) {
      break;
    }

    const slug = await prompter.text({
      message: "Guild slug/alias (optional)",
      placeholder: "main-server",
    });

    const requireMention = await prompter.confirm({
      message: "Require @mention in this guild?",
      initialValue: existingGuilds[guildId]?.requireMention ?? false,
    });

    const channelIds: string[] = [];
    while (true) {
      const channelId = await prompter.text({
        message: "Channel ID to allow (numeric) or leave empty to finish",
        placeholder: "5265829152322102",
      });
      if (!channelId?.trim()) {
        break;
      }
      if (!/^\d+$/.test(channelId)) {
        await prompter.note("Channel ID must be numeric", "Invalid input");
        continue;
      }
      channelIds.push(channelId);
    }

    const channels = Object.fromEntries(
      channelIds.map((id) => [id, { allow: true, requireMention: false }]),
    );

    const userIds: string[] = [];
    while (true) {
      const userId = await prompter.text({
        message: "User ID allowed in this guild (numeric) or leave empty",
        placeholder: "1567351889",
      });
      if (!userId?.trim()) {
        break;
      }
      userIds.push(userId);
    }

    newGuilds[guildId] = {
      slug: slug?.trim() || undefined,
      requireMention,
      users: userIds.length > 0 ? userIds : undefined,
      channels: Object.keys(channels).length > 0 ? channels : undefined,
    };

    const addMore = await prompter.confirm({
      message: "Add another guild?",
      initialValue: false,
    });
    if (!addMore) {
      break;
    }
  }

  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      kook: {
        ...cfg.channels?.kook,
        guilds: Object.keys(newGuilds).length > 0 ? newGuilds : undefined,
      },
    },
  } as OpenClawConfig;
}

async function promptKookActions(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
}): Promise<OpenClawConfig> {
  const { cfg, prompter } = params;
  const existing = cfg.channels?.kook?.actions ?? {};

  const configureActions = await prompter.confirm({
    message: "Configure feature toggles (actions)?",
    initialValue: false,
  });

  if (!configureActions) {
    return cfg;
  }

  const actions = {
    // User Queries
    getMe: await prompter.confirm({
      message: "Enable getMe (bot self info)?",
      initialValue: existing.getMe ?? true,
    }),
    getUser: await prompter.confirm({
      message: "Enable getUser (user lookup)?",
      initialValue: existing.getUser ?? true,
    }),

    // Guild Queries
    getGuildList: await prompter.confirm({
      message: "Enable getGuildList?",
      initialValue: existing.getGuildList ?? true,
    }),
    getGuild: await prompter.confirm({
      message: "Enable getGuild?",
      initialValue: existing.getGuild ?? true,
    }),
    getGuildUserCount: await prompter.confirm({
      message: "Enable getGuildUserCount?",
      initialValue: existing.getGuildUserCount ?? true,
    }),
    getGuildUsers: await prompter.confirm({
      message: "Enable getGuildUsers?",
      initialValue: existing.getGuildUsers ?? true,
    }),

    // Channel Queries
    getChannel: await prompter.confirm({
      message: "Enable getChannel?",
      initialValue: existing.getChannel ?? true,
    }),
    getChannelList: await prompter.confirm({
      message: "Enable getChannelList?",
      initialValue: existing.getChannelList ?? true,
    }),
    getChannelUserList: await prompter.confirm({
      message: "Enable getChannelUserList?",
      initialValue: existing.getChannelUserList ?? true,
    }),

    // Group toggles
    guildInfo: await prompter.confirm({
      message: "Enable guildInfo group?",
      initialValue: existing.guildInfo ?? true,
    }),
    channelInfo: await prompter.confirm({
      message: "Enable channelInfo group?",
      initialValue: existing.channelInfo ?? true,
    }),
    roleInfo: await prompter.confirm({
      message: "Enable roleInfo (read-only)?",
      initialValue: existing.roleInfo ?? true,
    }),
    emojiList: await prompter.confirm({
      message: "Enable emojiList (read-only)?",
      initialValue: existing.emojiList ?? true,
    }),

    // Write operations (default enabled for role management)
    roles: await prompter.confirm({
      message: "Enable role write operations?",
      initialValue: existing.roles ?? true,
    }),
    channels: await prompter.confirm({
      message: "Enable channel write operations?",
      initialValue: existing.channels ?? false,
    }),
    memberInfo: await prompter.confirm({
      message: "Enable member info write operations?",
      initialValue: existing.memberInfo ?? false,
    }),
    moderation: await prompter.confirm({
      message: "Enable moderation operations?",
      initialValue: existing.moderation ?? false,
    }),
    emojiUploads: await prompter.confirm({
      message: "Enable emoji upload operations?",
      initialValue: existing.emojiUploads ?? false,
    }),
    voiceStatus: await prompter.confirm({
      message: "Enable voice status operations?",
      initialValue: existing.voiceStatus ?? false,
    }),
  };

  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      kook: {
        ...cfg.channels?.kook,
        actions,
      },
    },
  } as OpenClawConfig;
}

const dmPolicy: ChannelOnboardingDmPolicy = {
  label: "KOOK",
  channel,
  policyKey: "channels.kook.dmPolicy",
  allowFromKey: "channels.kook.allowFrom",
  getCurrent: (cfg) => (cfg.channels?.kook?.dm?.policy ?? "pairing") as "pairing",
  setPolicy: (cfg, policy) => setKookDmPolicy(cfg, policy),
  promptAllowFrom: async ({ cfg, prompter, accountId }) => {
    const id =
      accountId && normalizeAccountId(accountId)
        ? (normalizeAccountId(accountId) ?? DEFAULT_ACCOUNT_ID)
        : DEFAULT_ACCOUNT_ID;
    return promptKookAllowFrom({
      cfg,
      prompter,
      accountId: id,
    });
  },
};

export const kookOnboardingAdapter: ChannelOnboardingAdapter = {
  channel,
  dmPolicy,
  getStatus: async ({ cfg }) => {
    const configured = listKookAccountIds(cfg).some((accountId) =>
      Boolean(resolveKookAccount({ cfg, accountId }).token),
    );
    return {
      channel,
      configured,
      statusLines: [`KOOK: ${configured ? "configured" : "needs token"}`],
      selectionHint: configured ? "recommended · configured" : "recommended · newcomer-friendly",
      quickstartScore: configured ? 1 : 10,
    };
  },
  configure: async ({
    cfg,
    prompter,
    accountOverrides,
    shouldPromptAccountIds,
    forceAllowFrom,
  }) => {
    // ===== STEP 0: Permission confirmation =====
    await prompter.note(
      [
        "🤖 KOOK Bot Permission Configuration",
        "",
        "To protect your server security, please confirm the permission configuration:",
        "",
        "If not configured, the following default permissions will be used:",
        "  ✅ Send messages, send direct messages",
        "  ✅ Get user info, guild info, channel info",
        "  ❌ Create/delete/modify roles, channels",
        "  ❌ Kick/mute users",
        "  ❌ Other admin operations",
        "",
        "💡 Tip: Permission settings can be changed in the config file at any time",
      ].join("\n"),
      "KOOK Permission Configuration",
    );

    const configurePermissions = await prompter.confirm({
      message: "Configure KOOK Bot permissions in detail? (Recommended for advanced users)",
      initialValue: false,
    });

    // 初始化默认 actions 配置
    let defaultActions: Record<string, boolean> = {};

    if (!configurePermissions) {
      // ===== Quick start: default read-only config =====
      defaultActions = {
        // 基础消息（启用）
        sendMessage: true,
        sendDirectMessage: true,

        // 用户查询（启用）
        getMe: true,
        getUser: true,

        // 服务器查询（启用）
        getGuildList: true,
        getGuild: true,
        getGuildUserCount: true,
        getGuildUsers: true,

        // 频道查询（启用）
        getChannel: true,
        getChannelList: true,
        getChannelUserList: true,

        // 角色查询（启用）
        roleInfo: true,

        // 表情查询（启用）
        emojiList: true,

        // Mute query (enabled)
        muteList: true,

        // ===== The following operations are enabled/disabled by default =====

        // Role management (enabled)
        roleCreate: true,
        roleUpdate: true,
        roleDelete: true,
        roleGrant: true,
        roleRevoke: true,

        // Channel management (disabled)
        createChannel: false,
        updateChannel: false,
        deleteChannel: false,
        moveUser: false,

        // Member management (disabled)
        updateNickname: false,
        kickUser: false,
        leaveGuild: false,

        // Emoji management (disabled)
        emojiCreate: false,
        emojiUpdate: false,
        emojiDelete: false,

        // Mute management (disabled)
        muteCreate: false,
        muteDelete: false,
      };
    }

    // 保存默认配置到 cfg
    cfg = {
      ...cfg,
      channels: {
        ...cfg.channels,
        kook: {
          ...cfg.channels?.kook,
          groupPolicy: cfg.channels?.kook?.groupPolicy ?? "allowlist",
          actions: defaultActions,
        },
      },
    };

    // ===== Continue with the original flow =====
    const kookOverride = accountOverrides.kook?.trim();
    let kookAccountId = kookOverride ? normalizeAccountId(kookOverride) : DEFAULT_ACCOUNT_ID;
    if (shouldPromptAccountIds && !kookOverride) {
      kookAccountId = await promptAccountId({
        cfg,
        prompter,
        label: "KOOK",
        currentId: kookAccountId,
        listAccountIds: listKookAccountIds,
        defaultAccountId: DEFAULT_ACCOUNT_ID,
      });
    }

    let next = cfg;
    const resolvedAccount = resolveKookAccount({ cfg: next, accountId: kookAccountId });
    const accountConfigured = Boolean(resolvedAccount.token);
    const allowEnv = kookAccountId === DEFAULT_ACCOUNT_ID;
    const canUseEnv = allowEnv && Boolean(process.env.KOOK_BOT_TOKEN?.trim());
    const hasConfigToken = Boolean(
      resolvedAccount.config.token || (cfg.channels?.kook as Record<string, unknown>)?.token,
    );

    let token: string | null = null;
    if (!accountConfigured) {
      await noteKookTokenHelp(prompter);
    }
    if (canUseEnv && !resolvedAccount.config.token) {
      const keepEnv = await prompter.confirm({
        message: "KOOK_BOT_TOKEN detected. Use env var?",
        initialValue: true,
      });
      if (keepEnv) {
        next = {
          ...next,
          channels: {
            ...next.channels,
            kook: {
              ...next.channels?.kook,
              enabled: true,
            },
          },
        } as OpenClawConfig;
      } else {
        token = String(
          await prompter.text({
            message: "Enter KOOK bot token",
            validate: (value) => (value?.trim() ? undefined : "Required"),
          }),
        ).trim();
      }
    } else if (hasConfigToken) {
      const keep = await prompter.confirm({
        message: "KOOK token already configured. Keep it?",
        initialValue: true,
      });
      if (!keep) {
        token = String(
          await prompter.text({
            message: "Enter KOOK bot token",
            validate: (value) => (value?.trim() ? undefined : "Required"),
          }),
        ).trim();
      }
    } else {
      token = String(
        await prompter.text({
          message: "Enter KOOK bot token",
          validate: (value) => (value?.trim() ? undefined : "Required"),
        }),
      ).trim();
    }

    if (token) {
      if (kookAccountId === DEFAULT_ACCOUNT_ID) {
        next = {
          ...next,
          channels: {
            ...next.channels,
            kook: {
              ...next.channels?.kook,
              enabled: true,
              token,
            },
          },
        } as OpenClawConfig;
      } else {
        next = {
          ...next,
          channels: {
            ...next.channels,
            kook: {
              ...next.channels?.kook,
              enabled: true,
              accounts: {
                ...next.channels?.kook?.accounts,
                [kookAccountId]: {
                  ...next.channels?.kook?.accounts?.[kookAccountId],
                  enabled: true,
                  token,
                },
              },
            },
          },
        } as OpenClawConfig;
      }
    }

    await prompter.note(
      [
        "⚠️  SECURITY WARNING - 安全警告",
        "",
        "Without an allowlist, your bot will respond to EVERYONE's commands.",
        "This poses serious risks including:",
        "  • Unauthorized access to your system",
        "  • Potential file deletion or data loss",
        "  • Abuse of bot capabilities",
        "",
        "STRONGLY RECOMMENDED: Set up an allowlist to restrict who can use the bot.",
        "如果不设置允许列表，机器人将响应所有人的命令，存在严重安全风险！",
      ].join("\n"),
      "🚨 Security Warning",
    );

    const setupAllowlist = await prompter.confirm({
      message: "Set up allowlist now? (STRONGLY RECOMMENDED)",
      initialValue: true,
    });

    if (setupAllowlist || forceAllowFrom) {
      next = await promptKookAllowFrom({
        cfg: next,
        prompter,
        accountId: kookAccountId,
      });
    }

    next = await promptKookGroupPolicy({ cfg: next, prompter });

    if (next.channels?.kook?.groupPolicy !== "disabled") {
      next = await promptKookGuilds({ cfg: next, prompter });
    }

    next = await promptKookNumericConfig({ cfg: next, prompter });

    next = await promptKookActions({ cfg: next, prompter });

    return { cfg: next, accountId: kookAccountId };
  },
};
