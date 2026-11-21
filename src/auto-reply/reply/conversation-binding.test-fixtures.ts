import type { SessionBindingRecord } from "../../infra/outbound/session-binding-service.js";
import type { PluginBindingMetadata } from "../../plugins/conversation-binding-metadata.js";

export function createPluginBindingRecord({
  bindingId,
  targetSessionKey,
  conversation,
  boundAt = 1710000000000,
  pluginId = "openclaw-codex-app-server",
  ...metadata
}: Pick<SessionBindingRecord, "bindingId" | "targetSessionKey" | "conversation"> &
  Partial<Pick<SessionBindingRecord, "boundAt">> &
  Omit<PluginBindingMetadata, "pluginBindingOwner" | "pluginId"> & {
    pluginId?: string;
  }): SessionBindingRecord {
  return {
    bindingId,
    targetSessionKey,
    targetKind: "session",
    conversation,
    status: "active",
    boundAt,
    metadata: { pluginBindingOwner: "plugin", pluginId, ...metadata },
  };
}
