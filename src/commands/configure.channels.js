import { listChatChannels } from "../channels/chat-meta.js";
import { formatCliCommand } from "../cli/command-format.js";
import { CONFIG_PATH } from "../config/config.js";
import { isBlockedObjectKey } from "../config/prototype-keys.js";
import { note } from "../terminal/note.js";
import { sanitizeTerminalText } from "../terminal/safe-text.js";
import { shortenHomePath } from "../utils.js";
import { confirm, select } from "./configure.shared.js";
import { guardCancel } from "./onboard-helpers.js";
const RESERVED_CHANNEL_CONFIG_KEYS = new Set(["defaults", "modelByChannel"]);
const DONE_VALUE = { kind: "done" };
function listConfiguredChannelRemovalChoices(cfg) {
    const channels = cfg.channels;
    if (!channels) {
        return [];
    }
    const labelsById = new Map(listChatChannels().map((meta) => [meta.id, formatChannelRemovalLabel(meta.label, meta.id)]));
    return Object.keys(channels)
        .filter((id) => !RESERVED_CHANNEL_CONFIG_KEYS.has(id))
        .filter((id) => !isBlockedObjectKey(id))
        .map((id) => ({
        id,
        label: labelsById.get(id) ?? formatUnknownChannelRemovalLabel(id),
    }))
        .toSorted(compareChannelRemovalChoices);
}
function formatChannelRemovalLabel(label, fallback) {
    return sanitizeTerminalText(label) || formatUnknownChannelRemovalLabel(fallback);
}
function formatUnknownChannelRemovalLabel(id) {
    return sanitizeTerminalText(id) || "<invalid channel key>";
}
function compareChannelRemovalChoices(left, right) {
    return (left.label.localeCompare(right.label, undefined, { numeric: true, sensitivity: "base" }) ||
        left.id.localeCompare(right.id, undefined, { numeric: true, sensitivity: "base" }));
}
export async function removeChannelConfigWizard(cfg, runtime) {
    let next = { ...cfg };
    while (true) {
        const configured = listConfiguredChannelRemovalChoices(next);
        if (configured.length === 0) {
            note([
                "No channel config found in openclaw.json.",
                `Tip: \`${formatCliCommand("openclaw channels status")}\` shows what is configured and enabled.`,
            ].join("\n"), "Remove channel");
            return next;
        }
        const channelOptions = configured.map((meta) => ({
            value: { kind: "channel", id: meta.id },
            label: meta.label,
            hint: "Deletes tokens + settings from config (credentials stay on disk)",
        }));
        const doneOption = { value: DONE_VALUE, label: "Done" };
        const options = [...channelOptions, doneOption];
        const choice = guardCancel(await select({
            message: "Remove which channel config?",
            options,
        }), runtime);
        if (choice.kind === "done") {
            return next;
        }
        const channel = choice.id;
        const label = configured.find((entry) => entry.id === channel)?.label ?? channel;
        const confirmed = guardCancel(await confirm({
            message: `Delete ${label} configuration from ${shortenHomePath(CONFIG_PATH)}?`,
            initialValue: false,
        }), runtime);
        if (!confirmed) {
            continue;
        }
        const nextChannels = { ...next.channels };
        delete nextChannels[channel];
        if (Object.keys(nextChannels).length) {
            next.channels = nextChannels;
        }
        else {
            delete next.channels;
        }
        note([`${label} removed from config.`, "Note: credentials/sessions on disk are unchanged."].join("\n"), "Channel removed");
    }
}
