import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { getBundledChannelSetupPlugin } from "../channels/plugins/bundled.js";
import { resolveChannelDefaultAccountId } from "../channels/plugins/helpers.js";
import { listActiveChannelSetupPlugins } from "../channels/plugins/setup-registry.js";
import type {
  ChannelOnboardingPostWriteHook,
  ChannelSetupConfiguredResult,
  ChannelSetupPlugin,
  ChannelSetupResult,
  ChannelSetupStatus,
  ChannelSetupWizardAdapter,
  SetupChannelsOptions,
} from "../channels/plugins/setup-wizard-types.js";
import { formatCliCommand } from "../cli/command-format.js";
import { normalizeExternalChannelSetupConfig } from "../commands/channel-setup/config-compatibility.js";
import {
  resolveChannelSetupEntries,
  shouldShowChannelInSetup,
} from "../commands/channel-setup/discovery.js";
import { loadChannelSetupPluginRegistrySnapshotForChannel } from "../commands/channel-setup/plugin-install.js";
import { resolveChannelSetupWizardAdapterForPlugin } from "../commands/channel-setup/registry.js";
import {
  getTrustedChannelPluginCatalogEntry,
  listTrustedChannelPluginCatalogEntries,
} from "../commands/channel-setup/trusted-catalog.js";
import { withCommandPluginMetadata } from "../commands/config-validation.js";
import { hasConfiguredCommandOwners } from "../commands/doctor-command-owner.js";
import type { ChannelChoice } from "../commands/onboard-types.js";
import { isChannelConfigured } from "../config/channel-configured.js";
import { createConfigIO } from "../config/io.factory.js";
import { createManagedRuntimeEnvBase } from "../config/io.runtime-env.js";
import { formatConfigIssueSummary } from "../config/issue-format.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { resolveBundledPluginSources } from "../plugins/bundled-sources.js";
import { enablePluginWithCapabilityConsent } from "../plugins/enable.js";
import { getPluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import { withPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
import { t } from "../wizard/i18n/index.js";
import { createPluginCapabilityConsentPrompter } from "../wizard/plugin-capability-consent.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { noteDisabledBeforeSetup } from "./channel-setup-fallback.js";
import {
  ensureChannelSetupPluginInstalledWithNavigation as runPluginInstallWithNavigation,
  runScopedChannelStep as runNavigationScope,
} from "./channel-setup-navigation.js";
import { createChannelSetupDisabledHints } from "./channel-setup.disabled.js";
import {
  formatAccountLabel,
  maybeConfigureCommandOwner,
  maybeConfigureDmPolicies,
  promptConfiguredAction,
  promptRemovalAccountId,
} from "./channel-setup.prompts.js";
import {
  collectChannelStatus,
  findBundledSourceForCatalogChannel,
  noteChannelPrimer,
  resolveCatalogChannelSelectionHint,
  resolveChannelSelectionNoteLines,
  resolveChannelSetupSelectionContributions,
  resolveChannelSetupWorkspaceDir,
  resolveQuickstartDefault,
} from "./channel-setup.status.js";

export function createChannelSetupHooks(params: {
  runtime: RuntimeEnv;
  beforePersistentEffect?: () => Promise<void>;
}) {
  const hooks = new Map<string, ChannelOnboardingPostWriteHook>();
  return {
    onPostWriteHook: (hook: ChannelOnboardingPostWriteHook) => {
      hooks.set(`${hook.channel}:${hook.accountId}`, hook);
    },
    async runPostWriteHooks(configPath: string) {
      await runCollectedChannelOnboardingPostWriteHooks({
        hooks: [...hooks.values()],
        configPath,
        runtime: params.runtime,
        ...(params.beforePersistentEffect
          ? { beforePersistentEffect: params.beforePersistentEffect }
          : {}),
      });
      hooks.clear();
    },
  };
}

export async function runCollectedChannelOnboardingPostWriteHooks(params: {
  hooks: ChannelOnboardingPostWriteHook[];
  configPath: string;
  runtime: RuntimeEnv;
  beforePersistentEffect?: () => Promise<void>;
}): Promise<void> {
  if (params.hooks.length === 0) {
    return;
  }
  // Writer receipts bind the file even if config selection changes after commit.
  // Hooks execute against fresh runtime values; persisted config may contain env refs.
  const { snapshot, pluginMetadataSnapshot } = await createConfigIO({
    configPath: params.configPath,
    env: createManagedRuntimeEnvBase(),
    observe: false,
  }).readConfigFileSnapshotWithPluginMetadata({ allowCurrentPluginMetadata: false });
  await withCommandPluginMetadata(
    { config: snapshot.runtimeConfig, snapshot: pluginMetadataSnapshot },
    async () => {
      for (const hook of params.hooks) {
        await params.beforePersistentEffect?.();
        try {
          if (!snapshot.exists || !snapshot.valid) {
            const reason = snapshot.exists
              ? formatConfigIssueSummary(snapshot.issues)
              : "file not found";
            throw new Error(
              `Saved config is unavailable: ${reason}. Run openclaw doctor --fix, then retry setup.`,
            );
          }
          await hook.run({ cfg: snapshot.runtimeConfig, runtime: params.runtime });
        } catch (err) {
          const message = formatErrorMessage(err);
          params.runtime.error(
            `Channel ${hook.channel} post-setup warning for "${hook.accountId}": ${message}`,
          );
        }
      }
    },
  );
}

export function createChannelOnboardingPostWriteHook(params: {
  accountId?: string;
  adapter?: Pick<ChannelSetupWizardAdapter, "afterConfigWritten">;
  channel: ChannelChoice;
  previousCfg: OpenClawConfig;
}): ChannelOnboardingPostWriteHook | undefined {
  if (!params.accountId || !params.adapter?.afterConfigWritten) {
    return undefined;
  }
  return {
    channel: params.channel,
    accountId: params.accountId,
    run: async ({ cfg, runtime }) =>
      await params.adapter?.afterConfigWritten?.({
        previousCfg: params.previousCfg,
        cfg,
        accountId: params.accountId!,
        runtime,
      }),
  };
}

export async function setupChannels(
  cfg: OpenClawConfig,
  runtime: RuntimeEnv,
  prompter: WizardPrompter,
  options?: SetupChannelsOptions,
): Promise<OpenClawConfig> {
  let next = cfg;
  const deferStatusUntilSelection = options?.deferStatusUntilSelection === true;
  const forceAllowFromChannels = new Set(options?.forceAllowFromChannels ?? []);
  const accountOverrides: Partial<Record<ChannelChoice, string>> = {
    ...options?.accountIds,
  };
  const scopedPluginsById = new Map<ChannelChoice, ChannelSetupPlugin>();
  let preparedWorkspaceDir = options?.workspaceDir;
  const resolveWorkspaceDir = () =>
    (preparedWorkspaceDir ??= resolveChannelSetupWorkspaceDir(next));
  const activePluginsById = new Map<ChannelChoice, ChannelSetupPlugin>();
  const rememberActivePlugin = (plugin: ChannelSetupPlugin) => {
    activePluginsById.set(plugin.id, plugin);
    return plugin;
  };
  const getVisibleChannelPlugin = (channel: ChannelChoice): ChannelSetupPlugin | undefined =>
    scopedPluginsById.get(channel) ?? activePluginsById.get(channel);
  const listVisibleInstalledPlugins = (): ChannelSetupPlugin[] => {
    const merged = new Map<string, ChannelSetupPlugin>();
    const registryPlugins = listActiveChannelSetupPlugins().map(rememberActivePlugin);
    for (const plugin of registryPlugins) {
      if (shouldShowChannelInSetup(plugin.meta)) {
        merged.set(plugin.id, plugin);
      }
    }
    for (const plugin of scopedPluginsById.values()) {
      if (shouldShowChannelInSetup(plugin.meta)) {
        merged.set(plugin.id, plugin);
      }
    }
    return Array.from(merged.values());
  };
  const resolveVisibleChannelEntries = () =>
    resolveChannelSetupEntries({
      cfg: next,
      installedPlugins: listVisibleInstalledPlugins(),
      workspaceDir: resolveWorkspaceDir(),
    });
  const loadScopedChannelPlugin = async (
    channel: ChannelChoice,
    pluginId?: string,
    setup?: {
      forceReload?: boolean;
      forceSetupOnlyChannelPlugins?: boolean;
    },
  ): Promise<ChannelSetupPlugin | undefined> => {
    const existing = getVisibleChannelPlugin(channel);
    if (existing && setup?.forceReload !== true) {
      return existing;
    }
    const snapshot = loadChannelSetupPluginRegistrySnapshotForChannel({
      cfg: next,
      runtime,
      channel,
      ...(pluginId ? { pluginId } : {}),
      workspaceDir: resolveWorkspaceDir(),
      forceSetupOnlyChannelPlugins: setup?.forceSetupOnlyChannelPlugins ?? true,
    });
    const plugin =
      snapshot.channelSetups.find((entry) => entry.plugin.id === channel)?.plugin ??
      snapshot.channels.find((entry) => entry.plugin.id === channel)?.plugin ??
      getBundledChannelSetupPlugin(channel);
    if (plugin) {
      scopedPluginsById.set(plugin.id, plugin);
    }
    return plugin;
  };
  const setupCache = getPluginCache();
  const enableChannelPluginForSetup = async (channel: ChannelChoice) =>
    await withPluginLifecycleLease({}, async () => {
      const result = await enablePluginWithCapabilityConsent(next, channel, {
        workspaceDir: resolveWorkspaceDir(),
        onCapabilityConsent: createPluginCapabilityConsentPrompter(
          prompter,
          options?.beforePersistentEffect,
        ),
      });
      next = result.config;
      if (result.enabled) {
        // Capture the reviewed runtime before another lifecycle operation replaces it.
        await withPluginCache(setupCache, () => loadScopedChannelPlugin(channel));
      }
      return result;
    });
  const getVisibleSetupFlowAdapter = (channel: ChannelChoice) =>
    resolveChannelSetupWizardAdapterForPlugin(getVisibleChannelPlugin(channel));
  const preloadConfiguredExternalPlugins = async () => {
    // Keep setup memory bounded by snapshot-loading only configured external plugins.
    listVisibleInstalledPlugins();
    const workspaceDir = resolveWorkspaceDir();
    const preloadTasks: Promise<unknown>[] = [];
    // Security: keep trusted workspace overrides eligible during setup while
    // falling back from untrusted workspace shadows to the non-workspace entry.
    for (const entry of listTrustedChannelPluginCatalogEntries({ cfg: next, workspaceDir })) {
      const channel = entry.id as ChannelChoice;
      if (getVisibleChannelPlugin(channel)) {
        continue;
      }
      const explicitlyEnabled =
        next.plugins?.entries?.[entry.pluginId ?? channel]?.enabled === true;
      if (!explicitlyEnabled && !isChannelConfigured(next, channel)) {
        continue;
      }
      preloadTasks.push(loadScopedChannelPlugin(channel, entry.pluginId));
    }
    await Promise.all(preloadTasks);
  };
  if (!deferStatusUntilSelection) {
    await preloadConfiguredExternalPlugins();
  }

  const statusSummary = deferStatusUntilSelection
    ? { statusByChannel: new Map<ChannelChoice, ChannelSetupStatus>(), statusLines: [] }
    : await withCommandPluginMetadata({ config: next, workspaceDir: resolveWorkspaceDir() }, () =>
        collectChannelStatus({
          cfg: next,
          workspaceDir: resolveWorkspaceDir(),
          options,
          accountOverrides,
          installedPlugins: listVisibleInstalledPlugins(),
          resolveAdapter: getVisibleSetupFlowAdapter,
        }),
      );
  const { statusByChannel, statusLines } = statusSummary;
  if (!options?.skipStatusNote && statusLines.length > 0) {
    await prompter.note(statusLines.join("\n"), t("wizard.channels.statusTitle"));
  }

  const targetedChannel =
    options?.finishAfterInitialSelection && options.initialSelection?.length === 1
      ? options.initialSelection[0]
      : undefined;
  const shouldConfigure =
    options?.skipConfirm || targetedChannel
      ? true
      : await prompter.confirm({
          message: t("wizard.channels.setupConfirm"),
          initialValue: true,
        });
  if (!shouldConfigure) {
    return cfg;
  }

  const primerChannels = resolveVisibleChannelEntries().entries.map((entry) => ({
    id: entry.id,
    label: entry.meta.label,
    blurb: entry.meta.blurb,
  }));
  await noteChannelPrimer(prompter, primerChannels);

  const quickstartDefault =
    options?.initialSelection?.[0] ??
    (deferStatusUntilSelection ? undefined : resolveQuickstartDefault(statusByChannel));

  const shouldPromptAccountIds = options?.promptAccountIds === true;
  const accountIdsByChannel = new Map<ChannelChoice, string>();
  const recordAccount = (channel: ChannelChoice, accountId: string) => {
    options?.onAccountId?.(channel, accountId);
    const adapter = getVisibleSetupFlowAdapter(channel);
    adapter?.onAccountRecorded?.(accountId, options);
    accountIdsByChannel.set(channel, accountId);
  };

  const selection: ChannelChoice[] = [];
  let finishSetupRequested = false;
  const addSelection = (channel: ChannelChoice) => {
    if (!selection.includes(channel)) {
      selection.push(channel);
    }
  };

  const { resolveConfigDisabledHint, resolveAccountDisabledHint, resolveDisabledHint } =
    createChannelSetupDisabledHints({
      getConfig: () => next,
      getPlugin: getVisibleChannelPlugin,
      deferStatusUntilSelection,
    });

  // Deferred setup has no runtime status yet; only external catalog entries need download hints.
  const buildStatusByChannelForSelection = (
    catalogById: ReturnType<typeof resolveVisibleChannelEntries>["installableCatalogById"],
  ): Map<ChannelChoice, ChannelSetupStatus> => {
    const decorated = new Map(statusByChannel);
    if (catalogById.size === 0) {
      return decorated;
    }
    const bundledSources = resolveBundledPluginSources({
      workspaceDir: resolveWorkspaceDir(),
    });
    for (const [channel, entry] of catalogById) {
      if (decorated.has(channel)) {
        continue;
      }
      const bundledLocalPath =
        findBundledSourceForCatalogChannel({ bundled: bundledSources, entry })?.localPath ?? null;
      decorated.set(channel, {
        channel,
        configured: false,
        statusLines: [],
        selectionHint: resolveCatalogChannelSelectionHint(entry, { bundledLocalPath }),
      });
    }
    return decorated;
  };

  const resolveSelectionContributions = () =>
    withCommandPluginMetadata({ config: next, workspaceDir: resolveWorkspaceDir() }, async () => {
      const { entries, installableCatalogById: catalogById } = resolveVisibleChannelEntries();
      const disabledHints = new Map<ChannelChoice, string | undefined>();
      for (const entry of entries) {
        if (shouldShowChannelInSetup(entry.meta)) {
          disabledHints.set(entry.id, await resolveDisabledHint(entry.id));
        }
      }
      return resolveChannelSetupSelectionContributions({
        entries,
        statusByChannel: buildStatusByChannelForSelection(catalogById),
        resolveDisabledHint: (channel) => disabledHints.get(channel),
      });
    });

  const refreshStatus = async (channel: ChannelChoice) =>
    await withCommandPluginMetadata(
      { config: next, workspaceDir: resolveWorkspaceDir() },
      async () => {
        const adapter = getVisibleSetupFlowAdapter(channel);
        if (!adapter) {
          return undefined;
        }
        const status = await adapter.getStatus({ cfg: next, options, accountOverrides });
        statusByChannel.set(channel, status);
        return status;
      },
    );

  const enableBundledPluginForSetup = async (channel: ChannelChoice): Promise<boolean> => {
    const disabledHint = resolveConfigDisabledHint(channel);
    if (disabledHint) {
      await prompter.note(
        t("wizard.channels.disabledDuringSetup", {
          channel,
          hint: disabledHint,
          command: formatCliCommand("openclaw channels add"),
        }),
        t("wizard.channels.setupTitle"),
      );
      return false;
    }
    const result = await enableChannelPluginForSetup(channel);
    if (!result.enabled) {
      await prompter.note(
        t("wizard.channels.pluginEnableFailed", {
          channel,
          reason: result.reason ?? "plugin disabled",
          command: formatCliCommand("openclaw plugins list"),
        }),
        t("wizard.channels.setupTitle"),
      );
      return false;
    }
    const plugin = getVisibleChannelPlugin(channel);
    if (!plugin) {
      await prompter.note(
        t("wizard.channels.pluginNotAvailable", { channel }),
        t("wizard.channels.setupTitle"),
      );
      return false;
    }
    await refreshStatus(channel);
    return true;
  };

  const applySetupResult = async (channel: ChannelChoice, result: ChannelSetupResult) => {
    const previousCfg = next;
    next = normalizeExternalChannelSetupConfig({ cfg: result.cfg, channel });
    if (result.completion === "paused") {
      // Persist partial setup state, but do not run configured-account hooks,
      // routing, or DM policy prompts until setup actually completes.
      finishSetupRequested = true;
      return;
    }
    const plugin = getVisibleChannelPlugin(channel);
    if (plugin) {
      options?.onResolvedPlugin?.(channel, plugin);
    }
    const adapter = getVisibleSetupFlowAdapter(channel);
    if (result.accountId) {
      recordAccount(channel, result.accountId);
      const postWriteHook = createChannelOnboardingPostWriteHook({
        accountId: result.accountId,
        adapter,
        channel,
        previousCfg,
      });
      if (postWriteHook) {
        if (!options?.onPostWriteHook) {
          throw new Error(
            `Channel setup internal error: ${channel} produced a post-write hook without a transaction sink.`,
          );
        }
        options.onPostWriteHook(postWriteHook);
      }
    }
    addSelection(channel);
    if (channel === targetedChannel) {
      finishSetupRequested = true;
    }
    try {
      await refreshStatus(channel);
    } catch (error) {
      const detail = sanitizeTerminalText(formatErrorMessage(error));
      statusByChannel.set(channel, {
        channel,
        configured: isChannelConfigured(next, channel),
        statusLines: [],
        selectionHint: "status unavailable",
      });
      await prompter.note(
        `Status unavailable (${detail}).\nRetry: ${formatCliCommand(`openclaw channels status --channel ${channel}`)}`,
        t("wizard.channels.statusTitle"),
      );
    }
  };

  const applyCustomSetupResult = async (
    channel: ChannelChoice,
    result: ChannelSetupConfiguredResult,
  ) => {
    if (result !== "skip") {
      await applySetupResult(channel, result);
    }
  };
  const runScopedChannelStep = async <T>(
    runner: (prompter: WizardPrompter, options: SetupChannelsOptions) => Promise<T>,
    onPersistentEffect?: () => void,
  ) =>
    await runNavigationScope({
      prompter,
      options,
      runner: (scopedPrompter, scopedOptions) =>
        withCommandPluginMetadata({ config: next, workspaceDir: resolveWorkspaceDir() }, () =>
          runner(scopedPrompter, scopedOptions),
        ),
      ...(onPersistentEffect ? { onPersistentEffect } : {}),
    });

  const configureChannel = async (
    channel: ChannelChoice,
    setupPrompter: WizardPrompter,
    setupOptions: SetupChannelsOptions,
  ) => {
    if (scopedPluginsById.has(channel)) {
      await loadScopedChannelPlugin(channel, undefined, {
        forceReload: true,
        forceSetupOnlyChannelPlugins: true,
      });
    }
    const adapter = getVisibleSetupFlowAdapter(channel);
    if (!adapter) {
      await prompter.note(
        t("wizard.channels.noInteractiveSetup", {
          channel,
          command: formatCliCommand(`openclaw channels add --channel ${channel} --help`),
        }),
        t("wizard.channels.setupTitle"),
      );
      return;
    }
    const result = await adapter.configure({
      cfg: next,
      runtime,
      prompter: setupPrompter,
      options: setupOptions,
      accountOverrides,
      shouldPromptAccountIds,
      forceAllowFrom: forceAllowFromChannels.has(channel),
    });
    await applySetupResult(channel, result);
  };

  const handleConfiguredChannel = async (
    channel: ChannelChoice,
    label: string,
    setupPrompter: WizardPrompter,
    setupOptions: SetupChannelsOptions,
  ) => {
    const plugin = getVisibleChannelPlugin(channel);
    const adapter = getVisibleSetupFlowAdapter(channel);
    if (adapter?.configureWhenConfigured) {
      const custom = await adapter.configureWhenConfigured({
        cfg: next,
        runtime,
        prompter: setupPrompter,
        options: setupOptions,
        accountOverrides,
        shouldPromptAccountIds,
        forceAllowFrom: forceAllowFromChannels.has(channel),
        configured: true,
        label,
      });
      await applyCustomSetupResult(channel, custom);
      return;
    }

    const supportsDisable = Boolean(
      setupOptions.allowDisable && (plugin?.config.setAccountEnabled || adapter?.disable),
    );
    const supportsDelete = Boolean(setupOptions.allowDisable && plugin?.config.deleteAccount);
    const action = await promptConfiguredAction({
      prompter: setupPrompter,
      label,
      supportsDisable,
      supportsDelete,
    });
    if (action === "skip") {
      return;
    }
    if (action === "update") {
      await configureChannel(channel, setupPrompter, setupOptions);
      return;
    }
    if (!setupOptions.allowDisable) {
      return;
    }
    if (action === "delete" && !supportsDelete) {
      await setupPrompter.note(
        t("wizard.channels.configuredDeleteUnsupported", { label }),
        t("wizard.channels.removeTitle"),
      );
      return;
    }

    const shouldPromptAccount =
      action === "delete"
        ? Boolean(plugin?.config.deleteAccount)
        : Boolean(plugin?.config.setAccountEnabled);
    const accountId = shouldPromptAccount
      ? await promptRemovalAccountId({
          cfg: next,
          prompter: setupPrompter,
          label,
          channel,
          plugin,
        })
      : DEFAULT_ACCOUNT_ID;
    const resolvedAccountId =
      normalizeAccountId(accountId) ??
      (plugin ? resolveChannelDefaultAccountId({ plugin, cfg: next }) : DEFAULT_ACCOUNT_ID);
    const accountLabel = formatAccountLabel(resolvedAccountId);

    if (action === "delete") {
      const confirmed = await setupPrompter.confirm({
        message: t("wizard.channels.deleteAccount", { label, account: accountLabel }),
        initialValue: false,
      });
      if (!confirmed) {
        return;
      }
      if (plugin?.config.deleteAccount) {
        next = plugin.config.deleteAccount({ cfg: next, accountId: resolvedAccountId });
      }
      await refreshStatus(channel);
      return;
    }

    if (plugin?.config.setAccountEnabled) {
      next = plugin.config.setAccountEnabled({
        cfg: next,
        accountId: resolvedAccountId,
        enabled: false,
      });
    } else if (adapter?.disable) {
      next = adapter.disable(next);
    }
    await refreshStatus(channel);
  };

  const ensureChannelSetupPluginInstalledWithNavigation = async (
    channel: ChannelChoice,
    install: Parameters<typeof runPluginInstallWithNavigation>[0]["install"],
  ) =>
    await withPluginLifecycleLease({}, async () => {
      const outcome = await runPluginInstallWithNavigation({ install, prompter, options });
      if (outcome.status !== "back" && outcome.value.installed) {
        next = outcome.value.cfg;
        await withPluginCache(setupCache, () =>
          loadScopedChannelPlugin(channel, outcome.value.pluginId ?? install.entry.pluginId),
        );
      }
      return outcome;
    });

  const handleChannelChoice = async (
    channel: ChannelChoice,
  ): Promise<"done" | "retry_selection"> => {
    const cfgBeforeChoice = next;
    let cfgOnBack = cfgBeforeChoice;
    const scopedPluginsBeforeChoice = new Map(scopedPluginsById);
    const statusBeforeChoice = new Map(statusByChannel);
    const returnToSelection = (): "retry_selection" => {
      next = cfgOnBack;
      scopedPluginsById.clear();
      for (const [id, plugin] of scopedPluginsBeforeChoice) {
        scopedPluginsById.set(id, plugin);
      }
      statusByChannel.clear();
      for (const [id, status] of statusBeforeChoice) {
        statusByChannel.set(id, status);
      }
      return "retry_selection";
    };
    const installCatalogEntry = async (
      entry: Parameters<typeof runPluginInstallWithNavigation>[0]["install"]["entry"],
    ): Promise<"retry_selection" | undefined> => {
      const installOutcome = await ensureChannelSetupPluginInstalledWithNavigation(channel, {
        cfg: next,
        entry,
        runtime,
        workspaceDir: resolveWorkspaceDir(),
        autoConfirmSingleSource: true,
      });
      if (installOutcome.status === "back") {
        return returnToSelection();
      }
      next = installOutcome.value.cfg;
      if (!installOutcome.value.installed) {
        return "retry_selection";
      }
      if (installOutcome.persistentEffectStarted) {
        cfgOnBack = next;
      }
      return undefined;
    };
    let deferredDisabledHint = deferStatusUntilSelection
      ? resolveConfigDisabledHint(channel)
      : undefined;
    let resumingDisabledChannel = false;
    if (deferredDisabledHint) {
      if (deferredDisabledHint === "disabled") {
        const resume =
          channel === targetedChannel
            ? true
            : await prompter.confirm({
                message: t("wizard.channels.resumeDisabledSetup", { channel }),
                initialValue: true,
              });
        if (!resume) {
          return "done";
        }
        const channels = next.channels as
          | Record<string, Record<string, unknown> | undefined>
          | undefined;
        next = {
          ...next,
          channels: {
            ...next.channels,
            [channel]: {
              ...channels?.[channel],
              enabled: true,
            },
          },
        } as OpenClawConfig;
        resumingDisabledChannel = true;
      } else if (deferredDisabledHint === "plugin disabled") {
        const resume =
          channel === targetedChannel
            ? true
            : await prompter.confirm({
                message: t("wizard.channels.resumeDisabledPluginSetup", { channel }),
                initialValue: true,
              });
        if (!resume) {
          return "done";
        }
        const result = await enableChannelPluginForSetup(channel);
        if (!result.enabled) {
          await prompter.note(
            t("wizard.channels.pluginEnableFailed", {
              channel,
              reason: result.reason ?? "plugin disabled",
              command: formatCliCommand("openclaw plugins list"),
            }),
            t("wizard.channels.setupTitle"),
          );
          return "done";
        }
        resumingDisabledChannel = true;
      } else {
        await noteDisabledBeforeSetup(prompter, channel, deferredDisabledHint);
        return "done";
      }
      deferredDisabledHint = resolveConfigDisabledHint(channel);
      if (deferredDisabledHint) {
        await noteDisabledBeforeSetup(prompter, channel, deferredDisabledHint);
        return "done";
      }
    }
    const { installableCatalogById: catalogById, installedCatalogById } =
      resolveVisibleChannelEntries();
    const catalogEntry = catalogById.get(channel);
    const installedCatalogEntry = installedCatalogById.get(channel);
    if (catalogEntry) {
      const installExit = await installCatalogEntry(catalogEntry);
      if (installExit) {
        return installExit;
      }
      await refreshStatus(channel);
    } else if (installedCatalogEntry) {
      let plugin = await loadScopedChannelPlugin(channel, installedCatalogEntry.pluginId);
      if (!plugin && installedCatalogEntry.install?.npmSpec) {
        // Recover retained channel config after its external package disappears,
        // while respecting the same disabled policy as bundled setup.
        const disabledHint = resolveConfigDisabledHint(channel);
        if (disabledHint) {
          await noteDisabledBeforeSetup(prompter, channel, disabledHint);
          return "done";
        }
        const installExit = await installCatalogEntry(installedCatalogEntry);
        if (installExit) {
          return installExit;
        }
        plugin = getVisibleChannelPlugin(channel);
      }
      if (!plugin) {
        await prompter.note(
          t("wizard.channels.pluginNotAvailable", { channel }),
          t("wizard.channels.setupTitle"),
        );
        return "done";
      }
      await refreshStatus(channel);
    } else {
      // Discovery omits loaded catalog plugins from both buckets. Reuse them
      // without reinstalling or enabling by channel ID: the plugin owner may
      // have a different ID. Non-catalog setup plugins still need activation.
      const fallbackCatalogEntry = getTrustedChannelPluginCatalogEntry(channel, {
        cfg: next,
        workspaceDir: resolveWorkspaceDir(),
      });
      if (fallbackCatalogEntry?.install?.npmSpec) {
        const disabledHint = resolveConfigDisabledHint(channel);
        if (disabledHint) {
          await noteDisabledBeforeSetup(prompter, channel, disabledHint);
          return "done";
        }
        if (!getVisibleChannelPlugin(channel)) {
          const installExit = await installCatalogEntry(fallbackCatalogEntry);
          if (installExit) {
            return installExit;
          }
        }
        await refreshStatus(channel);
      } else if (!(await enableBundledPluginForSetup(channel))) {
        return "done";
      }
    }

    const plugin = getVisibleChannelPlugin(channel);
    const adapter = getVisibleSetupFlowAdapter(channel);
    const label = plugin?.meta.label ?? catalogEntry?.meta.label ?? channel;
    const status = statusByChannel.get(channel);
    const configured = resumingDisabledChannel ? false : (status?.configured ?? false);
    const configureInteractive = adapter?.configureInteractive;
    if (configureInteractive) {
      const outcome = await runScopedChannelStep(
        async (scopedPrompter, scopedOptions) =>
          await configureInteractive({
            cfg: next,
            runtime,
            prompter: scopedPrompter,
            options: scopedOptions,
            accountOverrides,
            shouldPromptAccountIds,
            forceAllowFrom: forceAllowFromChannels.has(channel),
            configured,
            label,
          }),
      );
      if (outcome.status === "back") {
        return returnToSelection();
      }
      const custom = outcome.value;
      await withCommandPluginMetadata({ config: next, workspaceDir: resolveWorkspaceDir() }, () =>
        applyCustomSetupResult(channel, custom),
      );
      return "done";
    }
    const outcome = await runScopedChannelStep(async (scopedPrompter, scopedOptions) =>
      configured
        ? await handleConfiguredChannel(channel, label, scopedPrompter, scopedOptions)
        : await configureChannel(channel, scopedPrompter, scopedOptions),
    );
    if (outcome.status === "back") {
      return returnToSelection();
    }
    return "done";
  };

  // Targeted setup finishes after success, but Back must re-enter the shared
  // picker instead of ending the wizard.
  const targetedSetupReturnedToPicker = targetedChannel
    ? (await handleChannelChoice(targetedChannel)) === "retry_selection"
    : false;

  if (!targetedChannel && options?.quickstartDefaults) {
    const skipValue = "__skip__" as const;
    const quickstartInitialValue = options?.initialSelection?.[0] ?? skipValue;
    while (true) {
      const contributions = await resolveSelectionContributions();
      const choice = await prompter.select({
        message: t("wizard.channels.selectQuickstart"),
        options: [
          {
            value: skipValue,
            label: t("common.skipForNow"),
            hint: t("wizard.channels.skipLaterHint", {
              command: formatCliCommand("openclaw channels add"),
            }),
          },
          ...contributions.map((contribution) => contribution.option),
        ],
        initialValue: quickstartInitialValue,
        searchable: true,
      });
      if (choice === skipValue) {
        break;
      }
      if ((await handleChannelChoice(choice)) === "done") {
        break;
      }
    }
  } else if (!targetedChannel || targetedSetupReturnedToPicker) {
    const doneValue = "__done__" as const;
    const initialValue = options?.initialSelection?.[0] ?? quickstartDefault;
    while (true) {
      const contributions = await resolveSelectionContributions();
      const choice = await prompter.select({
        message: t("wizard.channels.select"),
        options: [
          ...contributions.map((contribution) => contribution.option),
          {
            value: doneValue,
            label: t("common.finished"),
            hint: selection.length > 0 ? t("wizard.channels.doneHint") : t("common.skipForNow"),
          },
        ],
        initialValue,
      });
      if (choice === doneValue) {
        break;
      }
      await handleChannelChoice(choice);
      if (finishSetupRequested) {
        break;
      }
    }
  }

  options?.onSelection?.(selection);

  const selectedLines = resolveChannelSelectionNoteLines({
    cfg: next,
    workspaceDir: resolveWorkspaceDir(),
    installedPlugins: listVisibleInstalledPlugins(),
    selection,
  });
  if (selectedLines.length > 0) {
    await prompter.note(selectedLines.join("\n"), t("wizard.channels.selectedTitle"));
  }

  if (!options?.skipDmPolicyPrompt) {
    next = await withCommandPluginMetadata(
      { config: next, workspaceDir: resolveWorkspaceDir() },
      () =>
        maybeConfigureDmPolicies({
          cfg: next,
          selection,
          prompter,
          accountIdsByChannel,
          resolveAdapter: getVisibleSetupFlowAdapter,
        }),
    );
  }

  if (hasConfiguredCommandOwners(next)) {
    return next;
  }
  const ownerChannels: Array<{ id: ChannelChoice; label: string }> = [];
  await withCommandPluginMetadata(
    { config: next, workspaceDir: resolveWorkspaceDir() },
    async () => {
      for (const id of selection) {
        try {
          if (
            resolveConfigDisabledHint(id) ||
            (await resolveAccountDisabledHint(id, accountIdsByChannel.get(id)))
          ) {
            continue;
          }
          // A later setup action can remove or disable an earlier selection.
          const status = await refreshStatus(id);
          if (status?.configured) {
            ownerChannels.push({ id, label: getVisibleChannelPlugin(id)?.meta.label ?? id });
          }
        } catch (error) {
          await prompter.note(
            `Status unavailable (${sanitizeTerminalText(formatErrorMessage(error))}).\nRetry: ${formatCliCommand(`openclaw channels status --channel ${id}`)}`,
            t("wizard.channels.statusTitle"),
          );
        }
      }
    },
  );
  return await maybeConfigureCommandOwner({ cfg: next, channels: ownerChannels, prompter });
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
