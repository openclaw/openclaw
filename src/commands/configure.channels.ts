// Configure wizard helper for removing channel config sections safely.
import { note } from "../../packages/terminal-core/src/note.js";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { listChatChannels } from "../channels/chat-meta.js";
import { formatCliCommand } from "../cli/command-format.js";
import { CONFIG_PATH } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isBlockedObjectKey } from "../infra/prototype-keys.js";
import type { RuntimeEnv } from "../runtime.js";
import { shortenHomePath } from "../utils.js";
import { confirm, select } from "./configure.shared.js";
import { guardCancel } from "./onboard-helpers.js";

type ConfiguredChannelRemovalChoice = {
  id: string;
  label: string;
};

type ChannelRemovalSelectValue = { kind: "channel"; id: string } | { kind: "done" };
const RESERVED_CHANNEL_CONFIG_KEYS = new Set(["defaults", "modelByChannel"]);

function listConfiguredChannelRemovalChoices(
  cfg: OpenClawConfig,
): ConfiguredChannelRemovalChoice[] {
  const channels = cfg.channels;
  if (!channels) {
    return [];
  }
  const labelsById = new Map(
    listChatChannels().map((meta) => [meta.id, formatChannelRemovalLabel(meta.label, meta.id)]),
  );
  return Object.keys(channels)
    .filter((id) => !RESERVED_CHANNEL_CONFIG_KEYS.has(id))
    .filter((id) => !isBlockedObjectKey(id))
    .map((id) => ({
      id,
      label: labelsById.get(id) ?? formatUnknownChannelRemovalLabel(id),
    }))
    .toSorted(compareChannelRemovalChoices);
}

function formatChannelRemovalLabel(label: string, fallback: string): string {
  return sanitizeTerminalText(label) || formatUnknownChannelRemovalLabel(fallback);
}

function formatUnknownChannelRemovalLabel(id: string): string {
  return sanitizeTerminalText(id) || "<invalid channel key>";
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

/** Prompt for configured channel sections to remove from openclaw.json. */
export async function removeChannelConfigWizard(
  cfg: OpenClawConfig,
  runtime: RuntimeEnv,
): Promise<OpenClawConfig> {
  const next = { ...cfg };

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

    const choice = guardCancel(
      await select<ChannelRemovalSelectValue>({
        message: "Remove which channel config?",
        options: [
          ...configured.map((meta) => ({
            value: { kind: "channel" as const, id: meta.id },
            label: meta.label,
            hint: "Deletes tokens + settings from config (credentials stay on disk)",
          })),
          { value: { kind: "done" }, label: "Done" },
        ],
      }),
      runtime,
      1,
    );

    if (choice.kind === "done") {
      return next;
    }

    const channel = choice.id;
    const label = configured.find((entry) => entry.id === channel)?.label ?? channel;
    const confirmed = guardCancel(
      await confirm({
        message: `Delete ${label} configuration from ${shortenHomePath(CONFIG_PATH)}?`,
        initialValue: false,
      }),
      runtime,
      1,
    );
    if (!confirmed) {
      continue;
    }

    const nextChannels = { ...next.channels };
    delete nextChannels[channel];
    if (Object.keys(nextChannels).length) {
      next.channels = nextChannels;
    } else {
      delete next.channels;
    }

    note(
      [
        `${label} selected for removal from config.`,
        "Note: credentials/sessions on disk are unchanged.",
      ].join("\n"),
      "Channel removal",
    );
  }
}
