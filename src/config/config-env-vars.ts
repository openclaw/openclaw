import { AsyncLocalStorage } from "node:async_hooks";
import {
  expandEnvNormalizationKeys,
  normalizeZaiEnv,
  resolveEnvNormalizationKeys,
} from "../infra/env.js";
import {
  collectConfigRuntimeEnvVars,
  envSnapshotEntriesEqual,
  envSnapshotKey,
  findCaseInsensitiveEnvKey,
  indexConfigRuntimeEnvValues,
  replaceEnvSnapshotEntry,
  rollbackConfigRuntimeEnvChanges,
  snapshotEnvByPlatformKey,
  snapshotEnvProperties,
  type EnvSnapshotEntry,
  type PublishedConfigRuntimeEnvChange,
} from "./config-env-values.js";
import type { OpenClawConfig } from "./types.js";

export { collectConfigRuntimeEnvVars, isConfigRuntimeEnvVarAllowed } from "./config-env-values.js";

// Read-time application is not a runtime publication, but isolated write preparation
// still needs its provenance to distinguish config-owned values from equal OS values.
const appliedConfigEnvOwnership = new WeakMap<NodeJS.ProcessEnv, Record<string, string>>();

function resolveAppliedConfigEnvOwnership(env: NodeJS.ProcessEnv): Record<string, string> {
  return {
    ...appliedConfigEnvOwnership.get(env),
    ...(env === process.env ? publishedConfigRuntimeEnvState.ownedEnv : {}),
  };
}

/** Capture read-time provenance separately from runtime publication authority. */
export function snapshotEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const snapshot = cloneEnvWithPlatformSemantics(env);
  appliedConfigEnvOwnership.set(snapshot, { ...appliedConfigEnvOwnership.get(env) });
  return snapshot;
}

/** Roll back a rejected read only while both its values and provenance are current. */
export function restoreEnvChangesIfUnchanged(params: {
  env: NodeJS.ProcessEnv;
  before: Record<string, string | undefined>;
  after: Record<string, string | undefined>;
}): void {
  const before = snapshotEnvByPlatformKey(params.before);
  const after = snapshotEnvByPlatformKey(params.after);
  const current = snapshotEnvByPlatformKey(params.env);
  const beforeOwned = snapshotEnvByPlatformKey(appliedConfigEnvOwnership.get(params.before) ?? {});
  const afterOwned = snapshotEnvByPlatformKey(appliedConfigEnvOwnership.get(params.after) ?? {});
  const owned = { ...appliedConfigEnvOwnership.get(params.env) };
  const currentOwned = snapshotEnvByPlatformKey(owned);
  const keys = new Set(before.keys());
  for (const entries of [after, beforeOwned, afterOwned]) {
    entries.forEach((_value, key) => keys.add(key));
  }
  for (const key of keys) {
    if (
      !envSnapshotEntriesEqual(current.get(key), after.get(key)) ||
      !envSnapshotEntriesEqual(currentOwned.get(key), afterOwned.get(key))
    ) {
      continue;
    }
    if (!envSnapshotEntriesEqual(before.get(key), after.get(key))) {
      replaceEnvSnapshotEntry(params.env, current.get(key), before.get(key));
    }
    // Lower-precedence replacement can change ownership without changing bytes.
    replaceEnvSnapshotEntry(owned, currentOwned.get(key), beforeOwned.get(key));
  }
  appliedConfigEnvOwnership.set(params.env, owned);
}

type ConfigReadEnvChanges = {
  env: NodeJS.ProcessEnv;
  receipts: Array<() => void>;
  active: boolean;
};
const configReadEnvChanges = new AsyncLocalStorage<ConfigReadEnvChanges>();

/** Retain only synchronous reader effects for a containing write's compensation. */
export async function withConfigReadEnvChanges<T>(
  env: NodeJS.ProcessEnv,
  run: (restore: () => void) => Promise<T>,
): Promise<T> {
  const scope: ConfigReadEnvChanges = { env, receipts: [], active: true };
  try {
    return await configReadEnvChanges.run(scope, () =>
      run(() => {
        for (const restore of scope.receipts.toReversed()) {
          restore();
        }
      }),
    );
  } finally {
    scope.active = false;
  }
}

function snapshotConfigEnvOwnership(
  env: NodeJS.ProcessEnv,
  properties: Map<string, EnvSnapshotEntry>,
): Map<string, EnvSnapshotEntry> {
  return new Map(
    Object.entries(appliedConfigEnvOwnership.get(env) ?? {}).map(([key, value]) => {
      // Windows aliases may enumerate a different spelling than the config collector.
      // Bind provenance to that actual slot, retaining its spelling for restoration.
      const propertyKey =
        !properties.has(key) && Object.hasOwn(env, key)
          ? [...properties.keys()].find(
              (candidate) => candidate.toUpperCase() === key.toUpperCase(),
            )
          : key;
      return [propertyKey ?? key, { key, value }];
    }),
  );
}

/** Awaited validation may change other keys; the producer owns only its synchronous effects. */
export function captureConfigReadEnvMutation<T>(
  env: NodeJS.ProcessEnv,
  run: () => T,
  retainRestore?: (restore: () => void) => void,
): T {
  const before = snapshotEnvProperties(env);
  const beforeOwned = snapshotConfigEnvOwnership(env, before);
  const scope = configReadEnvChanges.getStore();
  try {
    return run();
  } finally {
    const after = snapshotEnvProperties(env);
    const afterOwned = snapshotConfigEnvOwnership(env, after);
    const changes = [
      ...new Set([...before.keys(), ...after.keys(), ...beforeOwned.keys(), ...afterOwned.keys()]),
    ]
      .map((key) => ({
        key,
        before: before.get(key),
        after: after.get(key),
        beforeOwned: beforeOwned.get(key),
        afterOwned: afterOwned.get(key),
      }))
      .filter(
        (change) =>
          !envSnapshotEntriesEqual(change.before, change.after) ||
          !envSnapshotEntriesEqual(change.beforeOwned, change.afterOwned),
      );
    const pairedDestinations = new Set<string>();
    for (const change of changes) {
      const previous = change.before;
      if (!previous || change.after || !Object.hasOwn(env, previous.key)) {
        continue;
      }
      const destinations = changes.filter(
        (candidate) =>
          !candidate.before &&
          candidate.after &&
          !pairedDestinations.has(candidate.key) &&
          candidate.key.toUpperCase() === previous.key.toUpperCase() &&
          env[previous.key] === candidate.after.value,
      );
      if (destinations.length !== 1) {
        continue;
      }
      const destination = destinations[0]!;
      // Pair aliases only when this environment actually resolves them. Plain
      // objects and Windows Worker environments can have separate case-sensitive keys.
      change.after = destination.after;
      change.afterOwned = destination.afterOwned;
      pairedDestinations.add(destination.key);
    }
    let active = true;
    const restore = () => {
      if (!active) {
        return;
      }
      active = false;
      const owned = { ...appliedConfigEnvOwnership.get(env) };
      const current = snapshotEnvProperties(env);
      const currentOwned = snapshotConfigEnvOwnership(env, current);
      for (const change of changes) {
        if (pairedDestinations.has(change.key)) {
          continue;
        }
        const key = change.after?.key ?? change.before?.key ?? change.key;
        const unchanged = change.after
          ? envSnapshotEntriesEqual(current.get(key), change.after)
          : !Object.hasOwn(env, key);
        if (!unchanged || !envSnapshotEntriesEqual(currentOwned.get(key), change.afterOwned)) {
          continue;
        }
        if (!envSnapshotEntriesEqual(change.before, change.after)) {
          replaceEnvSnapshotEntry(env, current.get(key), change.before);
        }
        // Equal-byte replacement can still transfer ownership from a lower-precedence layer.
        replaceEnvSnapshotEntry(owned, currentOwned.get(key), change.beforeOwned);
      }
      appliedConfigEnvOwnership.set(env, owned);
    };
    // Snapshot rejection and include compensation consume the same receipt once.
    retainRestore?.(restore);
    if (scope?.active && scope.env === env) {
      scope.receipts.push(restore);
    }
  }
}

export function cloneEnvWithPlatformSemantics(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  let cloned: NodeJS.ProcessEnv = { ...env };
  // A plain spread loses Windows process.env's case-insensitive lookup and assignment semantics.
  if (process.platform === "win32") {
    // Windows process.env is case-insensitive. The previous implementation returned a Proxy
    // to emulate that, but a Proxy can never be structured-cloned, so any copy of this
    // environment that crossed a worker_threads boundary failed with:
    //   WorkerTaskError: DataCloneError: #<Object> could not be cloned.
    // Emulate case-insensitivity with plain uppercase aliases instead so the value stays
    // cloneable across threads.
    for (const caseKey of Object.keys(cloned)) {
      const upperKey = caseKey.toUpperCase();
      if (upperKey !== caseKey && !Object.hasOwn(cloned, upperKey)) {
        cloned[upperKey] = cloned[caseKey];
      }
    }
  }
  appliedConfigEnvOwnership.set(cloned, resolveAppliedConfigEnvOwnership(env));
  return cloned;
}

export function createConfigRuntimeEnv(
  cfg: OpenClawConfig,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = cloneEnvWithPlatformSemantics(baseEnv);
  applyConfigEnvVars(cfg, env);
  return env;
}

export type ConfigRuntimeEnvPublication = (() => void) & {
  commit: () => void;
};

export type PreparedConfigRuntimeEnv = {
  env: NodeJS.ProcessEnv;
  publish: () => ConfigRuntimeEnvPublication;
};

type PublishedConfigRuntimeEnvState = {
  generation: number;
  ownedEnv: Readonly<Record<string, string>>;
  sourceConfig: OpenClawConfig | null;
};

type PendingConfigRuntimeEnvPublication = {
  previousState: PublishedConfigRuntimeEnvState;
  changes: ReadonlyMap<string, PublishedConfigRuntimeEnvChange>;
  rollbackRequested: boolean;
};

let publishedConfigRuntimeEnvState: PublishedConfigRuntimeEnvState = {
  generation: 0,
  ownedEnv: {},
  sourceConfig: null,
};
// Membership is rollback authority. Commit retires that publication and its ancestors;
// reset retires all of them, while overlapping failures unwind newest first.
const pendingConfigRuntimeEnvPublications: PendingConfigRuntimeEnvPublication[] = [];

export function getPublishedConfigRuntimeEnvState(): PublishedConfigRuntimeEnvState {
  return publishedConfigRuntimeEnvState;
}

export function collectConfigRuntimeEnvOwnership(
  sourceConfig: OpenClawConfig,
  before: Readonly<Record<string, string | undefined>>,
  after: Readonly<Record<string, string | undefined>>,
  options: { replacedLowerPrecedenceKeys?: readonly string[] } = {},
): Record<string, string> {
  const ownedEnv: Record<string, string> = {};
  // Equal bytes cannot reveal that config replaced a lower-precedence layer.
  // Carry the apply-time replacement signal so later reloads can remove that owned value.
  const replacedLowerPrecedenceKeys = new Set(
    (options.replacedLowerPrecedenceKeys ?? []).map(envSnapshotKey),
  );
  for (const [key, value] of Object.entries(collectConfigRuntimeEnvVars(sourceConfig))) {
    for (const normalizedKey of resolveEnvNormalizationKeys(key)) {
      const afterKey = findCaseInsensitiveEnvKey(after, normalizedKey);
      if (!afterKey || after[afterKey] !== value) {
        continue;
      }
      const beforeKey = findCaseInsensitiveEnvKey(before, normalizedKey);
      if (
        beforeKey &&
        before[beforeKey] === value &&
        !replacedLowerPrecedenceKeys.has(envSnapshotKey(afterKey))
      ) {
        continue;
      }
      ownedEnv[afterKey] = value;
    }
  }
  return ownedEnv;
}

function filterConfigRuntimeEnvOwnership(
  sourceConfig: OpenClawConfig,
  env: NodeJS.ProcessEnv,
  ownedEnv: Readonly<Record<string, string>>,
): Record<string, string> {
  const allowedValues = indexConfigRuntimeEnvValues(collectConfigRuntimeEnvVars(sourceConfig));
  const filtered: Record<string, string> = {};
  for (const [key, value] of Object.entries(ownedEnv)) {
    const normalizedKey = resolveEnvNormalizationKeys(key)[0] ?? key;
    const actualKey = findCaseInsensitiveEnvKey(env, key);
    if (actualKey && env[actualKey] === value && allowedValues.get(normalizedKey)?.has(value)) {
      filtered[actualKey] = value;
    }
  }
  return filtered;
}

export function initializePublishedConfigRuntimeEnv(
  sourceConfig: OpenClawConfig,
  options: {
    ownedEnv?: Readonly<Record<string, string>>;
    preserveExistingOwnership?: boolean;
  } = {},
): void {
  const ownedEnv = filterConfigRuntimeEnvOwnership(
    sourceConfig,
    process.env,
    options.preserveExistingOwnership
      ? { ...publishedConfigRuntimeEnvState.ownedEnv, ...options.ownedEnv }
      : (options.ownedEnv ?? {}),
  );
  publishedConfigRuntimeEnvState = {
    generation: publishedConfigRuntimeEnvState.generation + 1,
    ownedEnv,
    sourceConfig,
  };
  pendingConfigRuntimeEnvPublications.length = 0;
}

export function resetPublishedConfigRuntimeEnv(
  options: { preserveOwnership?: boolean } = {},
): void {
  if (!options.preserveOwnership) {
    appliedConfigEnvOwnership.delete(process.env);
  }
  publishedConfigRuntimeEnvState = options.preserveOwnership
    ? {
        ...publishedConfigRuntimeEnvState,
        generation: publishedConfigRuntimeEnvState.generation + 1,
      }
    : { generation: 0, ownedEnv: {}, sourceConfig: null };
  pendingConfigRuntimeEnvPublications.length = 0;
}

export function createConfigRuntimeEnvBase(
  activeConfig: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
  options: {
    ownedEnv?: Readonly<Record<string, string>>;
    preservedKeys?: ReadonlySet<string>;
  } = {},
): NodeJS.ProcessEnv {
  const isolated = cloneEnvWithPlatformSemantics(env);
  const ownedEnv = filterConfigRuntimeEnvOwnership(
    activeConfig,
    env,
    options.ownedEnv ?? resolveAppliedConfigEnvOwnership(env),
  );
  for (const [key, ownedValue] of Object.entries(ownedEnv)) {
    if (options.preservedKeys?.has(key.toUpperCase())) {
      continue;
    }
    if (isolated[key] === ownedValue) {
      delete isolated[key];
    }
  }
  return isolated;
}

export function prepareConfigRuntimeEnv(params: {
  previousConfig: OpenClawConfig;
  nextConfig: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  previousOwnedEnv?: Readonly<Record<string, string>>;
}): PreparedConfigRuntimeEnv {
  const targetEnv = params.env ?? process.env;
  const before = snapshotEnvByPlatformKey(targetEnv);
  const preparedEnv = createConfigRuntimeEnvBase(
    params.previousConfig,
    targetEnv,
    params.previousOwnedEnv ? { ownedEnv: params.previousOwnedEnv } : {},
  );
  const base = { ...preparedEnv } as Record<string, string | undefined>;
  applyConfigEnvVars(params.nextConfig, preparedEnv);
  const preparedOwnedEnv = collectConfigRuntimeEnvOwnership(params.nextConfig, base, preparedEnv);

  return prepareConfigRuntimeEnvPublication({
    targetEnv,
    before,
    preparedEnv,
    configState: { sourceConfig: params.nextConfig, ownedEnv: preparedOwnedEnv },
  });
}

export type PreparedConfigRuntimeEnvLoad = {
  env: NodeJS.ProcessEnv;
  captureDotEnvBaseline: () => void;
  prepare: (nextConfig: OpenClawConfig) => PreparedConfigRuntimeEnv;
  prepareFailure: () => PreparedConfigRuntimeEnv;
};

export function prepareConfigRuntimeEnvLoad(params: {
  previousConfig: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  previousOwnedEnv?: Readonly<Record<string, string>>;
  preservedKeys?: ReadonlySet<string>;
}): PreparedConfigRuntimeEnvLoad {
  const targetEnv = params.env ?? process.env;
  const originalEnv = cloneEnvWithPlatformSemantics(targetEnv);
  const before = snapshotEnvByPlatformKey(originalEnv);
  const env = createConfigRuntimeEnvBase(params.previousConfig, targetEnv, {
    ownedEnv: params.previousOwnedEnv,
    preservedKeys: params.preservedKeys,
  });
  const initialBase = snapshotEnvByPlatformKey(env);
  const retainedOwnedEnv = Object.fromEntries(
    Object.entries(params.previousOwnedEnv ?? resolveAppliedConfigEnvOwnership(targetEnv)).filter(
      ([key, value]) => initialBase.get(envSnapshotKey(key))?.value === value,
    ),
  );
  let dotenvBaseline = cloneEnvWithPlatformSemantics(env);

  return {
    env,
    captureDotEnvBaseline: () => {
      // Capture in the dotenv caller's finally, before any config or shell effects.
      dotenvBaseline = cloneEnvWithPlatformSemantics(env);
    },
    prepare: (nextConfig) => {
      const preparedEnv = cloneEnvWithPlatformSemantics(env);
      return prepareConfigRuntimeEnvPublication({
        targetEnv,
        before,
        preparedEnv,
        configState: {
          sourceConfig: nextConfig,
          ownedEnv: {
            ...filterConfigRuntimeEnvOwnership(nextConfig, preparedEnv, retainedOwnedEnv),
            ...collectConfigRuntimeEnvOwnership(nextConfig, dotenvBaseline, preparedEnv),
          },
        },
      });
    },
    prepareFailure: () => {
      const preparedEnv = cloneEnvWithPlatformSemantics(originalEnv);
      const dotenv = snapshotEnvByPlatformKey(dotenvBaseline);
      for (const key of new Set([...initialBase.keys(), ...dotenv.keys()])) {
        const original = before.get(key);
        const base = initialBase.get(key);
        const loaded = dotenv.get(key);
        // Failure preserves the original config-owned layer, including values
        // stripped from the isolated base before dotenv was loaded.
        if (envSnapshotEntriesEqual(original, base) && !envSnapshotEntriesEqual(base, loaded)) {
          replaceEnvSnapshotEntry(preparedEnv, original, loaded);
        }
      }
      return prepareConfigRuntimeEnvPublication({
        targetEnv,
        before,
        preparedEnv,
      });
    },
  };
}

function prepareConfigRuntimeEnvPublication(params: {
  targetEnv: NodeJS.ProcessEnv;
  before: ReadonlyMap<string, EnvSnapshotEntry>;
  preparedEnv: NodeJS.ProcessEnv;
  /** Omitted for ambient dotenv publication after a failed strict load. */
  configState?: {
    sourceConfig: OpenClawConfig;
    ownedEnv: Readonly<Record<string, string>>;
  };
}): PreparedConfigRuntimeEnv {
  const { targetEnv, before, preparedEnv } = params;
  const afterByPlatformKey = snapshotEnvByPlatformKey(preparedEnv);

  return {
    env: preparedEnv,
    publish: () => {
      const processPublication = targetEnv === process.env;
      const previousPublishedState = publishedConfigRuntimeEnvState;
      const previousOwnedEnv = resolveAppliedConfigEnvOwnership(targetEnv);
      const previousPublication = processPublication
        ? pendingConfigRuntimeEnvPublications.at(-1)
        : undefined;
      const published = new Map<string, PublishedConfigRuntimeEnvChange>();
      const keys = new Set([
        ...before.keys(),
        ...afterByPlatformKey.keys(),
        ...(previousPublication?.changes.keys() ?? []),
      ]);
      let current: ReadonlyMap<string, EnvSnapshotEntry> | undefined;
      for (const key of keys) {
        const beforeEntry = before.get(key);
        const afterEntry = afterByPlatformKey.get(key);
        const currentEntry = (current ??= snapshotEnvByPlatformKey(targetEnv)).get(key);
        const previousChange = previousPublication?.changes.get(key);
        const continuesPreviousPublication =
          previousChange !== undefined &&
          envSnapshotEntriesEqual(currentEntry, previousChange.after) &&
          envSnapshotEntriesEqual(beforeEntry, previousChange.preparedBefore);
        const appliesToPreparedSnapshot =
          !envSnapshotEntriesEqual(beforeEntry, afterEntry) &&
          envSnapshotEntriesEqual(currentEntry, beforeEntry);
        if (!continuesPreviousPublication && !appliesToPreparedSnapshot) {
          continue;
        }
        published.set(key, {
          before: currentEntry,
          after: afterEntry,
          preparedBefore: beforeEntry,
        });
        if (!envSnapshotEntriesEqual(currentEntry, afterEntry)) {
          replaceEnvSnapshotEntry(targetEnv, currentEntry, afterEntry);
        }
      }
      const generation = processPublication ? publishedConfigRuntimeEnvState.generation + 1 : null;
      let processPublicationState: PendingConfigRuntimeEnvPublication | null = null;
      if (generation !== null) {
        const ownedEnv: Record<string, string> = {};
        let owned: ReadonlyMap<string, EnvSnapshotEntry> | undefined;
        for (const [key, value] of Object.entries(params.configState?.ownedEnv ?? {})) {
          const platformKey = envSnapshotKey(key);
          const currentEntry = (owned ??= snapshotEnvByPlatformKey(targetEnv)).get(platformKey);
          const preparedEntry = afterByPlatformKey.get(platformKey);
          const previousOwnedKey = findCaseInsensitiveEnvKey(previousOwnedEnv, key);
          if (
            currentEntry?.value === value &&
            envSnapshotEntriesEqual(currentEntry, preparedEntry) &&
            (published.has(platformKey) ||
              (previousOwnedKey !== undefined && previousOwnedEnv[previousOwnedKey] === value))
          ) {
            ownedEnv[currentEntry.key] = value;
          }
        }
        publishedConfigRuntimeEnvState = {
          generation,
          ownedEnv: params.configState ? ownedEnv : previousPublishedState.ownedEnv,
          sourceConfig: params.configState?.sourceConfig ?? previousPublishedState.sourceConfig,
        };
        processPublicationState = {
          previousState: previousPublishedState,
          changes: published,
          rollbackRequested: false,
        };
        pendingConfigRuntimeEnvPublications.push(processPublicationState);
      }
      let active = true;
      const settle = (commit: boolean) => {
        if (!active) {
          return;
        }
        active = false;
        if (!processPublicationState) {
          if (!commit) {
            rollbackConfigRuntimeEnvChanges(targetEnv, published);
          }
          return;
        }
        const index = pendingConfigRuntimeEnvPublications.indexOf(processPublicationState);
        if (index === -1) {
          return;
        }
        if (commit) {
          pendingConfigRuntimeEnvPublications.splice(0, index + 1);
          return;
        }
        processPublicationState.rollbackRequested = true;
        for (
          let publication = pendingConfigRuntimeEnvPublications.at(-1);
          publication?.rollbackRequested;
          publication = pendingConfigRuntimeEnvPublications.at(-1)
        ) {
          pendingConfigRuntimeEnvPublications.pop();
          rollbackConfigRuntimeEnvChanges(process.env, publication.changes);
          publishedConfigRuntimeEnvState = {
            ...publication.previousState,
            generation: publishedConfigRuntimeEnvState.generation + 1,
          };
        }
      };
      return Object.assign(() => settle(false), { commit: () => settle(true) });
    },
  };
}

/** Applies config env vars to an environment without overwriting existing non-empty values. */
export function applyConfigEnvVars(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
  options: {
    lowerPrecedenceEnv?: Readonly<Record<string, string>>;
    onLowerPrecedenceKeysReplaced?: (keys: readonly string[]) => void;
  } = {},
): void {
  const before = { ...env };
  const previousOwnedEnv = resolveAppliedConfigEnvOwnership(env);
  const entries = collectConfigRuntimeEnvVars(cfg);
  const lowerPrecedenceEntries = Object.entries(options.lowerPrecedenceEnv ?? {});
  const lowerPrecedenceEnv = new Map(
    lowerPrecedenceEntries.map(([key, value]) => [envSnapshotKey(key), value]),
  );
  const configEnvKeys = expandEnvNormalizationKeys(Object.keys(entries));
  const configValuesByKey = indexConfigRuntimeEnvValues(entries);
  const higherPrecedenceValues = new Map<string, string>();
  for (const key of Object.keys(entries)) {
    const normalizedKeys = resolveEnvNormalizationKeys(key);
    const winningValue = normalizedKeys
      .map((normalizedKey) => [normalizedKey, env[normalizedKey]] as const)
      .find(
        ([normalizedKey, currentValue]) =>
          currentValue?.trim() &&
          lowerPrecedenceEnv.get(normalizedKey) !== currentValue &&
          !configValuesByKey.get(normalizedKey)?.has(currentValue),
      )?.[1];
    if (winningValue !== undefined) {
      for (const normalizedKey of normalizedKeys) {
        higherPrecedenceValues.set(normalizedKey, winningValue);
      }
    }
  }
  const replacedLowerPrecedenceKeys: string[] = [];
  for (const [key, value] of lowerPrecedenceEntries) {
    if (configEnvKeys.has(envSnapshotKey(key)) && env[key] === value) {
      delete env[key];
      replacedLowerPrecedenceKeys.push(key);
    }
  }
  if (replacedLowerPrecedenceKeys.length > 0) {
    options.onLowerPrecedenceKeysReplaced?.(replacedLowerPrecedenceKeys);
  }
  for (const [key, value] of Object.entries(entries)) {
    const higherPrecedenceValue = higherPrecedenceValues.get(envSnapshotKey(key));
    if (higherPrecedenceValue !== undefined) {
      env[key] = higherPrecedenceValue;
      continue;
    }
    const currentValue = env[key];
    if (currentValue?.trim() && lowerPrecedenceEnv.get(envSnapshotKey(key)) !== currentValue) {
      continue;
    }
    env[key] = value;
  }
  normalizeZaiEnv(env);
  appliedConfigEnvOwnership.set(env, {
    ...filterConfigRuntimeEnvOwnership(cfg, env, previousOwnedEnv),
    ...collectConfigRuntimeEnvOwnership(cfg, before, env, { replacedLowerPrecedenceKeys }),
  });
}
