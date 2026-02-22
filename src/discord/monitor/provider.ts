import { inspect } from "node:util";
import {
  Client,
  ReadyListener,
  type BaseCommand,
  type BaseMessageInteractiveComponent,
  type Modal,
  type Plugin,
} from "@buape/carbon";
import { GatewayCloseCodes, type GatewayPlugin } from "@buape/carbon/gateway";
import { VoicePlugin } from "@buape/carbon/voice";
import { Routes } from "discord-api-types/v10";
import { resolveTextChunkLimit } from "../../auto-reply/chunk.js";
import { listNativeCommandSpecsForConfig } from "../../auto-reply/commands-registry.js";
import type { HistoryEntry } from "../../auto-reply/reply/history.js";
import { listSkillCommandsForAgents } from "../../auto-reply/skill-commands.js";
import {
  isNativeCommandsExplicitlyDisabled,
  resolveNativeCommandsEnabled,
  resolveNativeSkillsEnabled,
} from "../../config/commands.js";
import type { OpenClawConfig, ReplyToMode } from "../../config/config.js";
import { loadConfig } from "../../config/config.js";
import {
  GROUP_POLICY_BLOCKED_LABEL,
  resolveOpenProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  warnMissingProviderGroupPolicyFallbackOnce,
} from "../../config/runtime-group-policy.js";
import { danger, logVerbose, shouldLogVerbose, warn } from "../../globals.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createDiscordRetryRunner } from "../../infra/retry-policy.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { createNonExitingRuntime, type RuntimeEnv } from "../../runtime.js";
import { resolveDiscordAccount } from "../accounts.js";
import { fetchDiscordApplicationId } from "../probe.js";
import { normalizeDiscordToken } from "../token.js";
import { createDiscordVoiceCommand } from "../voice/command.js";
import { DiscordVoiceManager, DiscordVoiceReadyListener } from "../voice/manager.js";
import {
  createAgentComponentButton,
  createAgentSelectMenu,
  createDiscordComponentButton,
  createDiscordComponentChannelSelect,
  createDiscordComponentMentionableSelect,
  createDiscordComponentModal,
  createDiscordComponentRoleSelect,
  createDiscordComponentStringSelect,
  createDiscordComponentUserSelect,
} from "./agent-components.js";
import { resolveDiscordSlashCommandConfig } from "./commands.js";
import { createExecApprovalButton, DiscordExecApprovalHandler } from "./exec-approvals.js";
import { createDiscordGatewayPlugin } from "./gateway-plugin.js";
import {
  DiscordMessageListener,
  DiscordPresenceListener,
  DiscordReactionListener,
  DiscordReactionRemoveListener,
  registerDiscordListener,
} from "./listeners.js";
import { createDiscordMessageHandler } from "./message-handler.js";
import {
  createDiscordCommandArgFallbackButton,
  createDiscordModelPickerFallbackButton,
  createDiscordModelPickerFallbackSelect,
  createDiscordNativeCommand,
} from "./native-command.js";
import { resolveDiscordPresenceUpdate } from "./presence.js";
import { resolveDiscordAllowlistConfig } from "./provider.allowlist.js";
import { runDiscordGatewayLifecycle } from "./provider.lifecycle.js";
import { resolveDiscordRestFetch } from "./rest-fetch.js";
import { createNoopThreadBindingManager, createThreadBindingManager } from "./thread-bindings.js";

export type MonitorDiscordOpts = {
  token?: string;
  accountId?: string;
  config?: OpenClawConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  mediaMaxMb?: number;
  historyLimit?: number;
  replyToMode?: ReplyToMode;
};

function summarizeAllowList(list?: string[]) {
  if (!list || list.length === 0) {
    return "any";
  }
  const sample = list.slice(0, 4).map((entry) => String(entry));
  const suffix = list.length > sample.length ? ` (+${list.length - sample.length})` : "";
  return `${sample.join(", ")}${suffix}`;
}

function summarizeGuilds(entries?: Record<string, unknown>) {
  if (!entries || Object.keys(entries).length === 0) {
    return "any";
  }
  const keys = Object.keys(entries);
  const sample = keys.slice(0, 4);
  const suffix = keys.length > sample.length ? ` (+${keys.length - sample.length})` : "";
  return `${sample.join(", ")}${suffix}`;
}

const DEFAULT_THREAD_BINDING_TTL_HOURS = 24;

function normalizeThreadBindingTtlHours(raw: unknown): number | undefined {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return undefined;
  }
  if (raw < 0) {
    return undefined;
  }
  return raw;
}

function resolveThreadBindingSessionTtlMs(params: {
  channelTtlHoursRaw: unknown;
  sessionTtlHoursRaw: unknown;
}): number {
  const ttlHours =
    normalizeThreadBindingTtlHours(params.channelTtlHoursRaw) ??
    normalizeThreadBindingTtlHours(params.sessionTtlHoursRaw) ??
    DEFAULT_THREAD_BINDING_TTL_HOURS;
  return Math.floor(ttlHours * 60 * 60 * 1000);
}

function normalizeThreadBindingsEnabled(raw: unknown): boolean | undefined {
  if (typeof raw !== "boolean") {
    return undefined;
  }
  return raw;
}

function resolveThreadBindingsEnabled(params: {
  channelEnabledRaw: unknown;
  sessionEnabledRaw: unknown;
}): boolean {
  return (
    normalizeThreadBindingsEnabled(params.channelEnabledRaw) ??
    normalizeThreadBindingsEnabled(params.sessionEnabledRaw) ??
    true
  );
}

function formatThreadBindingSessionTtlLabel(ttlMs: number): string {
  if (ttlMs <= 0) {
    return "off";
  }
  if (ttlMs < 60_000) {
    return "<1m";
  }
  const totalMinutes = Math.floor(ttlMs / 60_000);
  if (totalMinutes % 60 === 0) {
    return `${Math.floor(totalMinutes / 60)}h`;
  }
  return `${totalMinutes}m`;
}

function dedupeSkillCommandsForDiscord(
  skillCommands: ReturnType<typeof listSkillCommandsForAgents>,
) {
  const seen = new Set<string>();
  const deduped: ReturnType<typeof listSkillCommandsForAgents> = [];
  for (const command of skillCommands) {
    const key = command.skillName.trim().toLowerCase();
    if (!key) {
      deduped.push(command);
      continue;
    }
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(command);
  }
  return deduped;
}

async function deployDiscordCommands(params: {
  client: Client;
  runtime: RuntimeEnv;
  enabled: boolean;
}) {
  if (!params.enabled) {
    return;
  }
  const runWithRetry = createDiscordRetryRunner({ verbose: shouldLogVerbose() });
  try {
    await runWithRetry(() => params.client.handleDeployRequest(), "command deploy");
  } catch (err) {
    const details = formatDiscordDeployErrorDetails(err);
    params.runtime.error?.(
      danger(`discord: failed to deploy native commands: ${formatErrorMessage(err)}${details}`),
    );
  }
}

function formatDiscordDeployErrorDetails(err: unknown): string {
  if (!err || typeof err !== "object") {
    return "";
  }
  const status = (err as { status?: unknown }).status;
  const discordCode = (err as { discordCode?: unknown }).discordCode;
  const rawBody = (err as { rawBody?: unknown }).rawBody;
  const details: string[] = [];
  if (typeof status === "number") {
    details.push(`status=${status}`);
  }
  if (typeof discordCode === "number" || typeof discordCode === "string") {
    details.push(`code=${discordCode}`);
  }
  if (rawBody !== undefined) {
    let bodyText = "";
    try {
      bodyText = JSON.stringify(rawBody);
    } catch {
      bodyText =
        typeof rawBody === "string" ? rawBody : inspect(rawBody, { depth: 3, breakLength: 120 });
    }
    if (bodyText) {
      const maxLen = 800;
      const trimmed = bodyText.length > maxLen ? `${bodyText.slice(0, maxLen)}...` : bodyText;
      details.push(`body=${trimmed}`);
    }
  }
  return details.length > 0 ? ` (${details.join(", ")})` : "";
}

const DISCORD_DISALLOWED_INTENTS_CODE = GatewayCloseCodes.DisallowedIntents;

function isDiscordDisallowedIntentsError(err: unknown): boolean {
  if (!err) {
    return false;
  }
  const message = formatErrorMessage(err);
  return message.includes(String(DISCORD_DISALLOWED_INTENTS_CODE));
}

export async function monitorDiscordProvider(opts: MonitorDiscordOpts = {}) {
  const cfg = opts.config ?? loadConfig();
  const account = resolveDiscordAccount({
    cfg,
    accountId: opts.accountId,
  });
  const token = normalizeDiscordToken(opts.token ?? undefined) ?? account.token;
  if (!token) {
    throw new Error(
      `Discord bot token missing for account "${account.accountId}" (set discord.accounts.${account.accountId}.token or DISCORD_BOT_TOKEN for default).`,
    );
  }

  const runtime: RuntimeEnv = opts.runtime ?? createNonExitingRuntime();

  const rawDiscordCfg = account.config;
  const discordRootThreadBindings = cfg.channels?.discord?.threadBindings;
  const discordAccountThreadBindings =
    cfg.channels?.discord?.accounts?.[account.accountId]?.threadBindings;
  const discordRestFetch = resolveDiscordRestFetch(rawDiscordCfg.proxy, runtime);
  const dmConfig = rawDiscordCfg.dm;
  let guildEntries = rawDiscordCfg.guilds;
  const defaultGroupPolicy = resolveDefaultGroupPolicy(cfg);
  const providerConfigPresent = cfg.channels?.discord !== undefined;
  const { groupPolicy, providerMissingFallbackApplied } = resolveOpenProviderRuntimeGroupPolicy({
    providerConfigPresent,
    groupPolicy: rawDiscordCfg.groupPolicy,
    defaultGroupPolicy,
  });
  const discordCfg =
    rawDiscordCfg.groupPolicy === groupPolicy ? rawDiscordCfg : { ...rawDiscordCfg, groupPolicy };
  warnMissingProviderGroupPolicyFallbackOnce({
    providerMissingFallbackApplied,
    providerKey: "discord",
    accountId: account.accountId,
    blockedLabel: GROUP_POLICY_BLOCKED_LABEL.guild,
    log: (message) => runtime.log?.(warn(message)),
  });
  let allowFrom = discordCfg.allowFrom ?? dmConfig?.allowFrom;
  const mediaMaxBytes = (opts.mediaMaxMb ?? discordCfg.mediaMaxMb ?? 8) * 1024 * 1024;
  const textLimit = resolveTextChunkLimit(cfg, "discord", account.accountId, {
    fallbackLimit: 2000,
  });
  const historyLimit = Math.max(
    0,
    opts.historyLimit ?? discordCfg.historyLimit ?? cfg.messages?.groupChat?.historyLimit ?? 20,
  );
  const replyToMode = opts.replyToMode ?? discordCfg.replyToMode ?? "off";
  const dmEnabled = dmConfig?.enabled ?? true;
  const dmPolicy = discordCfg.dmPolicy ?? dmConfig?.policy ?? "pairing";
  const threadBindingSessionTtlMs = resolveThreadBindingSessionTtlMs({
    channelTtlHoursRaw:
      discordAccountThreadBindings?.ttlHours ?? discordRootThreadBindings?.ttlHours,
    sessionTtlHoursRaw: cfg.session?.threadBindings?.ttlHours,
  });
  const threadBindingsEnabled = resolveThreadBindingsEnabled({
    channelEnabledRaw: discordAccountThreadBindings?.enabled ?? discordRootThreadBindings?.enabled,
    sessionEnabledRaw: cfg.session?.threadBindings?.enabled,
  });
  const groupDmEnabled = dmConfig?.groupEnabled ?? false;
  const groupDmChannels = dmConfig?.groupChannels;
  const nativeEnabled = resolveNativeCommandsEnabled({
    providerId: "discord",
    providerSetting: discordCfg.commands?.native,
    globalSetting: cfg.commands?.native,
  });
  const nativeSkillsEnabled = resolveNativeSkillsEnabled({
    providerId: "discord",
    providerSetting: discordCfg.commands?.nativeSkills,
    globalSetting: cfg.commands?.nativeSkills,
  });
  const nativeDisabledExplicit = isNativeCommandsExplicitlyDisabled({
    providerSetting: discordCfg.commands?.native,
    globalSetting: cfg.commands?.native,
  });
  const useAccessGroups = cfg.commands?.useAccessGroups !== false;
  const slashCommand = resolveDiscordSlashCommandConfig(discordCfg.slashCommand);
  const sessionPrefix = "discord:slash";
  const ephemeralDefault = slashCommand.ephemeral;
  const voiceEnabled = discordCfg.voice?.enabled !== false;

  const allowlistResolved = await resolveDiscordAllowlistConfig({
    token,
    guildEntries,
    allowFrom,
    fetcher: discordRestFetch,
    runtime,
  });
  guildEntries = allowlistResolved.guildEntries;
  allowFrom = allowlistResolved.allowFrom;

  if (shouldLogVerbose()) {
    logVerbose(
      `discord: config dm=${dmEnabled ? "on" : "off"} dmPolicy=${dmPolicy} allowFrom=${summarizeAllowList(allowFrom)} groupDm=${groupDmEnabled ? "on" : "off"} groupDmChannels=${summarizeAllowList(groupDmChannels)} groupPolicy=${groupPolicy} guilds=${summarizeGuilds(guildEntries)} historyLimit=${historyLimit} mediaMaxMb=${Math.round(mediaMaxBytes / (1024 * 1024))} native=${nativeEnabled ? "on" : "off"} nativeSkills=${nativeSkillsEnabled ? "on" : "off"} accessGroups=${useAccessGroups ? "on" : "off"} threadBindings=${threadBindingsEnabled ? "on" : "off"} threadSessionTtl=${formatThreadBindingSessionTtlLabel(threadBindingSessionTtlMs)}`,
    );
  }

  const applicationId = await fetchDiscordApplicationId(token, 4000, discordRestFetch);
  if (!applicationId) {
    throw new Error("Failed to resolve Discord application id");
  }

  const maxDiscordCommands = 100;
  let skillCommands =
    nativeEnabled && nativeSkillsEnabled
      ? dedupeSkillCommandsForDiscord(listSkillCommandsForAgents({ cfg }))
      : [];
  let commandSpecs = nativeEnabled
    ? listNativeCommandSpecsForConfig(cfg, { skillCommands, provider: "discord" })
    : [];
  const initialCommandCount = commandSpecs.length;
  if (nativeEnabled && nativeSkillsEnabled && commandSpecs.length > maxDiscordCommands) {
    skillCommands = [];
    commandSpecs = listNativeCommandSpecsForConfig(cfg, { skillCommands: [], provider: "discord" });
    runtime.log?.(
      warn(
        `discord: ${initialCommandCount} commands exceeds limit; removing per-skill commands and keeping /skill.`,
      ),
    );
  }
  if (nativeEnabled && commandSpecs.length > maxDiscordCommands) {
    runtime.log?.(
      warn(
        `discord: ${commandSpecs.length} commands exceeds limit; some commands may fail to deploy.`,
      ),
    );
  }
  const voiceManagerRef: { current: DiscordVoiceManager | null } = { current: null };
  const threadBindings = threadBindingsEnabled
    ? createThreadBindingManager({
        accountId: account.accountId,
        token,
        sessionTtlMs: threadBindingSessionTtlMs,
      })
    : createNoopThreadBindingManager(account.accountId);
  let lifecycleStarted = false;
  try {
    const commands: BaseCommand[] = commandSpecs.map((spec) =>
      createDiscordNativeCommand({
        command: spec,
        cfg,
        discordConfig: discordCfg,
        accountId: account.accountId,
        sessionPrefix,
        ephemeralDefault,
        threadBindings,
      }),
    );
    if (nativeEnabled && voiceEnabled) {
      commands.push(
        createDiscordVoiceCommand({
          cfg,
          discordConfig: discordCfg,
          accountId: account.accountId,
          groupPolicy,
          useAccessGroups,
          getManager: () => voiceManagerRef.current,
          ephemeralDefault,
        }),
      );
    }

    // Initialize exec approvals handler if enabled
    const execApprovalsConfig = discordCfg.execApprovals ?? {};
    const execApprovalsHandler = execApprovalsConfig.enabled
      ? new DiscordExecApprovalHandler({
          token,
          accountId: account.accountId,
          config: execApprovalsConfig,
          cfg,
          runtime,
        })
      : null;

    const agentComponentsConfig = discordCfg.agentComponents ?? {};
    const agentComponentsEnabled = agentComponentsConfig.enabled ?? true;

    const components: BaseMessageInteractiveComponent[] = [
      createDiscordCommandArgFallbackButton({
        cfg,
        discordConfig: discordCfg,
        accountId: account.accountId,
        sessionPrefix,
        threadBindings,
      }),
      createDiscordModelPickerFallbackButton({
        cfg,
        discordConfig: discordCfg,
        accountId: account.accountId,
        sessionPrefix,
        threadBindings,
      }),
      createDiscordModelPickerFallbackSelect({
        cfg,
        discordConfig: discordCfg,
        accountId: account.accountId,
        sessionPrefix,
        threadBindings,
      }),
    ];
    const modals: Modal[] = [];

    if (execApprovalsHandler) {
      components.push(createExecApprovalButton({ handler: execApprovalsHandler }));
    }

    if (agentComponentsEnabled) {
      const componentContext = {
        cfg,
        discordConfig: discordCfg,
        accountId: account.accountId,
        guildEntries,
        allowFrom,
        dmPolicy,
        runtime,
        token,
      };
      components.push(createAgentComponentButton(componentContext));
      components.push(createAgentSelectMenu(componentContext));
      components.push(createDiscordComponentButton(componentContext));
      components.push(createDiscordComponentStringSelect(componentContext));
      components.push(createDiscordComponentUserSelect(componentContext));
      components.push(createDiscordComponentRoleSelect(componentContext));
      components.push(createDiscordComponentMentionableSelect(componentContext));
      components.push(createDiscordComponentChannelSelect(componentContext));
      modals.push(createDiscordComponentModal(componentContext));
    }

    class DiscordStatusReadyListener extends ReadyListener {
      async handle(_data: unknown, client: Client) {
        const gateway = client.getPlugin<GatewayPlugin>("gateway");
        if (!gateway) {
          return;
        }

        const presence = resolveDiscordPresenceUpdate(discordCfg);
        if (!presence) {
          return;
        }

        gateway.updatePresence(presence);
      }
    }

    const clientPlugins: Plugin[] = [
      createDiscordGatewayPlugin({ discordConfig: discordCfg, runtime }),
    ];
    if (voiceEnabled) {
      clientPlugins.push(new VoicePlugin());
    }
    const client = new Client(
      {
        baseUrl: "http://localhost",
        deploySecret: "a",
        clientId: applicationId,
        publicKey: "a",
        token,
        autoDeploy: false,
      },
      {
        commands,
        listeners: [new DiscordStatusReadyListener()],
        components,
        modals,
      },
      clientPlugins,
    );

    await deployDiscordCommands({ client, runtime, enabled: nativeEnabled });

    const logger = createSubsystemLogger("discord/monitor");
    const guildHistories = new Map<string, HistoryEntry[]>();
    let botUserId: string | undefined;
    let voiceManager: DiscordVoiceManager | null = null;

    if (nativeDisabledExplicit) {
      await clearDiscordNativeCommands({
        client,
        applicationId,
        runtime,
      });
    }

    try {
      const botUser = await client.fetchUser("@me");
      botUserId = botUser?.id;
    } catch (err) {
      runtime.error?.(danger(`discord: failed to fetch bot identity: ${String(err)}`));
    }

    if (voiceEnabled) {
      voiceManager = new DiscordVoiceManager({
        client,
        cfg,
        discordConfig: discordCfg,
        accountId: account.accountId,
        runtime,
        botUserId,
      });
      voiceManagerRef.current = voiceManager;
      registerDiscordListener(client.listeners, new DiscordVoiceReadyListener(voiceManager));
    }

    const messageHandler = createDiscordMessageHandler({
      cfg,
      discordConfig: discordCfg,
      accountId: account.accountId,
      token,
      runtime,
      botUserId,
      guildHistories,
      historyLimit,
      mediaMaxBytes,
      textLimit,
      replyToMode,
      dmEnabled,
      groupDmEnabled,
      groupDmChannels,
      allowFrom,
      guildEntries,
      threadBindings,
    });

    registerDiscordListener(client.listeners, new DiscordMessageListener(messageHandler, logger));
    registerDiscordListener(
      client.listeners,
      new DiscordReactionListener({
        cfg,
        accountId: account.accountId,
        runtime,
        botUserId,
        guildEntries,
        logger,
      }),
    );
    registerDiscordListener(
      client.listeners,
      new DiscordReactionRemoveListener({
        cfg,
        accountId: account.accountId,
        runtime,
        botUserId,
        guildEntries,
        logger,
      }),
    );

    if (discordCfg.intents?.presence) {
      registerDiscordListener(
        client.listeners,
        new DiscordPresenceListener({ logger, accountId: account.accountId }),
      );
      runtime.log?.("discord: GuildPresences intent enabled — presence listener registered");
    }

    runtime.log?.(`logged in to discord${botUserId ? ` as ${botUserId}` : ""}`);

    lifecycleStarted = true;
    await runDiscordGatewayLifecycle({
      accountId: account.accountId,
      client,
      runtime,
      abortSignal: opts.abortSignal,
      isDisallowedIntentsError: isDiscordDisallowedIntentsError,
      voiceManager,
      voiceManagerRef,
      execApprovalsHandler,
      threadBindings,
    });
  } finally {
    if (!lifecycleStarted) {
      threadBindings.stop();
    }
  }
}

async function clearDiscordNativeCommands(params: {
  client: Client;
  applicationId: string;
  runtime: RuntimeEnv;
}) {
  try {
    await params.client.rest.put(Routes.applicationCommands(params.applicationId), {
      body: [],
    });
    logVerbose("discord: cleared native commands (commands.native=false)");
  } catch (err) {
    params.runtime.error?.(danger(`discord: failed to clear native commands: ${String(err)}`));
  }
}

export const __testing = {
  createDiscordGatewayPlugin,
  dedupeSkillCommandsForDiscord,
  resolveDiscordRuntimeGroupPolicy: resolveOpenProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  resolveDiscordRestFetch,
  resolveThreadBindingsEnabled,
};
