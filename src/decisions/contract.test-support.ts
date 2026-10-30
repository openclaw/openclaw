import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runPluginRegisterSyncInRegistry } from "../plugins/loader-module-runtime.js";
import { createPluginRecord } from "../plugins/loader-records.js";
import { createTestPluginRegistry } from "../plugins/registry-runtime.test-helpers.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import type { DecisionProviderV2, DecisionProviderV1 } from "./provider-types.js";
import type { UnavailableReason } from "./types.js";

export const unavailable = <Reason extends UnavailableReason>(
  reason: Reason,
): { status: "unavailable"; reason: Reason } => ({
  status: "unavailable" as const,
  reason,
});

export function createDecisionRegistry(
  config: OpenClawConfig,
  provider: DecisionProviderV1 | DecisionProviderV2,
) {
  const builder = createTestPluginRegistry();
  const record = createPluginRecord({
    id: "owner",
    source: "/synthetic/index.ts",
    origin: "global",
    enabled: true,
    configSchema: false,
    contracts: { decisionProviders: [provider.id] },
  });
  const api = builder.createApi(record, { config });
  runPluginRegisterSyncInRegistry(
    (registration) => registration.registerDecisionProvider(provider),
    api,
    builder.registry,
    record.id,
  );
  builder.registry.plugins.push(record);
  setActivePluginRegistry(builder.registry);
  return { ...builder, record, api };
}

export function waitForAbort(signal: AbortSignal, started?: () => void) {
  return new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
    started?.();
  });
}
