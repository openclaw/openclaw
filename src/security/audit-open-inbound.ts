import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import {
  resolveChannelDmPolicy,
  type ChannelDmAllowFromMode,
} from "../channels/plugins/dm-access.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginPackageChannel } from "../plugins/manifest.js";

/** Resolve configured open scopes once, using the selected channel metadata's DM precedence. */
export function listConfiguredOpenInboundPolicyPaths(
  cfg: OpenClawConfig,
  channels: readonly PluginPackageChannel[] = [],
): string[] {
  const modes = new Map<string, ChannelDmAllowFromMode>();
  for (const channel of channels) {
    const mode = channel.doctorCapabilities?.dmAllowFromMode;
    if (mode && channel.id) {
      for (const id of [channel.id, ...(channel.aliases ?? [])]) {
        modes.set(id, mode);
      }
    }
  }
  const paths: string[] = [];
  const visit = (value: unknown, scope: string, mode: ChannelDmAllowFromMode) => {
    const record = asNullableRecord(value);
    if (!record) {
      return;
    }
    if (record.groupPolicy === "open") {
      paths.push(`${scope}.groupPolicy`);
    }
    if (resolveChannelDmPolicy({ account: record, mode }) === "open") {
      const nestedWins =
        mode === "nestedOnly"
          ? asNullableRecord(record.dm)?.policy != null
          : record.dmPolicy == null;
      paths.push(`${scope}.${nestedWins ? "dm.policy" : "dmPolicy"}`);
    }
    for (const [key, nested] of Object.entries(record)) {
      visit(nested, `${scope}.${key}`, mode);
    }
  };
  for (const [id, channel] of Object.entries(cfg.channels ?? {})) {
    if (id !== "modelByChannel" && id !== "tools") {
      visit(channel, `channels.${id}`, modes.get(id) ?? "topOnly");
    }
  }
  return paths.toSorted();
}
