import { safeParseJson } from "@openclaw/normalization-core/json-coercion";
import { asRecord } from "@openclaw/normalization-core/record-coerce";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { MAX_PLUGIN_RELOAD_TARGETS } from "../../packages/gateway-protocol/src/schema/plugins.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizePluginsConfig, resolveEffectiveEnableState } from "../plugins/config-state.js";
import {
  PluginInstallRuntimeBatch,
  type PluginInstallBatchReload,
} from "../plugins/install-runtime-batch.js";
import { hashStableJson } from "../plugins/installed-plugin-index-hash.js";
import { parseInstalledPluginIndex } from "../plugins/installed-plugin-index-store.js";
import {
  withPluginLifecycleLease,
  type PluginLifecycleLeaseContext,
} from "../plugins/plugin-lifecycle-lease.js";
import { readPluginMetadataStateRow } from "../plugins/plugin-metadata-state-worker.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";

export type ClawPluginRuntimeOptions = OpenClawStateDatabaseOptions & {
  reloadPlugins?: PluginInstallBatchReload;
  assertForwardCurrent?: () => void;
  /** The enclosing requirement phase owns nested package installs and compensation. */
  runtimeBatch?: PluginInstallRuntimeBatch;
  runtime?: RuntimeEnv;
};

export function assertClawPluginRequirementsEnabled(
  pluginIds: readonly string[],
  config: OpenClawConfig,
): void {
  const plugins = normalizePluginsConfig(config.plugins);
  for (const pluginId of new Set(pluginIds)) {
    const activation = resolveEffectiveEnableState({
      id: pluginId,
      origin: "global",
      config: plugins,
      rootConfig: config,
    });
    if (!activation.enabled) {
      throw new Error(
        `Claw plugin ${pluginId} is no longer enabled${activation.reason ? ` (${activation.reason})` : ""}`,
      );
    }
  }
}

export async function snapshotClawPluginInstallOwners(
  pluginIds: readonly string[],
  lease: Pick<PluginLifecycleLeaseContext, "databasePath" | "assertOwned">,
): Promise<ReadonlyMap<string, string>> {
  const owners = new Map<string, string>();
  if (pluginIds.length === 0) {
    return owners;
  }
  lease.assertOwned();
  const row = await readPluginMetadataStateRow("installed-index", { path: lease.databasePath });
  lease.assertOwned();
  if (!row) {
    throw new Error("Claw plugin installed index is unavailable after requirement staging");
  }
  const index = parseInstalledPluginIndex(asRecord(safeParseJson(row.value_json))?.index);
  if (!index) {
    throw new Error("Claw plugin installed index is unavailable after requirement staging");
  }
  for (const pluginId of pluginIds) {
    const record = index.installRecords[pluginId];
    if (!record) {
      throw new Error(`Claw plugin ${pluginId} has no installed owner after requirement staging`);
    }
    owners.set(pluginId, hashStableJson(record));
  }
  lease.assertOwned();
  return owners;
}

export async function assertClawPluginInstallOwnersCurrent(
  expected: ReadonlyMap<string, string>,
  lease: Pick<PluginLifecycleLeaseContext, "databasePath" | "assertOwned">,
): Promise<void> {
  const actual = await snapshotClawPluginInstallOwners([...expected.keys()], lease);
  for (const [pluginId, hash] of expected) {
    if (actual.get(pluginId) !== hash) {
      throw new Error(`Claw plugin ${pluginId} installed owner changed after runtime activation`);
    }
  }
}

export async function runClawPluginBatch<T>(
  options: ClawPluginRuntimeOptions,
  pluginCount: number,
  run: (batch: PluginInstallRuntimeBatch | undefined) => Promise<T>,
  runtimeFailure: (failure: unknown, operation: Result<T, unknown>) => Error,
): Promise<T> {
  if (pluginCount > MAX_PLUGIN_RELOAD_TARGETS && (options.reloadPlugins || options.runtimeBatch)) {
    throw new Error(
      `A live Claw requirement batch supports at most ${MAX_PLUGIN_RELOAD_TARGETS} plugin packages. Split the requirement batch before installing.`,
    );
  }
  if (!options.reloadPlugins || options.runtimeBatch) {
    return await withPluginLifecycleLease(options, () => run(options.runtimeBatch));
  }
  const batch = new PluginInstallRuntimeBatch(options, async (targets) => {
    options.assertForwardCurrent?.();
    return await options.reloadPlugins!(
      targets,
      options.assertForwardCurrent ? { commitGuard: options.assertForwardCurrent } : undefined,
    );
  });
  let completed: Result<T, unknown> | undefined;
  const operation = await withPluginLifecycleLease(options, async (lease) => {
    let result: Result<T, unknown>;
    try {
      result = ok(await run(batch));
    } catch (error) {
      result = err(error);
    }
    completed = result;
    // The callback has already completed its compensation. Capture final retained owners
    // before releasing the lease; the Gateway validates those facts again after the gap.
    options.assertForwardCurrent?.();
    await batch.prepare(lease);
    return result;
  }).catch((error: unknown) => {
    const committed = batch.hasCommitted;
    batch.close();
    if (!committed && !completed) {
      throw error;
    }
    throw runtimeFailure(error, completed ?? err(error));
  });
  try {
    const runtime = options.runtime ?? defaultRuntime;
    options.assertForwardCurrent?.();
    const application = await batch.finish((message) => runtime.log(message));
    if (application) {
      runtime.log(`Plugin requirements applied in Gateway generation ${application.generation}.`);
    }
  } catch (error) {
    throw runtimeFailure(error, operation);
  }
  if (!operation.ok) {
    throw operation.error;
  }
  return operation.value;
}
