import { asObjectRecord } from "../config/channel-compat-normalization.js";
import { normalizeChannelConfigEntries } from "../config/channel-doctor-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  ChannelDoctorConfigMutation,
  ChannelDoctorLegacyConfigRule,
} from "./channel-contract.js";

/** Preserve explicitly configured webhook listeners while moving ingress onto Gateway routes. */
export function createLegacyWebhookListenerDoctorContract(params: {
  channelKey: string;
  defaultPort: number;
  portKey?: string;
  hostKey?: string | null;
  webhookKey?: string;
  defaultHost?: string;
}): {
  legacyConfigRules: ChannelDoctorLegacyConfigRule[];
  normalizeCompatibilityConfig: (params: { cfg: OpenClawConfig }) => ChannelDoctorConfigMutation;
} {
  const portKey = params.portKey ?? "webhookPort";
  const hostKey = params.hostKey === undefined ? "webhookHost" : params.hostKey;
  const source = (entry: Record<string, unknown>) =>
    params.webhookKey ? asObjectRecord(entry[params.webhookKey]) : entry;
  const hasLegacy = (value: unknown): boolean => {
    const entry = asObjectRecord(value);
    const listener = entry && source(entry);
    return Boolean(
      listener &&
      (Object.hasOwn(listener, portKey) || (hostKey && Object.hasOwn(listener, hostKey))),
    );
  };
  const prefix = `channels.${params.channelKey}`;
  return {
    legacyConfigRules: [
      {
        path: ["channels", params.channelKey],
        message: `${prefix} webhook listeners moved to Gateway routes. Run "openclaw doctor --fix" to preserve explicitly configured listener settings as legacyWebhook.`,
        match: (value) => {
          const accounts = asObjectRecord(asObjectRecord(value)?.accounts);
          return hasLegacy(value) || Object.values(accounts ?? {}).some(hasLegacy);
        },
      },
    ],
    normalizeCompatibilityConfig: ({ cfg }) => {
      const root = asObjectRecord(asObjectRecord(cfg.channels)?.[params.channelKey]);
      const inherited = root && source(root);
      const canonicalRoot = asObjectRecord(root?.legacyWebhook);
      return normalizeChannelConfigEntries({
        cfg,
        channelId: params.channelKey,
        normalizeEntry: ({ entry, accountId, pathPrefix, changes }) => {
          const listener = source(entry);
          if (!listener || !hasLegacy(entry)) {
            return { entry, changed: false };
          }
          const next = { ...entry };
          const port = Object.hasOwn(listener, portKey)
            ? listener[portKey]
            : ((accountId ? (canonicalRoot?.port ?? inherited?.[portKey]) : undefined) ??
              params.defaultPort);
          const inheritedHost = accountId
            ? canonicalRoot
              ? canonicalRoot.host
              : ((hostKey ? inherited?.[hostKey] : undefined) ?? params.defaultHost)
            : params.defaultHost;
          const host = hostKey ? (listener[hostKey] ?? inheritedHost) : inheritedHost;
          const legacyPath = [pathPrefix, params.webhookKey].filter(Boolean).join(".");
          if (Object.hasOwn(entry, "legacyWebhook")) {
            changes.push(
              `Removed ${legacyPath} legacy listener keys; ${pathPrefix}.legacyWebhook is already configured.`,
            );
          } else if (accountId && root?.legacyWebhook === false) {
            changes.push(
              `Removed ${legacyPath} legacy listener keys; ${prefix}.legacyWebhook: false keeps this account's inherited listener disabled.`,
            );
          } else {
            next.legacyWebhook = { port, ...(host !== undefined ? { host } : {}) };
            changes.push(
              `Moved ${legacyPath} listener settings to ${pathPrefix}.legacyWebhook. Point the external callback or reverse proxy at the Gateway port and webhook path, verify delivery, then set legacyWebhook: false to disable legacy forwarding.`,
            );
          }
          const updated = params.webhookKey ? { ...listener } : next;
          delete updated[portKey];
          if (hostKey) {
            delete updated[hostKey];
          }
          if (params.webhookKey) {
            if (Object.keys(updated).length) {
              next[params.webhookKey] = updated;
            } else {
              delete next[params.webhookKey];
            }
          }
          return { entry: next, changed: true };
        },
      });
    },
  };
}
