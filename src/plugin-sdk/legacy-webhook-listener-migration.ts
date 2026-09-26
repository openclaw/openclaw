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
  defaultHost?: string;
}): {
  legacyConfigRules: ChannelDoctorLegacyConfigRule[];
  normalizeCompatibilityConfig: (params: { cfg: OpenClawConfig }) => ChannelDoctorConfigMutation;
} {
  const hasLegacy = (value: unknown): boolean => {
    const entry = asObjectRecord(value);
    return Boolean(
      entry && (Object.hasOwn(entry, "webhookPort") || Object.hasOwn(entry, "webhookHost")),
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
      const canonicalRoot = asObjectRecord(root?.legacyWebhook);
      return normalizeChannelConfigEntries({
        cfg,
        channelId: params.channelKey,
        normalizeEntry: ({ entry, accountId, pathPrefix, changes }) => {
          if (!hasLegacy(entry)) {
            return { entry, changed: false };
          }
          const next = { ...entry };
          const port = Object.hasOwn(entry, "webhookPort")
            ? entry.webhookPort
            : ((accountId ? (canonicalRoot?.port ?? root?.webhookPort) : undefined) ??
              params.defaultPort);
          const inheritedHost = accountId
            ? canonicalRoot
              ? canonicalRoot.host
              : (root?.webhookHost ?? params.defaultHost)
            : params.defaultHost;
          const host = entry.webhookHost ?? inheritedHost;
          if (Object.hasOwn(entry, "legacyWebhook")) {
            changes.push(
              `Removed ${pathPrefix} legacy listener keys; ${pathPrefix}.legacyWebhook is already configured.`,
            );
          } else if (accountId && root?.legacyWebhook === false) {
            changes.push(
              `Removed ${pathPrefix} legacy listener keys; ${prefix}.legacyWebhook: false keeps this account's inherited listener disabled.`,
            );
          } else {
            next.legacyWebhook = { port, ...(host !== undefined ? { host } : {}) };
            changes.push(
              `Moved ${pathPrefix} listener settings to ${pathPrefix}.legacyWebhook. Point the external callback or reverse proxy at the Gateway port and webhook path, verify delivery, then set legacyWebhook: false to disable legacy forwarding.`,
            );
          }
          delete next.webhookPort;
          delete next.webhookHost;
          return { entry: next, changed: true };
        },
      });
    },
  };
}
