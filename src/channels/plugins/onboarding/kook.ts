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
type KookOnboardingLocale = "en" | "zh-CN";

function tr(locale: KookOnboardingLocale, en: string, zh: string): string {
  return locale === "zh-CN" ? zh : en;
}

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
        dm: {
          ...cfg.channels?.kook?.dm,
          policy: dmPolicy,
          ...(allowFrom ? { allowFrom } : {}),
        },
      },
    },
  } as OpenClawConfig;
}

async function noteKookTokenHelp(
  prompter: WizardPrompter,
  locale: KookOnboardingLocale,
): Promise<void> {
  await prompter.note(
    [
      tr(
        locale,
        "1) Open KOOK Developer Portal: https://developer.kookapp.cn",
        "1) 打开 KOOK 开发者平台：https://developer.kookapp.cn",
      ),
      tr(locale, "2) Create a bot and get the token", "2) 创建 Bot 并获取 Token"),
      tr(locale, "3) Token looks like a JWT string", "3) Token 通常是类似 JWT 的字符串"),
      tr(
        locale,
        "Tip: you can also set KOOK_BOT_TOKEN in your env.",
        "提示：你也可以通过环境变量设置 KOOK_BOT_TOKEN。",
      ),
      tr(
        locale,
        "Docs: https://docs.openclaw.ai/channels/kook",
        "文档：https://docs.openclaw.ai/channels/kook",
      ),
    ].join("\n"),
    tr(locale, "KOOK bot token", "KOOK Bot Token"),
  );
}

async function promptKookAllowFrom(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  accountId: string;
  locale: KookOnboardingLocale;
}): Promise<OpenClawConfig> {
  const { cfg, prompter, accountId, locale } = params;
  const resolved = resolveKookAccount({ cfg, accountId });
  const existingAllowFrom = resolved.config.dm?.allowFrom ?? [];
  const entry = await prompter.text({
    message: tr(locale, "KOOK allowFrom (user id)", "KOOK allowFrom（用户 ID）"),
    placeholder: tr(locale, "123456789", "例如：123456789"),
    initialValue: existingAllowFrom[0] ? String(existingAllowFrom[0]) : undefined,
    validate: (value: unknown) => {
      const raw =
        typeof value === "string"
          ? value.trim()
          : typeof value === "number"
            ? String(value).trim()
            : "";
      if (!raw) {
        return tr(locale, "Required", "必填");
      }
      if (!/^\d+$/.test(raw)) {
        return tr(locale, "Use a numeric KOOK user id", "请输入纯数字 KOOK 用户 ID");
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
  locale: KookOnboardingLocale;
}): Promise<OpenClawConfig> {
  const { cfg, prompter, locale } = params;

  const configureNumeric = await prompter.confirm({
    message: tr(
      locale,
      "Configure numeric settings (history limit, media size, text chunk)?",
      "是否配置数值项（历史条数、媒体大小、文本分块）？",
    ),
    initialValue: false,
  });

  if (!configureNumeric) {
    return cfg;
  }

  const historyLimit = await prompter.text({
    message: tr(locale, "History limit (number of messages to fetch)", "历史消息条数（拉取数量）"),
    placeholder: tr(locale, "10", "例如：10"),
    initialValue: String(cfg.channels?.kook?.historyLimit ?? 10),
    validate: (value) => {
      const num = Number(value);
      if (isNaN(num) || num < 1) {
        return tr(locale, "Must be a positive number", "必须是正数");
      }
      return undefined;
    },
  });

  const mediaMaxMb = await prompter.text({
    message: tr(locale, "Media max size (MB)", "媒体大小上限（MB）"),
    placeholder: tr(locale, "10", "例如：10"),
    initialValue: String(cfg.channels?.kook?.mediaMaxMb ?? 10),
    validate: (value) => {
      const num = Number(value);
      if (isNaN(num) || num < 1) {
        return tr(locale, "Must be a positive number", "必须是正数");
      }
      return undefined;
    },
  });

  const textChunkLimit = await prompter.text({
    message: tr(locale, "Text chunk limit (characters)", "文本分块上限（字符）"),
    placeholder: tr(locale, "2000", "例如：2000"),
    initialValue: String(cfg.channels?.kook?.textChunkLimit ?? 2000),
    validate: (value) => {
      const num = Number(value);
      if (isNaN(num) || num < 100) {
        return tr(locale, "Must be at least 100", "最小为 100");
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
  locale: KookOnboardingLocale;
}): Promise<OpenClawConfig> {
  const { cfg, prompter, locale } = params;

  const configurePolicy = await prompter.confirm({
    message: tr(locale, "Configure group/server access policy?", "是否配置群组/服务器访问策略？"),
    initialValue: false,
  });

  if (!configurePolicy) {
    return cfg;
  }

  const policy = await prompter.select({
    message: tr(locale, "Group/Server access policy", "群组/服务器访问策略"),
    options: [
      { value: "open", label: tr(locale, "Open - allow all servers", "开放：允许所有服务器") },
      {
        value: "allowlist",
        label: tr(locale, "Allowlist - only configured servers", "白名单：仅允许已配置服务器"),
      },
      {
        value: "disabled",
        label: tr(locale, "Disabled - no server access", "禁用：不允许服务器访问"),
      },
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
  locale: KookOnboardingLocale;
}): Promise<OpenClawConfig> {
  const { cfg, prompter, locale } = params;

  const existingGuilds = cfg.channels?.kook?.guilds ?? {};
  const guildIds = Object.keys(existingGuilds);

  const addGuild = await prompter.confirm({
    message:
      guildIds.length > 0
        ? tr(locale, "Configure additional guilds/servers?", "是否继续配置其他服务器？")
        : tr(locale, "Configure specific guilds/servers?", "是否配置指定服务器？"),
    initialValue: false,
  });

  if (!addGuild) {
    return cfg;
  }

  const newGuilds = { ...existingGuilds };

  while (true) {
    const guildId = await prompter.text({
      message: tr(
        locale,
        "Guild ID (numeric) or leave empty to finish",
        "服务器 ID（数字），留空结束",
      ),
      placeholder: tr(locale, "6367541001667830", "例如：6367541001667830"),
      validate: (value) => {
        if (!value?.trim()) {
          return undefined;
        }
        if (!/^\d+$/.test(value)) {
          return tr(locale, "Must be numeric", "必须是数字");
        }
        return undefined;
      },
    });

    if (!guildId?.trim()) {
      break;
    }

    const slug = await prompter.text({
      message: tr(locale, "Guild slug/alias (optional)", "服务器别名（可选）"),
      placeholder: tr(locale, "main-server", "例如：main-server"),
    });

    const requireMention = await prompter.confirm({
      message: tr(locale, "Require @mention in this guild?", "该服务器是否必须 @提及？"),
      initialValue: existingGuilds[guildId]?.requireMention ?? false,
    });

    const channelIds: string[] = [];
    while (true) {
      const channelId = await prompter.text({
        message: tr(
          locale,
          "Channel ID to allow (numeric) or leave empty to finish",
          "允许的频道 ID（数字），留空结束",
        ),
        placeholder: tr(locale, "5265829152322102", "例如：5265829152322102"),
      });
      if (!channelId?.trim()) {
        break;
      }
      if (!/^\d+$/.test(channelId)) {
        await prompter.note(
          tr(locale, "Channel ID must be numeric", "频道 ID 必须是数字"),
          tr(locale, "Invalid input", "输入无效"),
        );
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
        message: tr(
          locale,
          "User ID allowed in this guild (numeric) or leave empty",
          "该服务器允许的用户 ID（数字），留空结束",
        ),
        placeholder: tr(locale, "1567351889", "例如：1567351889"),
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
      message: tr(locale, "Add another guild?", "是否继续添加服务器？"),
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
  locale: KookOnboardingLocale;
}): Promise<OpenClawConfig> {
  const { cfg, prompter, locale } = params;
  const existing = cfg.channels?.kook?.actions ?? {};

  const configureActions = await prompter.confirm({
    message: tr(locale, "Configure feature toggles (actions)?", "是否配置功能开关（actions）？"),
    initialValue: false,
  });

  if (!configureActions) {
    return cfg;
  }

  const actions = {
    // Messaging
    messages: await prompter.confirm({
      message: tr(
        locale,
        "Enable message send/read/edit/delete actions?",
        "启用消息发送/读取/编辑/删除能力？",
      ),
      initialValue: existing.messages ?? true,
    }),

    // User Queries
    getMe: await prompter.confirm({
      message: tr(locale, "Enable getMe (bot self info)?", "启用 getMe（机器人自身信息）？"),
      initialValue: existing.getMe ?? true,
    }),
    getUser: await prompter.confirm({
      message: tr(locale, "Enable getUser (user lookup)?", "启用 getUser（用户查询）？"),
      initialValue: existing.getUser ?? true,
    }),

    // Guild Queries
    getGuildList: await prompter.confirm({
      message: tr(locale, "Enable getGuildList?", "启用 getGuildList？"),
      initialValue: existing.getGuildList ?? true,
    }),
    getGuild: await prompter.confirm({
      message: tr(locale, "Enable getGuild?", "启用 getGuild？"),
      initialValue: existing.getGuild ?? true,
    }),
    getGuildUserCount: await prompter.confirm({
      message: tr(locale, "Enable getGuildUserCount?", "启用 getGuildUserCount？"),
      initialValue: existing.getGuildUserCount ?? true,
    }),
    getGuildUsers: await prompter.confirm({
      message: tr(locale, "Enable getGuildUsers?", "启用 getGuildUsers？"),
      initialValue: existing.getGuildUsers ?? true,
    }),

    // Channel Queries
    getChannel: await prompter.confirm({
      message: tr(locale, "Enable getChannel?", "启用 getChannel？"),
      initialValue: existing.getChannel ?? true,
    }),
    getChannelList: await prompter.confirm({
      message: tr(locale, "Enable getChannelList?", "启用 getChannelList？"),
      initialValue: existing.getChannelList ?? true,
    }),
    getChannelUserList: await prompter.confirm({
      message: tr(locale, "Enable getChannelUserList?", "启用 getChannelUserList？"),
      initialValue: existing.getChannelUserList ?? true,
    }),

    // Group toggles
    guildInfo: await prompter.confirm({
      message: tr(locale, "Enable guildInfo group?", "启用 guildInfo 分组？"),
      initialValue: existing.guildInfo ?? true,
    }),
    channelInfo: await prompter.confirm({
      message: tr(locale, "Enable channelInfo group?", "启用 channelInfo 分组？"),
      initialValue: existing.channelInfo ?? true,
    }),
    roleInfo: await prompter.confirm({
      message: tr(locale, "Enable roleInfo (read-only)?", "启用 roleInfo（只读）？"),
      initialValue: existing.roleInfo ?? true,
    }),
    emojiList: await prompter.confirm({
      message: tr(locale, "Enable emojiList (read-only)?", "启用 emojiList（只读）？"),
      initialValue: existing.emojiList ?? true,
    }),

    // Write operations (default enabled for role management)
    roles: await prompter.confirm({
      message: tr(locale, "Enable role write operations?", "启用角色写操作？"),
      initialValue: existing.roles ?? true,
    }),
    channels: await prompter.confirm({
      message: tr(locale, "Enable channel write operations?", "启用频道写操作？"),
      initialValue: existing.channels ?? false,
    }),
    memberInfo: await prompter.confirm({
      message: tr(locale, "Enable member info write operations?", "启用成员信息写操作？"),
      initialValue: existing.memberInfo ?? false,
    }),
    moderation: await prompter.confirm({
      message: tr(locale, "Enable moderation operations?", "启用管理操作（moderation）？"),
      initialValue: existing.moderation ?? false,
    }),
    emojiUploads: await prompter.confirm({
      message: tr(locale, "Enable emoji upload operations?", "启用表情上传操作？"),
      initialValue: existing.emojiUploads ?? false,
    }),
    voiceStatus: await prompter.confirm({
      message: tr(locale, "Enable voice status operations?", "启用语音状态操作？"),
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
  policyKey: "channels.kook.dm.policy",
  allowFromKey: "channels.kook.dm.allowFrom",
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
      locale: "en",
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
    const useChinese = await prompter.confirm({
      message: "Use Chinese for KOOK onboarding prompts? / 使用中文进行 KOOK 配置引导？",
      initialValue: true,
    });
    const locale: KookOnboardingLocale = useChinese ? "zh-CN" : "en";

    // ===== STEP 0: Permission confirmation =====
    await prompter.note(
      [
        tr(locale, "KOOK Bot Permission Configuration", "KOOK 机器人权限配置"),
        "",
        tr(
          locale,
          "To protect your server security, please confirm the permission configuration:",
          "为保障服务器安全，请确认权限配置：",
        ),
        "",
        tr(
          locale,
          "If not configured, the following default permissions will be used:",
          "如不自定义，将使用以下默认权限：",
        ),
        tr(locale, "  - Send messages, send direct messages", "  - 发送消息、发送私聊"),
        tr(locale, "  - Get user info, guild info, channel info", "  - 查询用户、服务器、频道信息"),
        tr(
          locale,
          "  - No create/delete/update roles or channels",
          "  - 不允许创建/删除/修改角色与频道",
        ),
        tr(locale, "  - No kick/mute users", "  - 不允许踢人/禁言"),
        tr(locale, "  - No other admin operations", "  - 不允许其他管理操作"),
        "",
        tr(
          locale,
          "Tip: Permission settings can be changed in the config file at any time",
          "提示：权限配置可随时在配置文件中修改",
        ),
      ].join("\n"),
      tr(locale, "KOOK Permission Configuration", "KOOK 权限配置"),
    );

    const configurePermissions = await prompter.confirm({
      message: tr(
        locale,
        "Configure KOOK Bot permissions in detail? (Recommended for advanced users)",
        "是否详细配置 KOOK 机器人权限？（更适合高级用户）",
      ),
      initialValue: false,
    });

    // Initialize default actions config
    let defaultActions: Record<string, boolean> = {};

    if (!configurePermissions) {
      // ===== Quick start: default read-only config =====
      defaultActions = {
        // Messaging
        messages: true,
        // Read operations
        getMe: true,
        getUser: true,
        getGuildList: true,
        getGuild: true,
        getGuildUserCount: true,
        getGuildUsers: true,
        getChannel: true,
        getChannelList: true,
        getChannelUserList: true,
        roleInfo: true,
        emojiList: true,
        // Write operations / grouped gates
        roles: false,
        channels: false,
        memberInfo: false,
        moderation: false,
        emojiUploads: false,
        guildInfo: true,
        channelInfo: true,
        voiceStatus: false,
      };
    }

    // Save defaults to cfg
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
      await noteKookTokenHelp(prompter, locale);
    }
    if (canUseEnv && !resolvedAccount.config.token) {
      const keepEnv = await prompter.confirm({
        message: tr(
          locale,
          "KOOK_BOT_TOKEN detected. Use env var?",
          "检测到 KOOK_BOT_TOKEN，是否直接使用环境变量？",
        ),
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
            message: tr(locale, "Enter KOOK bot token", "请输入 KOOK Bot Token"),
            validate: (value) => (value?.trim() ? undefined : tr(locale, "Required", "必填")),
          }),
        ).trim();
      }
    } else if (hasConfigToken) {
      const keep = await prompter.confirm({
        message: tr(
          locale,
          "KOOK token already configured. Keep it?",
          "已检测到 KOOK Token，是否保留？",
        ),
        initialValue: true,
      });
      if (!keep) {
        token = String(
          await prompter.text({
            message: tr(locale, "Enter KOOK bot token", "请输入 KOOK Bot Token"),
            validate: (value) => (value?.trim() ? undefined : tr(locale, "Required", "必填")),
          }),
        ).trim();
      }
    } else {
      token = String(
        await prompter.text({
          message: tr(locale, "Enter KOOK bot token", "请输入 KOOK Bot Token"),
          validate: (value) => (value?.trim() ? undefined : tr(locale, "Required", "必填")),
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
        tr(locale, "SECURITY WARNING", "安全警告"),
        "",
        tr(
          locale,
          "Without an allowlist, your bot will respond to EVERYONE's commands.",
          "如果不设置白名单，机器人会响应所有人的命令。",
        ),
        tr(locale, "This poses serious risks including:", "这会带来严重风险，包括："),
        tr(locale, "  - Unauthorized access to your system", "  - 未授权访问你的系统"),
        tr(locale, "  - Potential file deletion or data loss", "  - 可能发生文件删除或数据丢失"),
        tr(locale, "  - Abuse of bot capabilities", "  - 机器人能力被滥用"),
        "",
        tr(
          locale,
          "STRONGLY RECOMMENDED: Set up an allowlist to restrict who can use the bot.",
          "强烈建议：立即配置白名单，限制可使用机器人的用户。",
        ),
      ].join("\n"),
      tr(locale, "Security Warning", "安全提醒"),
    );

    const setupAllowlist = await prompter.confirm({
      message: tr(
        locale,
        "Set up allowlist now? (STRONGLY RECOMMENDED)",
        "是否现在配置白名单？（强烈建议）",
      ),
      initialValue: true,
    });

    if (setupAllowlist || forceAllowFrom) {
      next = await promptKookAllowFrom({
        cfg: next,
        prompter,
        accountId: kookAccountId,
        locale,
      });
    }

    next = await promptKookGroupPolicy({ cfg: next, prompter, locale });

    if (next.channels?.kook?.groupPolicy !== "disabled") {
      next = await promptKookGuilds({ cfg: next, prompter, locale });
    }

    next = await promptKookNumericConfig({ cfg: next, prompter, locale });

    next = await promptKookActions({ cfg: next, prompter, locale });

    return { cfg: next, accountId: kookAccountId };
  },
};
