import { AsyncLocalStorage } from "node:async_hooks";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  getDatabaseEngineSelection,
  withDatabaseEngineSelection,
} from "../infra/database-engine/context.js";
import { resolveDatabaseFamilyEngines } from "../infra/database-engine/registry.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { preparePluginMetadataMachineStateAsync } from "./installed-plugin-index-record-state.js";

const unavailablePluginStateEngine = resolveGlobalSingleton(
  Symbol.for("openclaw.unavailablePluginStateEngine"),
  () => new AsyncLocalStorage<boolean>(),
);

/** True while a configured PostgreSQL state store lacks credentials during non-owning CLI discovery. */
export function isPluginStateEngineUnavailable(): boolean {
  return unavailablePluginStateEngine.getStore() === true;
}

async function prepareSelectedMachineState(params: {
  env: NodeJS.ProcessEnv;
  stateDir?: string;
  withCache?: <R>(run: () => R) => R;
}): Promise<void> {
  const prepare = () =>
    preparePluginMetadataMachineStateAsync({
      env: params.env,
      ...(params.stateDir ? { stateDir: params.stateDir } : {}),
    });
  const activate = await (params.withCache ? params.withCache(prepare) : prepare());
  if (params.withCache) {
    params.withCache(activate);
  } else {
    activate();
  }
}

/**
 * Scope configured PostgreSQL state-engine selection around CLI plugin metadata and source
 * preparation when central CLI startup deferred process-wide selection.
 */
export async function withConfiguredPluginStateEngine<T>(
  params: {
    config?: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
    stateDir?: string;
    prepareMachineState?: boolean;
    withCache?: <R>(run: () => R) => R;
  },
  run: () => Promise<T>,
): Promise<T> {
  const env = params.env ?? process.env;
  const existing = getDatabaseEngineSelection();
  if (existing) {
    if (params.prepareMachineState && existing.effectiveEngines.state === "postgres") {
      await prepareSelectedMachineState({
        env,
        stateDir: params.stateDir,
        withCache: params.withCache,
      });
    }
    return await run();
  }
  if (!params.config || resolveDatabaseFamilyEngines(params.config).state !== "postgres") {
    return await run();
  }
  const { resolveDatabaseEngineSelection } = await import("../infra/database-engine/config.js");
  let selection;
  try {
    selection = await resolveDatabaseEngineSelection(params.config, env);
  } catch {
    return await unavailablePluginStateEngine.run(true, run);
  }
  return await withDatabaseEngineSelection(selection, async () => {
    if (params.prepareMachineState) {
      await prepareSelectedMachineState({
        env,
        stateDir: params.stateDir,
        withCache: params.withCache,
      });
    }
    return await run();
  });
}
