import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { parseOptionalDelimitedEntries } from "../../channels/plugins/helpers.js";
import { getChannelPlugin } from "../../channels/plugins/index.js";
import { moveSingleAccountChannelSectionToDefaultAccount } from "../../channels/plugins/setup-helpers.js";
import type { ChannelSetupPlugin } from "../../channels/plugins/setup-wizard-types.js";
import type { ChannelSetupInput } from "../../channels/plugins/types.js";
import { replaceConfigFile, type OpenClawConfig } from "../../config/config.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../../routing/session-key.js";
import { defaultRuntime, type RuntimeEnv } from "../../runtime.js";
import { createClackPrompter } from "../../wizard/clack-prompter.js";
import { applyAgentBindings, describeBinding } from "../agents.bindings.js";
import { resolveInstallableChannelPlugin } from "../channel-setup/channel-plugin-resolution.js";
import {
  createChannelOnboardingPostWriteHookCollector,
  runCollectedChannelOnboardingPostWriteHooks,
} from "../onboard-channels.js";
import type { ChannelChoice } from "../onboard-types.js";
import { applyAccountName, applyChannelAccountConfig } from "./add-mutators.js";
import { channelLabel, requireValidConfigFileSnapshot, shouldUseWizard } from "./shared.js";

export type ChannelsAddOptions = {
  channel?: string;
  account?: string;
  initialSyncLimit?: number | string;
  groupChannels?: string;
  dmAllowlist?: string;
} & Omit<ChannelSetupInput, "groupChannels" | "dmAllowlist" | "initialSyncLimit">;

export async function channelsAddCommand(
  opts: ChannelsAddOptions,
  runtime: RuntimeEnv = defaultRuntime,
  params?: { hasFlags?: boolean },
) {
  const configSnapshot = await requireValidConfigFileSnapshot(runtime);
  if (!configSnapshot) {
    return;
  }
  const cfg = (configSnapshot.sourceConfig ?? configSnapshot.config) as OpenClawConfig;
  const baseHash = configSnapshot.hash;
  let nextConfig = cfg;

  const useWizard = shouldUseWizard(params);
  if (useWizard) {
    const [{ buildAgentSummaries }, { setupChannels }] = await Promise.all([
      import("../agents.config.js"),
      import("../onboard-channels.js"),
    ]);
    const prompter = createClackPrompter();
    const postWriteHooks = createChannelOnboardingPostWriteHookCollector();
    let selection: ChannelChoice[] = [];
    const accountIds: Partial<Record<ChannelChoice, string>> = {};
    const resolvedPlugins = new Map<ChannelChoice, ChannelSetupPlugin>();
    await prompter.intro("Channel setup");
    let nextConfig = await setupChannels(cfg, runtime, prompter, {
      allowDisable: false,
      allowSignalInstall: true,
      onPostWriteHook: (hook) => {
        postWriteHooks.collect(hook);
      },
      promptAccountIds: true,
      onSelection: (value) => {
        selection = value;
      },
      onAccountId: (channel, accountId) => {
        accountIds[channel] = accountId;
      },
      onResolvedPlugin: (channel, plugin) => {
        resolvedPlugins.set(channel, plugin);
      },
    });
    if (selection.length === 0) {
      await prompter.outro("No channels selected.");
      return;
    }

    const wantsNames = await prompter.confirm({
      message: "Add display names for these accounts? (optional)",
      initialValue: false,
    });
    if (wantsNames) {
      for (const channel of selection) {
        const accountId = accountIds[channel] ?? DEFAULT_ACCOUNT_ID;
        const plugin = resolvedPlugins.get(channel) ?? getChannelPlugin(channel);
        const account = plugin?.config.resolveAccount(nextConfig, accountId) as
          | { name?: string }
          | undefined;
        const snapshot = plugin?.config.describeAccount?.(account, nextConfig);
        const existingName = snapshot?.name ?? account?.name;
        const name = await prompter.text({
          message: `${channel} account name (${accountId})`,
          initialValue: existingName,
        });
        if (name?.trim()) {
          nextConfig = applyAccountName({
            cfg: nextConfig,
            channel,
            accountId,
            name,
            plugin,
          });
        }
      }
    }

    const bindTargets = selection
      .map((channel) => ({
        channel,
        accountId: accountIds[channel]?.trim(),
      }))
      .filter(
        (
          value,
        ): value is {
          channel: ChannelChoice;
          accountId: string;
        } => Boolean(value.accountId),
      );
    if (bindTargets.length > 0) {
      const bindNow = await prompter.confirm({
        message: "Bind configured channel accounts to agents now?",
        initialValue: true,
      });
      if (bindNow) {
        const agentSummaries = buildAgentSummaries(nextConfig);
        const defaultAgentId = resolveDefaultAgentId(nextConfig);
        for (const target of bindTargets) {
          const targetAgentId = await prompter.select({
            message: `Route ${target.channel} account "${target.accountId}" to agent`,
            options: agentSummaries.map((agent) => ({
              value: agent.id,
              label: agent.isDefault ? `${agent.id} (default)` : agent.id,
            })),
            initialValue: defaultAgentId,
          });
          const bindingResult = applyAgentBindings(nextConfig, [
            {
              agentId: targetAgentId,
              match: { channel: target.channel, accountId: target.accountId },
            },
          ]);
          nextConfig = bindingResult.config;
          if (bindingResult.added.length > 0 || bindingResult.updated.length > 0) {
            await prompter.note(
              [
                ...bindingResult.added.map((binding) => `Added: ${describeBinding(binding)}`),
                ...bindingResult.updated.map((binding) => `Updated: ${describeBinding(binding)}`),
              ].join("\n"),
              "Routing bindings",
            );
          }
          if (bindingResult.conflicts.length > 0) {
            await prompter.note(
              [
                "Skipped bindings already claimed by another agent:",
                ...bindingResult.conflicts.map(
                  (conflict) =>
                    `- ${describeBinding(conflict.binding)} (agent=${conflict.existingAgentId})`,
                ),
              ].join("\n"),
              "Routing bindings",
            );
          }
        }
      }
    }

    await replaceConfigFile({
      nextConfig,
      ...(baseHash !== undefined ? { baseHash } : {}),
    });
    await runCollectedChannelOnboardingPostWriteHooks({
      hooks: postWriteHooks.drain(),
      cfg: nextConfig,
      runtime,
    });
    await prompter.outro("Channels updated.");
    return;
  }

  const rawChannel = String(opts.channel ?? "");
  const resolution = await resolveInstallableChannelPlugin({
    cfg: nextConfig,
    runtime,
    rawChannel,
    prompter: createClackPrompter(),
    supports: (plugin) => Boolean(plugin.setup?.applyAccountConfig),
  });
  nextConfig = resolution.cfg;
  const channel = resolution.channelId;
  const plugin = resolution.plugin ?? (channel ? getChannelPlugin(channel) : undefined);

  if (resolution.installDeclined) {
    return;
  }

  if (!channel || !plugin?.setup?.applyAccountConfig) {
    const hint = resolution.catalogEntry
      ? `Plugin ${resolution.catalogEntry.meta.label} could not be loaded after install.`
      : `Unknown channel: ${String(opts.channel ?? "")}`;
    runtime.error(hint);
    runtime.exit(1);
    return;
  }
  const useEnv = opts.useEnv === true;
  const initialSyncLimit =
    typeof opts.initialSyncLimit === "number"
      ? opts.initialSyncLimit
      : typeof opts.initialSyncLimit === "string" && opts.initialSyncLimit.trim()
        ? Number.parseInt(opts.initialSyncLimit, 10)
        : undefined;
  const groupChannels = parseOptionalDelimitedEntries(opts.groupChannels);
  const dmAllowlist = parseOptionalDelimitedEntries(opts.dmAllowlist);

  const input: ChannelSetupInput = {
    name: opts.name,
    token: opts.token,
    privateKey: opts.privateKey,
    tokenFile: opts.tokenFile,
    botToken: opts.botToken,
    appToken: opts.appToken,
    signalNumber: opts.signalNumber,
    cliPath: opts.cliPath,
    dbPath: opts.dbPath,
    service: opts.service,
    region: opts.region,
    authDir: opts.authDir,
    httpUrl: opts.httpUrl,
    httpHost: opts.httpHost,
    httpPort: opts.httpPort,
    webhookPath: opts.webhookPath,
    webhookUrl: opts.webhookUrl,
    audienceType: opts.audienceType,
    audience: opts.audience,
    homeserver: opts.homeserver,
    userId: opts.userId,
    accessToken: opts.accessToken,
    password: opts.password,
    deviceName: opts.deviceName,
    initialSyncLimit,
    useEnv,
    ship: opts.ship,
    url: opts.url,
    relayUrls: opts.relayUrls,
    code: opts.code,
    groupChannels,
    dmAllowlist,
    autoDiscoverChannels: opts.autoDiscoverChannels,
  };
  const accountId =
    plugin.setup.resolveAccountId?.({
      cfg: nextConfig,
      accountId: opts.account,
      input,
    }) ?? normalizeAccountId(opts.account);

  const validationError = plugin.setup.validateInput?.({
    cfg: nextConfig,
    accountId,
    input,
  });
  if (validationError) {
    runtime.error(validationError);
    runtime.exit(1);
    return;
  }

  const prevConfig = nextConfig;

  if (accountId !== DEFAULT_ACCOUNT_ID) {
    nextConfig = moveSingleAccountChannelSectionToDefaultAccount({
      cfg: nextConfig,
      channelKey: channel,
    });
  }

  nextConfig = applyChannelAccountConfig({
    cfg: nextConfig,
    channel,
    accountId,
    input,
    plugin,
  });
  await plugin.lifecycle?.onAccountConfigChanged?.({
    prevCfg: prevConfig,
    nextCfg: nextConfig,
    accountId,
    runtime,
  });

  await replaceConfigFile({
    nextConfig,
    ...(baseHash !== undefined ? { baseHash } : {}),
  });
  runtime.log(`Added ${channelLabel(channel)} account "${accountId}".`);
  const afterAccountConfigWritten = plugin.setup?.afterAccountConfigWritten;
  if (afterAccountConfigWritten) {
    await runCollectedChannelOnboardingPostWriteHooks({
      hooks: [
        {
          channel,
          accountId,
          run: async ({ cfg: writtenCfg, runtime: hookRuntime }) =>
            await afterAccountConfigWritten({
              previousCfg: cfg,
              cfg: writtenCfg,
              accountId,
              input,
              runtime: hookRuntime,
            }),
        },
      ],
      cfg: nextConfig,
      runtime,
    });
  }
}
