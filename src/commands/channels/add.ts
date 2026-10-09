import { parseStrictNonNegativeInteger } from "@openclaw/normalization-core/number-coercion";
// Implements guided and non-interactive `openclaw channels add` account setup.
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import {
  applyPreparedChannelAccountConfiguration,
  type ChannelAccountMutationPlugin,
  prepareChannelAccountConfiguration,
} from "../../channels/plugins/account-config-mutation.js";
import { getBundledChannelSetupPlugin } from "../../channels/plugins/bundled.js";
import {
  channelOmitsEnvBackedSetupOption,
  resolveChannelSetupCliOptionMetadata,
} from "../../channels/plugins/cli-add-options.js";
import { parseOptionalDelimitedEntries } from "../../channels/plugins/helpers.js";
import { getLoadedChannelPlugin, normalizeChannelId } from "../../channels/plugins/index.js";
import type { ChannelId } from "../../channels/plugins/types.public.js";
import { formatCliCommand } from "../../cli/command-format.js";
import {
  formatUnknownChannelMessage,
  formatUnsupportedChannelActionMessage,
} from "../../cli/error-format.js";
import { isTerminalInteractive } from "../../cli/terminal-interactivity.js";
import { defaultRuntime, type RuntimeEnv } from "../../runtime.js";
import { createLazyPromise } from "../../shared/lazy-promise.js";
import { createClackPrompter } from "../../wizard/clack-prompter.js";
import { WizardCancelledError } from "../../wizard/prompts.js";
import { normalizeExternalChannelSetupConfig } from "../channel-setup/config-compatibility.js";
import { resolveChannelSetupOwner } from "../channel-setup/owner.js";
import { withCommandPluginMetadata, type ConfigWriteSnapshot } from "../config-validation.js";
import { parseAccountSelector } from "./account-selector.js";
import { persistChannelPluginConfig } from "./plugin-config-persistence.js";
import { channelLabel } from "./runtime-label.js";
import { requireValidConfigForWrite } from "./shared.js";

const loadOnboardChannels = createLazyPromise(() => import("../../flows/channel-setup.js"));

export type ChannelsAddOptions = {
  agent?: string;
  channel?: string;
  account?: string;
} & Record<string, unknown>;

const CHANNEL_ADD_CONTROL_OPTION_KEYS = new Set(["agent", "channel", "account"]);

// CLI registration is selection-scoped; only legacy setup needs metadata coercion.
function buildChannelSetupInput(opts: ChannelsAddOptions, mode: "legacy" | "contract") {
  const valueMetadataByAttributeName =
    mode === "legacy"
      ? resolveChannelSetupCliOptionMetadata(opts.channel).valueMetadataByAttributeName
      : null;
  const entries = Object.entries(opts).filter(
    ([key, value]) => !CHANNEL_ADD_CONTROL_OPTION_KEYS.has(key) && value !== undefined,
  );
  if (!valueMetadataByAttributeName) {
    return Object.fromEntries(entries);
  }
  const input: Record<string, unknown> = {};
  for (const [key, value] of entries) {
    const metadata = valueMetadataByAttributeName.get(key);
    if (metadata?.valueType !== "int") {
      input[key] =
        metadata?.valueType === "list"
          ? Array.isArray(value)
            ? value.filter((entry): entry is string => typeof entry === "string")
            : parseOptionalDelimitedEntries(typeof value === "string" ? value : undefined)
          : value;
      continue;
    }
    if (value === null) {
      input[key] = undefined;
      continue;
    }
    const parsed = parseStrictNonNegativeInteger(value);
    if (parsed === undefined) {
      throw new Error(`${metadata.longFlag} must be a non-negative integer.`);
    }
    input[key] = parsed;
  }
  return input;
}

/** Add or configure a channel account, using the wizard when no concrete flags are supplied. */
export async function channelsAddCommand(
  opts: ChannelsAddOptions,
  runtime: RuntimeEnv = defaultRuntime,
  params?: { hasFlags?: boolean; beforePersistentEffect?: () => Promise<void> },
) {
  try {
    parseAccountSelector(opts.account);
    const writeSnapshot = await requireValidConfigForWrite(runtime);
    if (!writeSnapshot) {
      return;
    }
    return await configureChannelAccount(writeSnapshot, opts, runtime, params);
  } catch (err) {
    if (err instanceof WizardCancelledError) {
      runtime.exit(1);
      return;
    }
    throw err;
  }
}

async function configureChannelAccount(
  writeSnapshot: ConfigWriteSnapshot,
  opts: ChannelsAddOptions,
  runtime: RuntimeEnv,
  params?: { hasFlags?: boolean; beforePersistentEffect?: () => Promise<void> },
) {
  const cfg = writeSnapshot.snapshot.sourceConfig;
  let nextConfig = cfg;
  let pluginRegistrySourceChanged = false;
  const effectContext = () => ({
    runtime,
    ...(params?.beforePersistentEffect
      ? { beforePersistentEffect: params.beforePersistentEffect }
      : {}),
  });

  const useWizard = params?.hasFlags === false;
  if (useWizard) {
    const { resolveInitialWizardChannelTarget, runChannelsAddWizardFlow, selectChannelSetupOwner } =
      await import("./add-wizard.js");
    const prompter = createClackPrompter();
    if (!isTerminalInteractive()) {
      runtime.error(
        channelOmitsEnvBackedSetupOption(opts.channel)
          ? `Interactive channel setup requires a TTY. Run ${formatCliCommand(`openclaw channels add --channel ${opts.channel?.trim() || "<id>"} --help`)} to list the setup flags this channel accepts, then pass them for non-interactive setup.`
          : "Interactive channel setup requires a TTY. Use `openclaw channels add --channel <id> --use-env` or pass the channel's credential flags for non-interactive setup.",
      );
      runtime.exit(1);
      return;
    }
    const { agentId, workspaceDir } = await selectChannelSetupOwner(
      writeSnapshot,
      prompter,
      opts.agent,
    );
    const target = await resolveInitialWizardChannelTarget(opts.channel, cfg, workspaceDir);
    if (target.kind === "unresolved") {
      runtime.error(target.message);
      runtime.exit(1);
      return;
    }
    await runChannelsAddWizardFlow({
      writeSnapshot,
      agentId,
      prompter,
      workspaceDir,
      ...(target.kind === "resolved" ? { initialChannel: target.channel } : {}),
      ...effectContext(),
    });
    return;
  }

  const rawChannel = opts.channel ?? "";
  let channel = normalizeChannelId(rawChannel);
  let preparedWorkspaceDir: string | undefined;
  const resolveWorkspaceDir = () =>
    (preparedWorkspaceDir ??= resolveChannelSetupOwner(cfg, opts.agent).workspaceDir);
  const catalogChannel = normalizeOptionalLowercaseString(rawChannel);
  let catalogEntry = catalogChannel
    ? (await import("../channel-setup/trusted-catalog.js")).resolveTrustedChannelCatalogInput(
        catalogChannel,
        { cfg: nextConfig, workspaceDir: resolveWorkspaceDir() },
      )
    : undefined;
  // May load a scoped plugin when the channel is not already registered.
  const loadScopedPlugin = async (
    channelId: ChannelId,
    pluginId?: string,
  ): Promise<ChannelAccountMutationPlugin | undefined> => {
    const existing = getLoadedChannelPlugin(channelId);
    if (existing?.setupContract?.applyAccountConfig || existing?.setup?.applyAccountConfig) {
      return existing;
    }
    const { loadChannelSetupPluginRegistrySnapshotForChannel } =
      await import("../channel-setup/plugin-install.js");
    const snapshot = loadChannelSetupPluginRegistrySnapshotForChannel({
      cfg: nextConfig,
      runtime,
      channel: channelId,
      ...(pluginId ? { pluginId } : {}),
      workspaceDir: resolveWorkspaceDir(),
      forceSetupOnlyChannelPlugins: true,
    });
    return (
      snapshot.channelSetups.find((entry) => entry.plugin.id === channelId)?.plugin ??
      getBundledChannelSetupPlugin(channelId) ??
      snapshot.channels.find((entry) => entry.plugin.id === channelId)?.plugin ??
      existing
    );
  };

  if (catalogEntry) {
    const workspaceDir = resolveWorkspaceDir();
    const { isCatalogChannelInstalled } = await import("../channel-setup/discovery.js");
    const registeredPlugin = channel ? getLoadedChannelPlugin(channel) : undefined;
    const bundledSetupPlugin = channel ? getBundledChannelSetupPlugin(channel) : undefined;
    if (
      !registeredPlugin &&
      !bundledSetupPlugin &&
      !isCatalogChannelInstalled({
        cfg: nextConfig,
        entry: catalogEntry,
        workspaceDir,
      })
    ) {
      const { ensureChannelSetupPluginInstalled } =
        await import("../channel-setup/plugin-install.js");
      const prompter = createClackPrompter();
      const result = await ensureChannelSetupPluginInstalled({
        cfg: nextConfig,
        entry: catalogEntry,
        prompter,
        workspaceDir,
        promptInstall: false,
        ...effectContext(),
      });
      nextConfig = result.cfg;
      if (!result.installed) {
        return;
      }
      pluginRegistrySourceChanged = true;
      catalogEntry = {
        ...catalogEntry,
        ...(result.pluginId ? { pluginId: result.pluginId } : {}),
      };
    }
    channel ??= normalizeChannelId(catalogEntry.id) ?? (catalogEntry.id as ChannelId);
  }

  if (!channel) {
    const hint = catalogEntry
      ? `Plugin ${catalogEntry.meta.label} could not be loaded after install. Run openclaw doctor --fix, then retry openclaw channels add.`
      : formatUnknownChannelMessage({ channel: rawChannel });
    runtime.error(hint);
    runtime.exit(1);
    return;
  }

  const selectedChannel = channel;
  const unsupportedAddMessage = () =>
    `${formatUnsupportedChannelActionMessage({
      channel: selectedChannel,
      action: "non-interactive add",
    })} Run ${formatCliCommand("openclaw channels add")} with no flags for guided setup.`;
  return withCommandPluginMetadata(
    { config: nextConfig, workspaceDir: resolveWorkspaceDir() },
    async () => {
      const plugin = await loadScopedPlugin(selectedChannel, catalogEntry?.pluginId);
      if (!plugin) {
        runtime.error(unsupportedAddMessage());
        runtime.exit(1);
        return;
      }
      const prepared = await prepareChannelAccountConfiguration({
        cfg: nextConfig,
        plugin,
        requestedAccountId: opts.account,
        resolveInput: () =>
          buildChannelSetupInput(opts, plugin.setupContract ? "contract" : "legacy"),
        ...effectContext(),
      });
      if (!prepared.ok) {
        runtime.error(
          prepared.error.kind === "unsupported" ? unsupportedAddMessage() : prepared.error.message,
        );
        runtime.exit(1);
        return;
      }
      const applied = await applyPreparedChannelAccountConfiguration({
        cfg: nextConfig,
        channel: selectedChannel,
        prepared: prepared.value,
        ...effectContext(),
      });
      nextConfig = normalizeExternalChannelSetupConfig({
        cfg: applied.nextConfig,
        channel: selectedChannel,
      });

      await params?.beforePersistentEffect?.();
      const committed = await persistChannelPluginConfig({
        cfg: nextConfig,
        pluginInstalled: pluginRegistrySourceChanged,
        writeOptions: writeSnapshot.writeOptions,
        baseHash: writeSnapshot.snapshot.hash,
        runtime,
      });
      runtime.log(
        `Added ${plugin.meta.label ?? channelLabel(selectedChannel)} account "${applied.accountId}".`,
      );
      const afterAccountConfigWritten = applied.afterAccountConfigWritten;
      if (afterAccountConfigWritten) {
        const { runCollectedChannelOnboardingPostWriteHooks } = await loadOnboardChannels();
        await runCollectedChannelOnboardingPostWriteHooks({
          hooks: [
            {
              channel: selectedChannel,
              accountId: applied.accountId,
              run: async ({ cfg: writtenCfg, runtime: hookRuntime }) =>
                await afterAccountConfigWritten({
                  previousCfg: cfg,
                  cfg: writtenCfg,
                  accountId: applied.accountId,
                  input: applied.input,
                  runtime: hookRuntime,
                }),
            },
          ],
          configPath: committed.path,
          ...effectContext(),
        });
      }
    },
  );
}
