import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { applyChannelAccountRemoval } from "../../channels/plugins/account-config-mutation.js";
import { getChannelPlugin, normalizeChannelId } from "../../channels/plugins/index.js";
import { listReadOnlyChannelPluginsForConfig } from "../../channels/plugins/read-only.js";
import { formatCliCommand } from "../../cli/command-format.js";
import {
  formatUnknownChannelMessage,
  formatUnsupportedChannelActionMessage,
} from "../../cli/error-format.js";
import type { OpenClawConfig } from "../../config/config.js";
import { callGateway } from "../../gateway/call.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../../routing/session-key.js";
import { defaultRuntime, type RuntimeEnv } from "../../runtime.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../../utils/message-channel.js";
import { createClackPrompter } from "../../wizard/clack-prompter.js";
import { withCommandPluginMetadata } from "../config-validation.js";
import { parseAccountSelector } from "./account-selector.js";
import { persistChannelPluginConfig } from "./plugin-config-persistence.js";
import { channelLabel } from "./runtime-label.js";
import { type ChatChannel, requireValidConfigForWrite } from "./shared.js";

/** Disable or delete a channel account, stopping gateway runtime state before mutation. */
export async function channelsRemoveCommand(
  opts: {
    agent?: string;
    channel?: string;
    account?: string;
    delete?: boolean;
  },
  runtime: RuntimeEnv = defaultRuntime,
  params?: { hasFlags?: boolean },
) {
  parseAccountSelector(opts.account);
  const writeSnapshot = await requireValidConfigForWrite(runtime);
  if (!writeSnapshot) {
    return;
  }
  return withCommandPluginMetadata(
    {
      config: writeSnapshot.snapshot.sourceConfig,
      snapshot: writeSnapshot.writeOptions.basePluginMetadataSnapshot,
    },
    async () => {
      const cfg: OpenClawConfig = writeSnapshot.snapshot.sourceConfig;

      const useWizard = params?.hasFlags === false;
      const prompter = useWizard ? createClackPrompter() : null;
      const rawChannel = normalizeOptionalString(opts.channel) ?? "";
      let lookupChannel = rawChannel;
      let channel: ChatChannel | null = normalizeChannelId(rawChannel);
      let accountId = normalizeAccountId(opts.account);
      const deleteConfig = Boolean(opts.delete);

      if (useWizard && prompter) {
        await prompter.intro("Remove channel account");
        const readOnlyPlugins = listReadOnlyChannelPluginsForConfig(cfg, {
          includeSetupFallbackPlugins: true,
        });
        const selectedChannel = await prompter.select({
          message: "Channel",
          options: readOnlyPlugins.map((plugin) => ({
            value: plugin.id,
            label: plugin.meta.label,
          })),
        });
        channel = selectedChannel;
        lookupChannel = selectedChannel;

        const readOnlyPlugin =
          readOnlyPlugins.find((plugin) => plugin.id === selectedChannel) ??
          getChannelPlugin(selectedChannel);
        const ids = readOnlyPlugin?.config.listAccountIds(cfg) ?? [];
        accountId = normalizeAccountId(
          await prompter.select({
            message: "Account",
            options: ids.map((id) => ({
              value: id,
              label: id === DEFAULT_ACCOUNT_ID ? "default (primary)" : id,
            })),
            initialValue: ids[0] ?? DEFAULT_ACCOUNT_ID,
          }),
        );
      } else if (!rawChannel) {
        runtime.error(
          `Missing channel. Use ${formatCliCommand("openclaw channels remove --channel <name>")} or run ${formatCliCommand("openclaw channels status")} to inspect configured channels.`,
        );
        runtime.exit(1);
        return;
      }

      if (useWizard || !deleteConfig) {
        const confirm = prompter ?? createClackPrompter();
        const channelPromptLabel = channel ? channelLabel(channel) : rawChannel;
        const ok = await confirm.confirm({
          message: `Disable ${channelPromptLabel} account "${accountId}"? (keeps config)`,
          initialValue: true,
        });
        if (!ok) {
          await prompter?.outro("Cancelled.");
          return;
        }
      }

      const shouldResolveInstallablePlugin = Boolean(lookupChannel || channel);
      const resolvedPluginState = shouldResolveInstallablePlugin
        ? await (async () => {
            const { resolveInstallableChannelPlugin } =
              await import("../channel-setup/channel-plugin-resolution.js");
            return await resolveInstallableChannelPlugin({
              cfg,
              runtime,
              agentId: opts.agent,
              rawChannel: lookupChannel,
              allowInstall: false,
            });
          })()
        : null;
      const resolvedChannel = resolvedPluginState?.channelId ?? channel;
      if (!resolvedChannel) {
        runtime.error(formatUnknownChannelMessage({ channel: rawChannel }));
        runtime.exit(1);
        return;
      }
      const plugin = resolvedPluginState?.plugin ?? getChannelPlugin(resolvedChannel);
      if (!plugin) {
        runtime.error(
          resolvedPluginState?.catalogEntry
            ? `Channel plugin "${resolvedPluginState.catalogEntry.id}" is not installed. Run ${formatCliCommand(`openclaw channels add --channel ${resolvedPluginState.catalogEntry.id}`)} first.`
            : formatUnknownChannelMessage({ channel: resolvedChannel }),
        );
        runtime.exit(1);
        return;
      }
      const removal = await applyChannelAccountRemoval({
        cfg,
        plugin,
        accountId,
        action: deleteConfig ? "delete" : "disable",
        runtime,
        beforeRemoval: async () => {
          const shouldStopRuntime = Boolean(
            plugin.gateway?.startAccount || plugin.gateway?.logoutAccount,
          );
          if (!shouldStopRuntime) {
            return;
          }
          try {
            await callGateway({
              config: cfg,
              method: "channels.stop",
              params: {
                channel: resolvedChannel,
                accountId,
              },
              mode: GATEWAY_CLIENT_MODES.BACKEND,
              clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
              deviceIdentity: null,
            });
          } catch (error) {
            runtime.log(
              `Could not stop running ${channelLabel(resolvedChannel)} account "${accountId}" before removing it: ${formatErrorMessage(error)}`,
            );
          }
        },
      });
      if (!removal.ok) {
        runtime.error(
          removal.error.kind !== "unsupported-action"
            ? (() => {
                const kind = removal.error.kind;
                const requestedAccount = useWizard
                  ? accountId
                  : normalizeOptionalString(opts.account);
                const accountIds = removal.error.accountIds;
                const label = channelLabel(resolvedChannel);
                const inspect = `Run ${formatCliCommand(`openclaw channels status --channel ${resolvedChannel}`)} to inspect configured accounts.`;
                const known = accountIds.length ? ` Known accounts: ${accountIds.join(", ")}.` : "";
                if (kind === "nothing-to-remove") {
                  return `${label} account "${accountId}" has no configuration to delete.${known} ${inspect}`;
                }
                if (!requestedAccount) {
                  return `${label} has no ${DEFAULT_ACCOUNT_ID} account to remove.${known} Name an account with ${formatCliCommand("--account <id>")}. ${inspect}`;
                }
                return `${label} has no account "${requestedAccount}" to remove.${known} ${inspect}`;
              })()
            : removal.error.action === "delete"
              ? `${formatUnsupportedChannelActionMessage({ channel: resolvedChannel, action: "delete" })} Use ${formatCliCommand("openclaw channels remove --channel " + resolvedChannel)} to disable it without deleting config.`
              : `${formatUnsupportedChannelActionMessage({ channel: resolvedChannel, action: "disable" })} Use ${formatCliCommand("openclaw channels remove --channel " + resolvedChannel + " --delete")} only if you want to remove config.`,
        );
        runtime.exit(1);
        return;
      }
      await persistChannelPluginConfig({
        cfg: removal.value.nextConfig,
        pluginInstalled: false,
        writeOptions: writeSnapshot.writeOptions,
        baseHash: writeSnapshot.snapshot.hash,
        runtime,
      });
      const message = deleteConfig
        ? `Deleted ${channelLabel(resolvedChannel)} account "${accountId}".`
        : `Disabled ${channelLabel(resolvedChannel)} account "${accountId}".`;
      if (useWizard && prompter) {
        await prompter.outro(message);
      } else {
        runtime.log(message);
      }
    },
  );
}
