import {
  normalizeOptionalString,
  normalizeStringifiedOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { listChatChannels } from "../channels/chat-meta.js";
import { normalizeChannelMeta } from "../channels/plugins/meta-normalization.js";
import type { AnyChannelPlugin } from "../channels/plugins/types.plugin.js";
import type { ChannelMeta } from "../channels/plugins/types.public.js";
import { GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA } from "../config/bundled-channel-config-metadata.generated.js";
import type { PluginDiagnostic } from "./manifest-types.js";
import {
  getOfficialExternalPluginCatalogManifest,
  listOfficialExternalChannelCatalogEntries,
} from "./official-external-plugin-catalog.js";

function resolveKnownChannelMeta(id: string): Partial<ChannelMeta> | undefined {
  return (
    listChatChannels().find((meta) => meta?.id === id) ??
    resolveGeneratedBundledChannelMeta(id) ??
    resolveOfficialExternalChannelMeta(id)
  );
}

function resolveOfficialExternalChannelMeta(id: string): Partial<ChannelMeta> | undefined {
  const normalizedId = id.toLowerCase();
  const channel = listOfficialExternalChannelCatalogEntries()
    .map((entry) => getOfficialExternalPluginCatalogManifest(entry)?.channel)
    .find((candidate) => candidate?.id?.trim().toLowerCase() === normalizedId);
  return channel?.aliases?.length ? { aliases: channel.aliases } : undefined;
}

function resolveGeneratedBundledChannelMeta(id: string): ChannelMeta | undefined {
  const channel = GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA.find(
    (entry) => entry.channelId === id && entry.configurable !== false,
  );
  const label = normalizeOptionalString(channel?.label);
  if (!channel || !label) {
    return undefined;
  }
  return {
    id,
    label,
    selectionLabel: label,
    docsPath: `/channels/${id}`,
    blurb: normalizeOptionalString(channel.description) ?? "",
  };
}

function collectMissingChannelMetaFields(meta?: Partial<ChannelMeta> | null): string[] {
  const missing: string[] = (["label", "selectionLabel", "docsPath"] as const).filter(
    (key) => !normalizeOptionalString(meta?.[key]),
  );
  if (typeof meta?.blurb !== "string") {
    missing.push("blurb");
  }
  return missing;
}

const CHANNEL_CAPABILITY_CHAT_TYPES = new Set(["direct", "group", "channel", "thread"]);

/** Validates and normalizes a channel plugin registration before runtime catalog insertion. */
export function normalizeRegisteredChannelPlugin(params: {
  pluginId: string;
  source: string;
  plugin: AnyChannelPlugin;
  pushDiagnostic: (diag: PluginDiagnostic) => void;
}): AnyChannelPlugin | null {
  const diagnose = (level: PluginDiagnostic["level"], message: string) =>
    params.pushDiagnostic({ level, pluginId: params.pluginId, source: params.source, message });
  const id =
    normalizeOptionalString(params.plugin?.id) ??
    normalizeStringifiedOptionalString(params.plugin?.id) ??
    "";
  if (!id) {
    diagnose("error", "channel registration missing id");
    return null;
  }
  const chatTypes = params.plugin.capabilities?.chatTypes;
  if (
    !Array.isArray(chatTypes) ||
    chatTypes.length === 0 ||
    chatTypes.some((chatType) => !CHANNEL_CAPABILITY_CHAT_TYPES.has(chatType))
  ) {
    diagnose(
      "error",
      `channel "${id}" registration missing or invalid required capabilities.chatTypes`,
    );
    return null;
  }
  if (
    typeof params.plugin.config?.listAccountIds !== "function" ||
    typeof params.plugin.config?.resolveAccount !== "function"
  ) {
    diagnose("error", `channel "${id}" registration missing required config helpers`);
    return null;
  }

  const rawMeta = params.plugin.meta as Partial<ChannelMeta> | undefined;
  const rawMetaId = normalizeOptionalString(rawMeta?.id);
  if (rawMetaId && rawMetaId !== id) {
    diagnose(
      "warn",
      `channel "${id}" meta.id mismatch ("${rawMetaId}"); using registered channel id`,
    );
  }

  const missingFields = collectMissingChannelMetaFields(rawMeta);
  if (missingFields.length > 0) {
    diagnose(
      "warn",
      `channel "${id}" registered incomplete metadata; filled missing ${missingFields.join(", ")}`,
    );
  }

  return {
    ...params.plugin,
    id,
    meta: normalizeChannelMeta({
      id,
      meta: rawMeta,
      existing: resolveKnownChannelMeta(id),
    }),
  };
}
