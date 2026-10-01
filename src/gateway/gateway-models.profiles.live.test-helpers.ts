import type { OpenClawConfig } from "../config/types.js";

export type ProviderThinkingModelCompat = {
  thinkingFormat?: string;
  supportedReasoningEfforts?: readonly string[] | null;
};

/** Keeps strict provider proofs scoped to their admitted agent and child runs. */
export function isolateLiveGatewayConfig(cfg: OpenClawConfig): OpenClawConfig {
  return {
    ...cfg,
    gateway: {
      ...cfg.gateway,
      controlUi: {
        ...cfg.gateway?.controlUi,
        // Session-observer digests are independent utility-model traffic and can
        // select the current candidate while a strict wire proof is active.
        sessionObserver: false,
      },
    },
  };
}
