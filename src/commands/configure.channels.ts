import { listChatChannels } from "../channels/chat-meta.js";
import { formatCliCommand } from "../cli/command-format.js";
import { CONFIG_PATH } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeEnv } from "../runtime.js";
import { note } from "../terminal/note.js";
import { shortenHomePath } from "../utils.js";
import { confirm, select } from "./configure.shared.js";
import { guardCancel } from "./onboard-helpers.js";

type ConfiguredChannelRemovalChoice = {
  id: string;
  label: string;
};

function listConfiguredChannelRemovalChoices(
  cfg: OpenClawConfig,
): ConfiguredChannelRemovalChoice[] {
  const channels = cfg.channels;
  if (!channels) {
    return [];
  }
  const labelsById = new Map(listChatChannels().map((meta) => [meta.id, meta.label]));
  return Object.keys(channels)
    .map((id) => ({
      id,
      label: labelsById.get(id) ?? id,
    }))
    .toSorted(compareChannelRemovalChoices);
}

function compareChannelRemovalChoices(
  left: ConfiguredChannelRemovalChoice,
  right: ConfiguredChannelRemovalChoice,
): number {
  return (
    left.label.localeCompare(right.label, undefined, { numeric: true, sensitivity: "base" }) ||
    left.id.localeCompare(right.id, undefined, { numeric: true, sensitivity: "base" })
  );
}

export async function removeChannelConfigWizard(
  cfg: OpenClawConfig,
  runtime: RuntimeEnv,
): Promise<OpenClawConfig> {
  let next = { ...cfg };

  while (true) {
    const configured = listConfiguredChannelRemovalChoices(next);
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

    const label = configured.find((entry) => entry.id === channel)?.label ?? channel;
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

    const nextChannels: Record<string, unknown> = { ...next.channels };
    delete nextChannels[channel];
    if (Object.keys(nextChannels).length) {
      next.channels = nextChannels as OpenClawConfig["channels"];
    } else {
      delete next.channels;
    }

    note(
      [`${label} removed from config.`, "Note: credentials/sessions on disk are unchanged."].join(
        "\n",
      ),
      "Channel removed",
    );
  }
}
