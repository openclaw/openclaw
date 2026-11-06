import type { ConfigSnapshotReadMeasure } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { MigrationMessages } from "../infra/state-migrations.types.js";

/** Preserve a retired partition selector even when other config cannot drive core migrations. */
export async function migrateRetainedStore(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  measure: ConfigSnapshotReadMeasure;
  report: (result: MigrationMessages) => void;
}): Promise<void> {
  const cfg = retainStoreConfig(params.config);
  if (!cfg) {
    return;
  }
  const { repairLegacyCronStoreWithoutPrompt } = await params.measure(
    "cron-repair-import",
    () => import("./doctor/cron/legacy-repair.js"),
  );
  params.report(
    await params.measure("cron-repair", () =>
      repairLegacyCronStoreWithoutPrompt({ cfg, migrateCodexModelRefs: false }),
    ),
  );
  const { migrateLegacyConfigMachineState } =
    await import("../infra/state-migrations.config-machine-state.js");
  params.report(migrateLegacyConfigMachineState({ config: params.config, env: params.env }));
}

/** Restores retired cron migration inputs that canonical config migration intentionally strips. */
export function withLegacyConfig(
  config: OpenClawConfig,
  legacyConfig: OpenClawConfig | undefined,
): OpenClawConfig {
  const legacyCron = legacyConfig?.cron as Record<string, unknown> | undefined;
  if (
    !legacyCron ||
    (!Object.hasOwn(legacyCron, "store") && !Object.hasOwn(legacyCron, "webhook"))
  ) {
    return config;
  }
  return {
    ...config,
    cron: {
      ...config.cron,
      ...(Object.hasOwn(legacyCron, "store") ? { store: legacyCron.store } : {}),
      ...(Object.hasOwn(legacyCron, "webhook") ? { webhook: legacyCron.webhook } : {}),
    },
  } as OpenClawConfig;
}

/** Isolates the trusted partition selector from a partially valid legacy config. */
function retainStoreConfig(config: OpenClawConfig | undefined): OpenClawConfig | undefined {
  const cron = config?.cron as { store?: unknown; webhook?: unknown } | undefined;
  if (typeof cron?.store !== "string" || !cron.store.trim()) {
    return undefined;
  }
  return {
    cron: {
      store: cron.store,
      ...(Object.hasOwn(cron, "webhook") ? { webhook: cron.webhook } : {}),
    },
  } as OpenClawConfig;
}
