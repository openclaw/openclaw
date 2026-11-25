import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { defaultRuntime } from "../../runtime.js";
import {
  readChannelAccountConfigured,
  resolveChannelAccountEnabled,
} from "../account-configuration.js";
import { hasChannelMessageSender } from "../message/adapter.js";
import type { AnyChannelPlugin } from "./types.plugin.js";
import type { ChannelMessageActionAdapter } from "./types.public.js";

/** Configuration-only send fallback; channel-owned action discovery stays authoritative. */
export function createConfiguredMessageToolDiscoveryAdapter(
  plugin: AnyChannelPlugin,
): ChannelMessageActionAdapter | undefined {
  if (!hasChannelMessageSender(plugin)) {
    return undefined;
  }
  const configured = (cfg: OpenClawConfig, accountId: string): boolean | Promise<boolean> => {
    const inspected = plugin.config.inspectAccount?.(cfg, accountId);
    if (inspected != null) {
      const snapshot = asOptionalRecord(inspected);
      if (snapshot?.enabled === false) {
        return false;
      }
      if (typeof snapshot?.configured === "boolean") {
        return snapshot.configured;
      }
    }
    // Discovery consumes synchronous config facts, never operational preparation,
    // credential refresh, account probes, or transport health.
    const account = plugin.config.resolveAccount(cfg, accountId);
    if (!resolveChannelAccountEnabled({ plugin, account, cfg })) {
      return false;
    }
    return readChannelAccountConfigured({ plugin, account, cfg });
  };
  const accountIds = (cfg: OpenClawConfig) =>
    cfg.channels?.[plugin.id]?.enabled === false ? [] : plugin.config.listAccountIds(cfg);
  return {
    describeMessageTool: (context) => {
      const { cfg } = context;
      let available = false;
      for (const accountId of accountIds(cfg)) {
        const result = configured(cfg, accountId);
        if (typeof result === "boolean") {
          available ||= result;
        } else {
          // Pending configuration is not route absence in the released sync factory.
          // Runtime construction awaits its definitive result below.
          available = true;
          void result.catch((error: unknown) =>
            defaultRuntime.error(
              "[message-action-discovery] " +
                plugin.id +
                " configuration inspection failed: " +
                String(error),
            ),
          );
        }
      }
      return available ? { actions: ["send"] } : null;
    },
    describeMessageToolAsync: async (context) => {
      const { cfg } = context;
      for (const accountId of accountIds(cfg)) {
        if (await configured(cfg, accountId)) {
          return { actions: ["send"] };
        }
      }
      return null;
    },
  };
}
