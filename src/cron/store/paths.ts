import path from "node:path";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { cloneEnvWithPlatformSemantics } from "../../config/config-env-vars.js";
import { expandHomePrefix } from "../../infra/home-dir.js";
import type { EngineConnection } from "../../infra/sql-connection.js";
import {
  readCronDefaultStoreBindingInDatabase,
  readCronStorePartitionInventoryInDatabase,
  resolveUnboundCronDefaultStoreKey,
} from "../../state/openclaw-state-db-cron-identity-migration.js";
import { executeExistingOpenClawStateRead } from "../../state/openclaw-state-db-readonly.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.types.js";
import { runOpenClawStateWorkerOperation } from "../../state/openclaw-state-worker-store.js";
import { resolveConfigDir } from "../../utils.js";
import {
  readCronStoreStatePath,
  readCronStoreStatePathAsync,
  readCronStoreStatePathInDatabase,
} from "./config-state.js";
import { CronStoreSelectionRequiredError } from "./selection-error.js";
import type { CronStoreSelection } from "./selection.types.js";

export { CronStoreSelectionRequiredError };
export type { CronStoreSelection } from "./selection.types.js";

function resolveDefaultCronDir(env: NodeJS.ProcessEnv): string {
  return path.join(resolveConfigDir(env), "cron");
}

export function resolveDefaultCronStorePath(env: NodeJS.ProcessEnv): string {
  return path.join(resolveDefaultCronDir(env), "jobs.json");
}

export function requireCronStoreSelection(selection: CronStoreSelection) {
  if (selection.status === "unresolved") {
    throw new CronStoreSelectionRequiredError(selection);
  }
  return selection;
}

/** Selection uses the admitted database; a historical key is never a path to open. */
export function resolveCronStoreSelectionInDatabase(
  db: EngineConnection,
  storePath: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  defaultStorePath = resolveDefaultCronStorePath(env),
): CronStoreSelection {
  const selected = storePath?.trim() || readCronStoreStatePathInDatabase(db);
  const displayPath = selected ? resolveSelectedCronJobsStorePath(selected, env) : defaultStorePath;
  if (displayPath !== defaultStorePath) {
    return { status: "ready", storeKey: displayPath, storePath: displayPath };
  }
  const binding = readCronDefaultStoreBindingInDatabase(db);
  if (binding.status === "ready") {
    return { status: "ready", storeKey: binding.storeKey, storePath: displayPath };
  }
  const partitions = readCronStorePartitionInventoryInDatabase(db);
  if (binding.status === "absent") {
    const storeKey = resolveUnboundCronDefaultStoreKey(partitions, defaultStorePath);
    if (storeKey !== undefined) {
      return { status: "ready", storeKey, storePath: displayPath };
    }
  }
  const inventory = partitions.length
    ? partitions.map((partition) => JSON.stringify(partition)).join("; ")
    : "(no persisted cron partitions)";
  return {
    status: "unresolved",
    storePath: displayPath,
    partitions,
    message: `Default cron partition selection is unresolved; cron is paused. Run openclaw doctor --fix in an interactive terminal and complete the "Select the default cron partition" selection step. Partition inventory: ${inventory}`,
  };
}

export function resolveCronStoreKeyInDatabase(
  db: EngineConnection,
  storePath: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return requireCronStoreSelection(resolveCronStoreSelectionInDatabase(db, storePath, env))
    .storeKey;
}

const preparedDefaultSelections = new WeakMap<
  OpenClawStateWorkerContext["admission"],
  Map<string, Promise<CronStoreSelection>>
>();

/** Prepare once with the physical owner; subsequent cron operations carry its opaque key. */
export async function resolveCronStoreSelectionAsync(
  storePath?: string,
  env: NodeJS.ProcessEnv = process.env,
  context = captureOpenClawStateWorkerContext({ env }),
): Promise<CronStoreSelection> {
  const defaultStorePath = resolveDefaultCronStorePath(env);
  const selected = storePath?.trim();
  const explicitPath = selected ? resolveSelectedCronJobsStorePath(selected, env) : undefined;
  if (explicitPath && explicitPath !== defaultStorePath) {
    context.admission.assertCurrent();
    return { status: "ready", storeKey: explicitPath, storePath: explicitPath };
  }
  let prepared = preparedDefaultSelections.get(context.admission);
  const previous = explicitPath ? prepared?.get(defaultStorePath) : undefined;
  if (previous) {
    const selection = await previous;
    context.admission.assertCurrent();
    return selection;
  }
  const resolve = async (): Promise<CronStoreSelection> => {
    const reply = await executeExistingOpenClawStateRead(
      { path: context.admission.databasePath, env },
      {
        type: "automationProactive.storeSelection",
        input: { storePath: explicitPath, defaultStorePath },
      },
      { context, current: true },
    );
    context.admission.assertCurrent();
    if (!reply) {
      return { status: "ready", storeKey: defaultStorePath, storePath: defaultStorePath };
    }
    if (!reply.ok || reply.type !== "automationProactive.storeSelection") {
      throw new Error("Cron selection did not return its admitted snapshot");
    }
    return reply.selection;
  };
  const pending = resolve();
  if (explicitPath) {
    if (!prepared) {
      prepared = new Map();
      preparedDefaultSelections.set(context.admission, prepared);
    }
    const cache = prepared;
    cache.set(defaultStorePath, pending);
    void pending.then(
      (selection) => {
        // Doctor can repair an unresolved binding in this same maintenance lifetime.
        if (selection.status !== "ready") {
          cache.delete(defaultStorePath);
        }
      },
      () => cache.delete(defaultStorePath),
    );
  }
  return pending;
}

export async function resolveCronStoreKeyAsync(
  storePath?: string,
  env: NodeJS.ProcessEnv = process.env,
  context?: OpenClawStateWorkerContext,
): Promise<string> {
  return requireCronStoreSelection(await resolveCronStoreSelectionAsync(storePath, env, context))
    .storeKey;
}

const preparedStoreKeys = new WeakMap<
  OpenClawStateWorkerContext["admission"],
  Map<string, Promise<string>>
>();

/** Runtime writes prepare migration and immutable selection once per admitted lifetime. */
export async function prepareMutableCronStoreKey(
  storePath: string,
  context: OpenClawStateWorkerContext,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const env = cloneEnvWithPlatformSemantics(environment);
  const selectedPath = storePath?.trim()
    ? resolveSelectedCronJobsStorePath(storePath, env)
    : undefined;
  const selectionKey = JSON.stringify([selectedPath, resolveDefaultCronStorePath(env)]);
  context.admission.assertCurrent();
  let prepared = preparedStoreKeys.get(context.admission);
  if (!prepared) {
    prepared = new Map();
    preparedStoreKeys.set(context.admission, prepared);
  }
  let pending = prepared.get(selectionKey);
  if (!pending) {
    pending = (async () => {
      await runOpenClawStateWorkerOperation(context, async () => {});
      return resolveCronStoreKeyAsync(selectedPath, env, context);
    })();
    prepared.set(selectionKey, pending);
    void pending.catch(() => prepared.delete(selectionKey));
  }
  const key = await pending;
  context.admission.assertCurrent();
  return key;
}

/** Resolves the cron jobs store path, expanding home-relative user input. */
export function resolveCronJobsStorePath(
  storePath?: string,
  env: NodeJS.ProcessEnv = process.env,
  stateEnv: NodeJS.ProcessEnv = env,
) {
  const selected = storePath?.trim() || readCronStoreStatePath(stateEnv);
  return resolveSelectedCronJobsStorePath(selected, env);
}

/** Resolve the selected partition on the caller's admitted database connection. */
export function resolveCronJobsStorePathInDatabase(
  db: EngineConnection,
  storePath: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return resolveSelectedCronJobsStorePath(
    storePath?.trim() || readCronStoreStatePathInDatabase(db),
    env,
  );
}

/** Expand an already-selected partition without reading machine state. */
export function resolveSelectedCronJobsStorePath(
  selected: string | undefined,
  env: NodeJS.ProcessEnv,
) {
  if (selected) {
    const raw = selected.trim();
    if (raw.startsWith("~")) {
      return path.resolve(expandHomePrefix(raw, { env }));
    }
    return path.resolve(raw);
  }
  return resolveDefaultCronStorePath(env);
}

/** Resolves the active cron partition from runtime config and environment. */
export function resolveCronJobsStorePathFromConfig(
  cfg: { cron?: unknown },
  env: NodeJS.ProcessEnv = process.env,
  stateEnv: NodeJS.ProcessEnv = env,
): string {
  const store = asOptionalRecord(cfg.cron)?.store;
  return resolveCronJobsStorePath(typeof store === "string" ? store : undefined, env, stateEnv);
}

/** Runtime path selection never opens SQLite on the caller's thread. */
export async function resolveCronJobsStorePathAsync(
  storePath?: string,
  env: NodeJS.ProcessEnv = process.env,
  stateEnv: NodeJS.ProcessEnv = env,
): Promise<string> {
  const selected = storePath?.trim() || (await readCronStoreStatePathAsync(stateEnv));
  return resolveSelectedCronJobsStorePath(selected, env);
}

export async function resolveCronJobsStorePathFromConfigAsync(
  cfg: { cron?: unknown },
  env: NodeJS.ProcessEnv = process.env,
  stateEnv: NodeJS.ProcessEnv = env,
): Promise<string> {
  const store = asOptionalRecord(cfg.cron)?.store;
  return resolveCronJobsStorePathAsync(
    typeof store === "string" ? store : undefined,
    env,
    stateEnv,
  );
}
