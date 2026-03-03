import { inspect } from "node:util";
import {
  Client,
  Command,
  ReadyListener,
  type BaseMessageInteractiveComponent,
  type Modal,
} from "@buape/carbon";
import { GatewayCloseCodes, type GatewayPlugin } from "@buape/carbon/gateway";
import { VoicePlugin } from "@buape/carbon/voice";
import { Routes } from "discord-api-types/v10";
import { resolveTextChunkLimit } from "../../auto-reply/chunk.js";
import { listNativeCommandSpecsForConfig } from "../../auto-reply/commands-registry.js";
import type { HistoryEntry } from "../../auto-reply/reply/history.js";
import { listSkillCommandsForAgents } from "../../auto-reply/skill-commands.js";
import {
  addAllowlistUserEntriesFromConfigEntry,
  buildAllowlistResolutionSummary,
  mergeAllowlist,
  resolveAllowlistIdAdditions,
  patchAllowlistUsersInConfigEntries,
  summarizeMapping,
} from "../../channels/allowlists/resolve-utils.js";
import {
  isNativeCommandsExplicitlyDisabled,
  resolveNativeCommandsEnabled,
  resolveNativeSkillsEnabled,
} from "../../config/commands.js";
import type { OpenClawConfig, ReplyToMode } from "../../config/config.js";
import { loadConfig } from "../../config/config.js";
import { isDangerousNameMatchingEnabled } from "../../config/dangerous-name-matching.js";
import {
  resolveOpenProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
} from "../../config/runtime-group-policy.js";
import { danger, logVerbose, shouldLogVerbose, warn } from "../../globals.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createDiscordRetryRunner } from "../../infra/retry-policy.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveAgentRoute } from "../../routing/resolve-route.js";
import { createNonExitingRuntime, type RuntimeEnv } from "../../runtime.js";
import { resolveDiscordAccount } from "../accounts.js";
import { fetchDiscordApplicationId } from "../probe.js";
import { resolveDiscordChannelAllowlist } from "../resolve-channels.js";
import { resolveDiscordUserAllowlist } from "../resolve-users.js";
import { normalizeDiscordToken } from "../token.js";
import { createDiscordVoiceCommand } from "../voice/command.js";
import { DiscordVoiceManager } from "../voice/manager.js";
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
import { createExecApprovalButton, DiscordExecApprovalHandler } from "./exec-approvals.js";
import { attachEarlyGatewayErrorGuard } from "./gateway-error-guard.js";
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
  createDiscordNativeCommand,
} from "./native-command.js";
import { resolveDiscordPresenceUpdate } from "./presence.js";
import { runDiscordGatewayLifecycle } from "./provider.lifecycle.js";
import { resolveDiscordRestFetch } from "./rest-fetch.js";
import { registerSiblingBot } from "./sibling-bots.js";
import type { DiscordMonitorStatusSink } from "./status.js";
import {
  createNoopThreadBindingManager,
  createThreadBindingManager,
  reconcileAcpThreadBindingsOnStartup,
} from "./thread-bindings.js";
import { formatThreadBindingDurationLabel } from "./thread-bindings.messages.js";
import { loadThreadParticipants } from "./thread-participants.js";

export type MonitorDiscordOpts = {
  token?: string;
  accountId?: string;
  config?: OpenClawConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  mediaMaxMb?: number;
  historyLimit?: number;
  replyToMode?: ReplyToMode;
  setStatus?: DiscordMonitorStatusSink;
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

const DEFAULT_THREAD_BINDING_IDLE_HOURS = 24;
const DEFAULT_THREAD_BINDING_MAX_AGE_HOURS = 0;

function normalizeThreadBindingHours(raw: unknown): number | undefined {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return undefined;
  }
  if (raw < 0) {
    return undefined;
  }
  return raw;
}

function resolveThreadBindingIdleTimeoutMs(params: {
  channelIdleHoursRaw: unknown;
  sessionIdleHoursRaw: unknown;
}): number {
  const idleHours =
    normalizeThreadBindingHours(params.channelIdleHoursRaw) ??
    normalizeThreadBindingHours(params.sessionIdleHoursRaw) ??
    DEFAULT_THREAD_BINDING_IDLE_HOURS;
  return Math.floor(idleHours * 60 * 60 * 1000);
}

function resolveThreadBindingMaxAgeMs(params: {
  channelMaxAgeHoursRaw: unknown;
  sessionMaxAgeHoursRaw: unknown;
}): number {
  const maxAgeHours =
    normalizeThreadBindingHours(params.channelMaxAgeHoursRaw) ??
    normalizeThreadBindingHours(params.sessionMaxAgeHoursRaw) ??
    DEFAULT_THREAD_BINDING_MAX_AGE_HOURS;
  return Math.floor(maxAgeHours * 60 * 60 * 1000);
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

function formatThreadBindingDurationForConfigLabel(durationMs: number): string {
  const label = formatThreadBindingDurationLabel(durationMs);
  return label === "disabled" ? "off" : label;
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

  const discordCfg = account.config;
  const discordRootThreadBindings = cfg.channels?.discord?.threadBindings;
  const discordAccountThreadBindings =
    cfg.channels?.discord?.accounts?.[account.accountId]?.threadBindings;
  const discordRestFetch = resolveDiscordRestFetch(discordCfg.proxy, runtime);
  const dmConfig = discordCfg.dm;
  let guildEntries = discordCfg.guilds;
  const defaultGroupPolicy = cfg.channels?.defaults?.groupPolicy;
  const groupPolicy = discordCfg.groupPolicy ?? defaultGroupPolicy ?? "open";
  if (
    discordCfg.groupPolicy === undefined &&
    discordCfg.guilds === undefined &&
    defaultGroupPolicy === undefined &&
    groupPolicy === "open"
  ) {
    runtime.log?.(
      warn(
        'discord: groupPolicy defaults to "open" when channels.discord is missing; set channels.discord.groupPolicy (or channels.defaults.groupPolicy) or add channels.discord.guilds to restrict access.',
      ),
    );
  }
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
  const threadBindingIdleTimeoutMs = resolveThreadBindingIdleTimeoutMs({
    channelIdleHoursRaw:
      discordAccountThreadBindings?.idleHours ?? discordRootThreadBindings?.idleHours,
    sessionIdleHoursRaw: cfg.session?.threadBindings?.idleHours,
  });
  const threadBindingMaxAgeMs = resolveThreadBindingMaxAgeMs({
    channelMaxAgeHoursRaw:
      discordAccountThreadBindings?.maxAgeHours ?? discordRootThreadBindings?.maxAgeHours,
    sessionMaxAgeHoursRaw: cfg.session?.threadBindings?.maxAgeHours,
  });
  const threadBindingsEnabled = resolveThreadBindingsEnabled({
    channelEnabledRaw: discordAccountThreadBindings?.enabled ?? discordRootThreadBindings?.enabled,
    sessionEnabledRaw: cfg.session?.threadBindings?.enabled,
  });
  const groupDmEnabled = dmConfig?.groupEnabled ?? false;
  const groupDmChannels = dmConfig?.groupChannels;
  const allowNameMatching = isDangerousNameMatchingEnabled(discordCfg);
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
  const sessionPrefix = "discord:slash";
  const ephemeralDefault = true;

  if (token) {
    if (guildEntries && Object.keys(guildEntries).length > 0) {
      try {
        const entries: Array<{ input: string; guildKey: string; channelKey?: string }> = [];
        for (const [guildKey, guildCfg] of Object.entries(guildEntries)) {
          if (guildKey === "*") {
            continue;
          }
          const channels = guildCfg?.channels ?? {};
          const channelKeys = Object.keys(channels).filter((key) => key !== "*");
          if (channelKeys.length === 0) {
            const input = /^\d+$/.test(guildKey) ? `guild:${guildKey}` : guildKey;
            entries.push({ input, guildKey });
            continue;
          }
          for (const channelKey of channelKeys) {
            entries.push({
              input: `${guildKey}/${channelKey}`,
              guildKey,
              channelKey,
            });
          }
        }
        if (entries.length > 0) {
          const resolved = await resolveDiscordChannelAllowlist({
            token,
            entries: entries.map((entry) => entry.input),
            fetcher: discordRestFetch,
          });
          const nextGuilds = { ...guildEntries };
          const mapping: string[] = [];
          const unresolved: string[] = [];
          for (const entry of resolved) {
            const source = entries.find((item) => item.input === entry.input);
            if (!source) {
              continue;
            }
            const sourceGuild = guildEntries?.[source.guildKey] ?? {};
            if (!entry.resolved || !entry.guildId) {
              unresolved.push(entry.input);
              continue;
            }
            mapping.push(
              entry.channelId
                ? `${entry.input}→${entry.guildId}/${entry.channelId}`
                : `${entry.input}→${entry.guildId}`,
            );
            const existing = nextGuilds[entry.guildId] ?? {};
            const mergedChannels = { ...sourceGuild.channels, ...existing.channels };
            const mergedGuild = { ...sourceGuild, ...existing, channels: mergedChannels };
            nextGuilds[entry.guildId] = mergedGuild;
            if (source.channelKey && entry.channelId) {
              const sourceChannel = sourceGuild.channels?.[source.channelKey];
              if (sourceChannel) {
                nextGuilds[entry.guildId] = {
                  ...mergedGuild,
                  channels: {
                    ...mergedChannels,
                    [entry.channelId]: {
                      ...sourceChannel,
                      ...mergedChannels?.[entry.channelId],
                    },
                  },
                };
              }
            }
          }
          guildEntries = nextGuilds;
          summarizeMapping("discord channels", mapping, unresolved, runtime);
        }
      } catch (err) {
        runtime.log?.(
          `discord channel resolve failed; using config entries. ${formatErrorMessage(err)}`,
        );
      }
    }

    const allowEntries =
      allowFrom?.filter((entry) => String(entry).trim() && String(entry).trim() !== "*") ?? [];
    if (allowEntries.length > 0) {
      try {
        const resolvedUsers = await resolveDiscordUserAllowlist({
          token,
          entries: allowEntries.map((entry) => String(entry)),
          fetcher: discordRestFetch,
        });
        const { mapping, unresolved, additions } = buildAllowlistResolutionSummary(resolvedUsers);
        allowFrom = mergeAllowlist({ existing: allowFrom, additions });
        summarizeMapping("discord users", mapping, unresolved, runtime);
      } catch (err) {
        runtime.log?.(
          `discord user resolve failed; using config entries. ${formatErrorMessage(err)}`,
        );
      }
    }

    if (guildEntries && Object.keys(guildEntries).length > 0) {
      const userEntries = new Set<string>();
      for (const guild of Object.values(guildEntries)) {
        if (!guild || typeof guild !== "object") {
          continue;
        }
        addAllowlistUserEntriesFromConfigEntry(userEntries, guild);
        const channels = (guild as { channels?: Record<string, unknown> }).channels ?? {};
        for (const channel of Object.values(channels)) {
          addAllowlistUserEntriesFromConfigEntry(userEntries, channel);
        }
      }

      if (userEntries.size > 0) {
        try {
          const resolvedUsers = await resolveDiscordUserAllowlist({
            token,
            entries: Array.from(userEntries),
            fetcher: discordRestFetch,
          });
          const { resolvedMap, mapping, unresolved } =
            buildAllowlistResolutionSummary(resolvedUsers);

          const nextGuilds = { ...guildEntries };
          for (const [guildKey, guildConfig] of Object.entries(guildEntries ?? {})) {
            if (!guildConfig || typeof guildConfig !== "object") {
              continue;
            }
            const nextGuild = { ...guildConfig } as Record<string, unknown>;
            const users = (guildConfig as { users?: string[] }).users;
            if (Array.isArray(users) && users.length > 0) {
              const additions = resolveAllowlistIdAdditions({ existing: users, resolvedMap });
              nextGuild.users = mergeAllowlist({ existing: users, additions });
            }
            const channels = (guildConfig as { channels?: Record<string, unknown> }).channels ?? {};
            if (channels && typeof channels === "object") {
              nextGuild.channels = patchAllowlistUsersInConfigEntries({
                entries: channels,
                resolvedMap,
              });
            }
            nextGuilds[guildKey] = nextGuild;
          }
          guildEntries = nextGuilds;
          summarizeMapping("discord channel users", mapping, unresolved, runtime);
        } catch (err) {
          runtime.log?.(
            `discord channel user resolve failed; using config entries. ${formatErrorMessage(err)}`,
          );
        }
      }
    }
  }

  if (shouldLogVerbose()) {
    logVerbose(
      `discord: config dm=${dmEnabled ? "on" : "off"} dmPolicy=${dmPolicy} allowFrom=${summarizeAllowList(allowFrom)} groupDm=${groupDmEnabled ? "on" : "off"} groupDmChannels=${summarizeAllowList(groupDmChannels)} groupPolicy=${groupPolicy} guilds=${summarizeGuilds(guildEntries)} historyLimit=${historyLimit} mediaMaxMb=${Math.round(mediaMaxBytes / (1024 * 1024))} native=${nativeEnabled ? "on" : "off"} nativeSkills=${nativeSkillsEnabled ? "on" : "off"} accessGroups=${useAccessGroups ? "on" : "off"} threadBindings=${threadBindingsEnabled ? "on" : "off"} threadIdleTimeout=${formatThreadBindingDurationForConfigLabel(threadBindingIdleTimeoutMs)} threadMaxAge=${formatThreadBindingDurationForConfigLabel(threadBindingMaxAgeMs)}`,
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
  const voiceEnabled = discordCfg.voice?.enabled ?? false;
  const voiceManagerRef: { current: DiscordVoiceManager | null } = { current: null };
  const threadBindings = threadBindingsEnabled
    ? createThreadBindingManager({
        accountId: account.accountId,
        token,
        idleTimeoutMs: threadBindingIdleTimeoutMs,
        maxAgeMs: threadBindingMaxAgeMs,
      })
    : createNoopThreadBindingManager(account.accountId);
  if (threadBindingsEnabled) {
    const reconciliation = reconcileAcpThreadBindingsOnStartup({
      cfg,
      accountId: account.accountId,
      sendFarewell: false,
    });
    if (reconciliation.removed > 0) {
      logVerbose(
        `discord: removed ${reconciliation.removed}/${reconciliation.checked} stale ACP thread bindings on startup for account ${account.accountId}`,
      );
    }
  }
  let lifecycleStarted = false;
  let releaseEarlyGatewayErrorGuard = () => {};
  try {
    const commands = commandSpecs.map((spec) =>
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
        }) as unknown as Command,
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

    const clientPlugins = [
      createDiscordGatewayPlugin({ discordConfig: discordCfg, runtime }),
      ...(voiceEnabled ? [new VoicePlugin()] : []),
    ];
    // Pass eventQueue config to Carbon so the listener timeout can be tuned.
    // Default listenerTimeout is 120s (Carbon defaults to 30s which is too short for LLM calls).
    const eventQueueOpts = {
      listenerTimeout: 120_000,
      ...discordCfg.eventQueue,
    };
    const client = new Client(
      {
        baseUrl: "http://localhost",
        deploySecret: "a",
        clientId: applicationId,
        publicKey: "a",
        token,
        autoDeploy: false,
        eventQueue: eventQueueOpts,
      },
      {
        commands,
        listeners: [new DiscordStatusReadyListener()],
        components,
        modals,
      },
      clientPlugins,
    );
    const earlyGatewayErrorGuard = attachEarlyGatewayErrorGuard(client);
    releaseEarlyGatewayErrorGuard = earlyGatewayErrorGuard.release;

    await deployDiscordCommands({ client, runtime, enabled: nativeEnabled });

    const logger = createSubsystemLogger("discord/monitor");
    const guildHistories = new Map<string, HistoryEntry[]>();
    let botUserId: string | undefined;
    let botUserName: string | undefined;

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
      botUserName = botUser?.username?.trim() || botUser?.globalName?.trim() || undefined;
      if (botUserId) {
        registerSiblingBot(botUserId, account.accountId);
        // Dual registration: also register with resolved agentId for collaborate() lookups
        try {
          const freshCfg = loadConfig();
          const dummyRoute = resolveAgentRoute({
            cfg: freshCfg,
            channel: "discord",
            accountId: account.accountId,
          });
          if (dummyRoute.agentId && dummyRoute.agentId !== account.accountId) {
            registerSiblingBot(botUserId, dummyRoute.agentId);
          }
        } catch {
          // Non-critical: accountId registration is sufficient as fallback
        }
      }
    } catch (err) {
      runtime.error?.(danger(`discord: failed to fetch bot identity: ${String(err)}`));
    }

    // Restore thread participant map from disk (safe degradation if missing)
    try {
      loadThreadParticipants();
    } catch (err) {
      runtime.log?.(
        `discord: thread participant restore failed (mention-only mode): ${String(err)}`,
      );
    }

    const voiceManager = voiceEnabled
      ? new DiscordVoiceManager({
          client,
          cfg,
          discordConfig: discordCfg,
          accountId: account.accountId,
          runtime,
          botUserId,
        })
      : null;
    voiceManagerRef.current = voiceManager;

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
    const trackInboundEvent = opts.setStatus
      ? () => {
          const at = Date.now();
          opts.setStatus?.({ lastEventAt: at, lastInboundAt: at });
        }
      : undefined;

    registerDiscordListener(
      client.listeners,
      new DiscordMessageListener(messageHandler, logger, trackInboundEvent),
    );
    registerDiscordListener(
      client.listeners,
      new DiscordReactionListener({
        cfg,
        accountId: account.accountId,
        runtime,
        botUserId,
        dmEnabled,
        groupDmEnabled,
        groupDmChannels: groupDmChannels ?? [],
        dmPolicy,
        allowFrom: allowFrom ?? [],
        groupPolicy,
        allowNameMatching,
        guildEntries,
        logger,
        onEvent: trackInboundEvent,
      }),
    );
    registerDiscordListener(
      client.listeners,
      new DiscordReactionRemoveListener({
        cfg,
        accountId: account.accountId,
        runtime,
        botUserId,
        dmEnabled,
        groupDmEnabled,
        groupDmChannels: groupDmChannels ?? [],
        dmPolicy,
        allowFrom: allowFrom ?? [],
        groupPolicy,
        allowNameMatching,
        guildEntries,
        logger,
        onEvent: trackInboundEvent,
      }),
    );

    if (discordCfg.intents?.presence) {
      registerDiscordListener(
        client.listeners,
        new DiscordPresenceListener({ logger, accountId: account.accountId }),
      );
      runtime.log?.("discord: GuildPresences intent enabled — presence listener registered");
    }

    const botIdentity =
      botUserId && botUserName ? `${botUserId} (${botUserName})` : (botUserId ?? botUserName ?? "");
    runtime.log?.(`logged in to discord${botIdentity ? ` as ${botIdentity}` : ""}`);

    const isDiscordDisallowedIntentsError = (err: unknown): boolean => {
      const message = String(err);
      return (
        message.includes(String(GatewayCloseCodes.DisallowedIntents)) ||
        message.includes("Disallowed") ||
        message.includes("disallowed")
      );
    };

    lifecycleStarted = true;
    await runDiscordGatewayLifecycle({
      accountId: account.accountId,
      client,
      runtime,
      abortSignal: opts.abortSignal,
      statusSink: opts.setStatus,
      isDisallowedIntentsError: isDiscordDisallowedIntentsError,
      voiceManager,
      voiceManagerRef,
      execApprovalsHandler,
      threadBindings,
      botUserId,
      pendingGatewayErrors: earlyGatewayErrorGuard.pendingErrors,
      releaseEarlyGatewayErrorGuard,
    });
  } finally {
    releaseEarlyGatewayErrorGuard();
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
  resolveDiscordRestFetch,
  resolveDiscordRuntimeGroupPolicy: resolveOpenProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  resolveThreadBindingsEnabled,
};
