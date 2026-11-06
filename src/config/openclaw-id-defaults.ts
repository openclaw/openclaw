import type { OpenClawConfig } from "./types.openclaw.js";

/** Public staging services used only after the OpenClaw ID Labs opt-in. */
export const openClawIdStagingDefaults = {
  issuerUrl: "https://openclaw-id-staging.services-91b.workers.dev/api/auth",
  clientId: "spqhcSZaOxXzCUeuSGaAcHWXRDatqwUU",
  discoveryUrl: "https://openclaw-discovery-staging.services-91b.workers.dev",
  relayUrl: "https://relay.staging.crabd.xyz/",
  loaderDomain: "crabd.xyz",
} as const;

/** Fill only absent service fields; disabled configurations remain untouched. */
export function applyOpenClawIdDefaults(config: OpenClawConfig): OpenClawConfig {
  const id = config.gateway?.openclawId;
  if (id?.enabled !== true) {
    return config;
  }
  return {
    ...config,
    gateway: {
      ...config.gateway,
      openclawId: {
        ...id,
        issuerUrl: id.issuerUrl ?? openClawIdStagingDefaults.issuerUrl,
        clientId: id.clientId ?? openClawIdStagingDefaults.clientId,
        discoveryUrl: id.discoveryUrl ?? openClawIdStagingDefaults.discoveryUrl,
        relayUrl: id.relayUrl ?? openClawIdStagingDefaults.relayUrl,
        loaderDomain: id.loaderDomain ?? openClawIdStagingDefaults.loaderDomain,
      },
    },
  };
}
