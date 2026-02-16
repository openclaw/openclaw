import type { listChannelPlugins } from "../channels/plugins/index.js";
import type { ChannelId } from "../channels/plugins/types.js";
import type { OpenClawConfig } from "../config/config.js";
import type { SecurityAuditFinding, SecurityAuditSeverity } from "./audit.js";
import { resolveChannelDefaultAccountId } from "../channels/plugins/helpers.js";
import { formatCliCommand } from "../cli/command-format.js";
import { resolveNativeCommandsEnabled, resolveNativeSkillsEnabled } from "../config/commands.js";
import { readChannelAllowFromStore } from "../pairing/pairing-store.js";

function normalizeAllowFromList(list: Array<string | number> | undefined | null): string[] {
  if (!Array.isArray(list)) {
    return [];
  }
  return list.map((v) => String(v).trim()).filter(Boolean);
}

function normalizeTelegramAllowFromEntry(raw: unknown): string {
  const base = typeof raw === "string" ? raw : typeof raw === "number" ? String(raw) : "";
  return base
    .trim()
    .replace(/^(telegram|tg):/i, "")
    .trim();
}

function isNumericTelegramUserId(raw: string): boolean {
  return /^\d+$/.test(raw);
}

function classifyChannelWarningSeverity(message: string): SecurityAuditSeverity {
  const s = message.toLowerCase();
  if (
    s.includes("dms: open") ||
    s.includes('grouppolicy="open"') ||
    s.includes('dmpolicy="open"')
  ) {
    return "critical";
  }
  if (s.includes("allows any") || s.includes("anyone can dm") || s.includes("public")) {
    return "critical";
  }
  if (s.includes("locked") || s.includes("disabled")) {
    return "info";
  }
  return "warn";
}

export async function collectChannelSecurityFindings(params: {
  cfg: OpenClawConfig;
  plugins: ReturnType<typeof listChannelPlugins>;
}): Promise<SecurityAuditFinding[]> {
  const findings: SecurityAuditFinding[] = [];

  const coerceNativeSetting = (value: unknown): boolean | "auto" | undefined => {
    if (value === true) {
      return true;
    }
    if (value === false) {
      return false;
    }
    if (value === "auto") {
      return "auto";
    }
    return undefined;
  };

  const warnDmPolicy = async (input: {
    label: string;
    provider: ChannelId;
    dmPolicy: string;
    allowFrom?: Array<string | number> | null;
    policyPath?: string;
    allowFromPath: string;
    normalizeEntry?: (raw: string) => string;
  }) => {
    const policyPath = input.policyPath ?? `${input.allowFromPath}policy`;
    const configAllowFrom = normalizeAllowFromList(input.allowFrom);
    const hasWildcard = configAllowFrom.includes("*");
    const dmScope = params.cfg.session?.dmScope ?? "main";
    const storeAllowFrom = await readChannelAllowFromStore(input.provider).catch(() => []);
    const normalizeEntry = input.normalizeEntry ?? ((value: string) => value);
    const normalizedCfg = configAllowFrom
      .filter((value) => value !== "*")
      .map((value) => normalizeEntry(value))
      .map((value) => value.trim())
      .filter(Boolean);
    const normalizedStore = storeAllowFrom
      .map((value) => normalizeEntry(value))
      .map((value) => value.trim())
      .filter(Boolean);
    const allowCount = Array.from(new Set([...normalizedCfg, ...normalizedStore])).length;
    const isMultiUserDm = hasWildcard || allowCount > 1;

    if (input.dmPolicy === "open") {
      const allowFromKey = `${input.allowFromPath}allowFrom`;
      findings.push({
        checkId: `channels.${input.provider}.dm.open`,
        severity: "critical",
        title: `${input.label} DMs are open`,
        detail: `${policyPath}="open" allows anyone to DM the bot.`,
        remediation: `Use pairing/allowlist; if you really need open DMs, ensure ${allowFromKey} includes "*".`,
      });
      if (!hasWildcard) {
        findings.push({
          checkId: `channels.${input.provider}.dm.open_invalid`,
          severity: "warn",
          title: `${input.label} DM config looks inconsistent`,
          detail: `"open" requires ${allowFromKey} to include "*".`,
        });
      }
    }

    if (input.dmPolicy === "disabled") {
      findings.push({
        checkId: `channels.${input.provider}.dm.disabled`,
        severity: "info",
        title: `${input.label} DMs are disabled`,
        detail: `${policyPath}="disabled" ignores inbound DMs.`,
      });
      return;
    }

    if (dmScope === "main" && isMultiUserDm) {
      findings.push({
        checkId: `channels.${input.provider}.dm.scope_main_multiuser`,
        severity: "warn",
        title: `${input.label} DMs share the main session`,
        detail:
          "Multiple DM senders currently share the main session, which can leak context across users.",
        remediation:
          "Run: " +
          formatCliCommand('openclaw config set session.dmScope "per-channel-peer"') +
          ' (or "per-account-channel-peer" for multi-account channels) to isolate DM sessions per sender.',
      });
    }
  };

  for (const plugin of params.plugins) {
    if (!plugin.security) {
      continue;
    }
    const accountIds = plugin.config.listAccountIds(params.cfg);
    const defaultAccountId = resolveChannelDefaultAccountId({
      plugin,
      cfg: params.cfg,
      accountIds,
    });
    const account = plugin.config.resolveAccount(params.cfg, defaultAccountId);
    const enabled = plugin.config.isEnabled ? plugin.config.isEnabled(account, params.cfg) : true;
    if (!enabled) {
      continue;
    }
    const configured = plugin.config.isConfigured
      ? await plugin.config.isConfigured(account, params.cfg)
      : true;
    if (!configured) {
      continue;
    }

    if (plugin.id === "discord") {
      const discordCfg =
        (account as { config?: Record<string, unknown> } | null)?.config ??
        ({} as Record<string, unknown>);
      const nativeEnabled = resolveNativeCommandsEnabled({
        providerId: "discord",
        providerSetting: coerceNativeSetting(
          (discordCfg.commands as { native?: unknown } | undefined)?.native,
        ),
        globalSetting: params.cfg.commands?.native,
      });
      const nativeSkillsEnabled = resolveNativeSkillsEnabled({
        providerId: "discord",
        providerSetting: coerceNativeSetting(
          (discordCfg.commands as { nativeSkills?: unknown } | undefined)?.nativeSkills,
        ),
        globalSetting: params.cfg.commands?.nativeSkills,
      });
      const slashEnabled = nativeEnabled || nativeSkillsEnabled;
      if (slashEnabled) {
        const defaultGroupPolicy = params.cfg.channels?.defaults?.groupPolicy;
        const groupPolicy =
          (discordCfg.groupPolicy as string | undefined) ?? defaultGroupPolicy ?? "allowlist";
        const guildEntries = (discordCfg.guilds as Record<string, unknown> | undefined) ?? {};
        const guildsConfigured = Object.keys(guildEntries).length > 0;
        const hasAnyUserAllowlist = Object.values(guildEntries).some((guild) => {
          if (!guild || typeof guild !== "object") {
            return false;
          }
          const g = guild as Record<string, unknown>;
          if (Array.isArray(g.users) && g.users.length > 0) {
            return true;
          }
          const channels = g.channels;
          if (!channels || typeof channels !== "object") {
            return false;
          }
          return Object.values(channels as Record<string, unknown>).some((channel) => {
            if (!channel || typeof channel !== "object") {
              return false;
            }
            const c = channel as Record<string, unknown>;
            return Array.isArray(c.users) && c.users.length > 0;
          });
        });
        const dmAllowFromRaw = (discordCfg.dm as { allowFrom?: unknown } | undefined)?.allowFrom;
        const dmAllowFrom = Array.isArray(dmAllowFromRaw) ? dmAllowFromRaw : [];
        const storeAllowFrom = await readChannelAllowFromStore("discord").catch(() => []);
        const ownerAllowFromConfigured =
          normalizeAllowFromList([...dmAllowFrom, ...storeAllowFrom]).length > 0;

        const useAccessGroups = params.cfg.commands?.useAccessGroups !== false;
        if (
          !useAccessGroups &&
          groupPolicy !== "disabled" &&
          guildsConfigured &&
          !hasAnyUserAllowlist
        ) {
          findings.push({
            checkId: "channels.discord.commands.native.unrestricted",
            severity: "critical",
            title: "Discord slash commands are unrestricted",
            detail:
              "commands.useAccessGroups=false disables sender allowlists for Discord slash commands unless a per-guild/channel users allowlist is configured; with no users allowlist, any user in allowed guild channels can invoke /… commands.",
            remediation:
              "Set commands.useAccessGroups=true (recommended), or configure channels.discord.guilds.<id>.users (or channels.discord.guilds.<id>.channels.<channel>.users).",
          });
        } else if (
          useAccessGroups &&
          groupPolicy !== "disabled" &&
          guildsConfigured &&
          !ownerAllowFromConfigured &&
          !hasAnyUserAllowlist
        ) {
          findings.push({
            checkId: "channels.discord.commands.native.no_allowlists",
            severity: "warn",
            title: "Discord slash commands have no allowlists",
            detail:
              "Discord slash commands are enabled, but neither an owner allowFrom list nor any per-guild/channel users allowlist is configured; /… commands will be rejected for everyone.",
            remediation:
              "Add your user id to channels.discord.allowFrom (or approve yourself via pairing), or configure channels.discord.guilds.<id>.users.",
          });
        }
      }
    }

    if (plugin.id === "slack") {
      const slackCfg =
        (account as { config?: Record<string, unknown>; dm?: Record<string, unknown> } | null)
          ?.config ?? ({} as Record<string, unknown>);
      const nativeEnabled = resolveNativeCommandsEnabled({
        providerId: "slack",
        providerSetting: coerceNativeSetting(
          (slackCfg.commands as { native?: unknown } | undefined)?.native,
        ),
        globalSetting: params.cfg.commands?.native,
      });
      const nativeSkillsEnabled = resolveNativeSkillsEnabled({
        providerId: "slack",
        providerSetting: coerceNativeSetting(
          (slackCfg.commands as { nativeSkills?: unknown } | undefined)?.nativeSkills,
        ),
        globalSetting: params.cfg.commands?.nativeSkills,
      });
      const slashCommandEnabled =
        nativeEnabled ||
        nativeSkillsEnabled ||
        (slackCfg.slashCommand as { enabled?: unknown } | undefined)?.enabled === true;
      if (slashCommandEnabled) {
        const useAccessGroups = params.cfg.commands?.useAccessGroups !== false;
        if (!useAccessGroups) {
          findings.push({
            checkId: "channels.slack.commands.slash.useAccessGroups_off",
            severity: "critical",
            title: "Slack slash commands bypass access groups",
            detail:
              "Slack slash/native commands are enabled while commands.useAccessGroups=false; this can allow unrestricted /… command execution from channels/users you didn't explicitly authorize.",
            remediation: "Set commands.useAccessGroups=true (recommended).",
          });
        } else {
          const allowFromRaw = (
            account as
              | { config?: { allowFrom?: unknown }; dm?: { allowFrom?: unknown } }
              | null
              | undefined
          )?.config?.allowFrom;
          const legacyAllowFromRaw = (
            account as { dm?: { allowFrom?: unknown } } | null | undefined
          )?.dm?.allowFrom;
          const allowFrom = Array.isArray(allowFromRaw)
            ? allowFromRaw
            : Array.isArray(legacyAllowFromRaw)
              ? legacyAllowFromRaw
              : [];
          const storeAllowFrom = await readChannelAllowFromStore("slack").catch(() => []);
          const ownerAllowFromConfigured =
            normalizeAllowFromList([...allowFrom, ...storeAllowFrom]).length > 0;
          const channels = (slackCfg.channels as Record<string, unknown> | undefined) ?? {};
          const hasAnyChannelUsersAllowlist = Object.values(channels).some((value) => {
            if (!value || typeof value !== "object") {
              return false;
            }
            const channel = value as Record<string, unknown>;
            return Array.isArray(channel.users) && channel.users.length > 0;
          });
          if (!ownerAllowFromConfigured && !hasAnyChannelUsersAllowlist) {
            findings.push({
              checkId: "channels.slack.commands.slash.no_allowlists",
              severity: "warn",
              title: "Slack slash commands have no allowlists",
              detail:
                "Slack slash/native commands are enabled, but neither an owner allowFrom list nor any channels.<id>.users allowlist is configured; /… commands will be rejected for everyone.",
              remediation:
                "Approve yourself via pairing (recommended), or set channels.slack.allowFrom and/or channels.slack.channels.<id>.users.",
            });
          }
        }
      }
    }

    const dmPolicy = plugin.security.resolveDmPolicy?.({
      cfg: params.cfg,
      accountId: defaultAccountId,
      account,
    });
    if (dmPolicy) {
      await warnDmPolicy({
        label: plugin.meta.label ?? plugin.id,
        provider: plugin.id,
        dmPolicy: dmPolicy.policy,
        allowFrom: dmPolicy.allowFrom,
        policyPath: dmPolicy.policyPath,
        allowFromPath: dmPolicy.allowFromPath,
        normalizeEntry: dmPolicy.normalizeEntry,
      });
    }

    if (plugin.security.collectWarnings) {
      const warnings = await plugin.security.collectWarnings({
        cfg: params.cfg,
        accountId: defaultAccountId,
        account,
      });
      for (const message of warnings ?? []) {
        const trimmed = String(message).trim();
        if (!trimmed) {
          continue;
        }
        findings.push({
          checkId: `channels.${plugin.id}.warning.${findings.length + 1}`,
          severity: classifyChannelWarningSeverity(trimmed),
          title: `${plugin.meta.label ?? plugin.id} security warning`,
          detail: trimmed.replace(/^-\s*/, ""),
        });
      }
    }

    if (plugin.id === "telegram") {
      const allowTextCommands = params.cfg.commands?.text !== false;
      if (!allowTextCommands) {
        continue;
      }

      const telegramCfg =
        (account as { config?: Record<string, unknown> } | null)?.config ??
        ({} as Record<string, unknown>);
      const defaultGroupPolicy = params.cfg.channels?.defaults?.groupPolicy;
      const groupPolicy =
        (telegramCfg.groupPolicy as string | undefined) ?? defaultGroupPolicy ?? "allowlist";
      const groups = telegramCfg.groups as Record<string, unknown> | undefined;
      const groupsConfigured = Boolean(groups) && Object.keys(groups ?? {}).length > 0;
      const groupAccessPossible =
        groupPolicy === "open" || (groupPolicy === "allowlist" && groupsConfigured);
      if (!groupAccessPossible) {
        continue;
      }

      const storeAllowFrom = await readChannelAllowFromStore("telegram").catch(() => []);
      const storeHasWildcard = storeAllowFrom.some((v) => String(v).trim() === "*");
      const invalidTelegramAllowFromEntries = new Set<string>();
      for (const entry of storeAllowFrom) {
        const normalized = normalizeTelegramAllowFromEntry(entry);
        if (!normalized || normalized === "*") {
          continue;
        }
        if (!isNumericTelegramUserId(normalized)) {
          invalidTelegramAllowFromEntries.add(normalized);
        }
      }
      const groupAllowFrom = Array.isArray(telegramCfg.groupAllowFrom)
        ? telegramCfg.groupAllowFrom
        : [];
      const groupAllowFromHasWildcard = groupAllowFrom.some((v) => String(v).trim() === "*");
      for (const entry of groupAllowFrom) {
        const normalized = normalizeTelegramAllowFromEntry(entry);
        if (!normalized || normalized === "*") {
          continue;
        }
        if (!isNumericTelegramUserId(normalized)) {
          invalidTelegramAllowFromEntries.add(normalized);
        }
      }
      const dmAllowFrom = Array.isArray(telegramCfg.allowFrom) ? telegramCfg.allowFrom : [];
      for (const entry of dmAllowFrom) {
        const normalized = normalizeTelegramAllowFromEntry(entry);
        if (!normalized || normalized === "*") {
          continue;
        }
        if (!isNumericTelegramUserId(normalized)) {
          invalidTelegramAllowFromEntries.add(normalized);
        }
      }
      const anyGroupOverride = Boolean(
        groups &&
        Object.values(groups).some((value) => {
          if (!value || typeof value !== "object") {
            return false;
          }
          const group = value as Record<string, unknown>;
          const allowFrom = Array.isArray(group.allowFrom) ? group.allowFrom : [];
          if (allowFrom.length > 0) {
            for (const entry of allowFrom) {
              const normalized = normalizeTelegramAllowFromEntry(entry);
              if (!normalized || normalized === "*") {
                continue;
              }
              if (!isNumericTelegramUserId(normalized)) {
                invalidTelegramAllowFromEntries.add(normalized);
              }
            }
            return true;
          }
          const topics = group.topics;
          if (!topics || typeof topics !== "object") {
            return false;
          }
          return Object.values(topics as Record<string, unknown>).some((topicValue) => {
            if (!topicValue || typeof topicValue !== "object") {
              return false;
            }
            const topic = topicValue as Record<string, unknown>;
            const topicAllow = Array.isArray(topic.allowFrom) ? topic.allowFrom : [];
            for (const entry of topicAllow) {
              const normalized = normalizeTelegramAllowFromEntry(entry);
              if (!normalized || normalized === "*") {
                continue;
              }
              if (!isNumericTelegramUserId(normalized)) {
                invalidTelegramAllowFromEntries.add(normalized);
              }
            }
            return topicAllow.length > 0;
          });
        }),
      );

      const hasAnySenderAllowlist =
        storeAllowFrom.length > 0 || groupAllowFrom.length > 0 || anyGroupOverride;

      if (invalidTelegramAllowFromEntries.size > 0) {
        const examples = Array.from(invalidTelegramAllowFromEntries).slice(0, 5);
        const more =
          invalidTelegramAllowFromEntries.size > examples.length
            ? ` (+${invalidTelegramAllowFromEntries.size - examples.length} more)`
            : "";
        findings.push({
          checkId: "channels.telegram.allowFrom.invalid_entries",
          severity: "warn",
          title: "Telegram allowlist contains non-numeric entries",
          detail:
            "Telegram sender authorization requires numeric Telegram user IDs. " +
            `Found non-numeric allowFrom entries: ${examples.join(", ")}${more}.`,
          remediation:
            "Replace @username entries with numeric Telegram user IDs (use onboarding to resolve), then re-run the audit.",
        });
      }

      if (storeHasWildcard || groupAllowFromHasWildcard) {
        findings.push({
          checkId: "channels.telegram.groups.allowFrom.wildcard",
          severity: "critical",
          title: "Telegram group allowlist contains wildcard",
          detail:
            'Telegram group sender allowlist contains "*", which allows any group member to run /… commands and control directives.',
          remediation:
            'Remove "*" from channels.telegram.groupAllowFrom and pairing store; prefer explicit numeric Telegram user IDs.',
        });
        continue;
      }

      if (!hasAnySenderAllowlist) {
        const providerSetting = (telegramCfg.commands as { nativeSkills?: unknown } | undefined)
          // oxlint-disable-next-line typescript/no-explicit-any
          ?.nativeSkills as any;
        const skillsEnabled = resolveNativeSkillsEnabled({
          providerId: "telegram",
          providerSetting,
          globalSetting: params.cfg.commands?.nativeSkills,
        });
        findings.push({
          checkId: "channels.telegram.groups.allowFrom.missing",
          severity: "critical",
          title: "Telegram group commands have no sender allowlist",
          detail:
            `Telegram group access is enabled but no sender allowlist is configured; this allows any group member to invoke /… commands` +
            (skillsEnabled ? " (including skill commands)." : "."),
          remediation:
            "Approve yourself via pairing (recommended), or set channels.telegram.groupAllowFrom (or per-group groups.<id>.allowFrom).",
        });
      }
    }
  }

  return findings;
}
