import { getChannelPlugin, listChannelPlugins } from "../channels/plugins/index.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/config.js";
import { CONFIG_PATH } from "../config/config.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
import { note } from "../terminal/note.js";
import { shortenHomePath } from "../utils.js";
import { confirm, select } from "./configure.shared.js";
import { guardCancel } from "./onboard-helpers.js";

export async function removeChannelConfigWizard(
  cfg: OpenClawConfig,
  runtime: RuntimeEnv,
): Promise<OpenClawConfig> {
  let next = { ...cfg };

  const listConfiguredChannels = () =>
    listChannelPlugins()
      .map((plugin) => plugin.meta)
      .filter((meta) => next.channels?.[meta.id] !== undefined);

  while (true) {
    const configured = listConfiguredChannels();
    if (configured.length === 0) {
      note(
        [
          "No channel config found in openclaw.json.",
          `Tip: \`${formatCliCommand("openclaw channels status")}\` shows what is configured and enabled.`,
        ].join("\n"),
        "Remove channel",
      );
      return next;
    }

    const channel = guardCancel(
      await select({
        message: "Remove which channel config?",
        options: [
          ...configured.map((meta) => ({
            value: meta.id,
            label: meta.label,
            hint: "Deletes tokens + settings from config (credentials stay on disk)",
          })),
          { value: "done", label: "Done" },
        ],
      }),
      runtime,
    );

    if (channel === "done") {
      return next;
    }

    const label = getChannelPlugin(channel)?.meta.label ?? channel;
    const confirmed = guardCancel(
      await confirm({
        message: `Delete ${label} configuration from ${shortenHomePath(CONFIG_PATH)}?`,
        initialValue: false,
      }),
      runtime,
    );
    if (!confirmed) {
      continue;
    }

    const plugin = getChannelPlugin(channel);
    if (!plugin?.config.deleteAccount) {
      const nextChannels: Record<string, unknown> = { ...next.channels };
      delete nextChannels[channel];
      next = {
        ...next,
        channels: Object.keys(nextChannels).length
          ? (nextChannels as OpenClawConfig["channels"])
          : undefined,
      };
    } else {
      const accountIds = plugin.config.listAccountIds(next);
      const orderedAccountIds = [...accountIds].toSorted((a, b) => {
        if (a === DEFAULT_ACCOUNT_ID && b !== DEFAULT_ACCOUNT_ID) {
          return 1;
        }
        if (b === DEFAULT_ACCOUNT_ID && a !== DEFAULT_ACCOUNT_ID) {
          return -1;
        }
        return a.localeCompare(b);
      });

      for (const accountId of orderedAccountIds) {
        const prevCfg = next;
        next = plugin.config.deleteAccount({
          cfg: next,
          accountId,
        });
        await plugin.lifecycle?.onAccountRemoved?.({
          prevCfg,
          accountId,
          runtime,
        });
      }
    }

    note(
      [`${label} removed from config.`, "Note: credentials/sessions on disk are unchanged."].join(
        "\n",
      ),
      "Channel removed",
    );
  }
}
