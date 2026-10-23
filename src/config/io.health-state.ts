import { formatErrorMessage } from "../infra/errors.js";
import { OpenClawStateOwnershipError } from "../infra/sqlite-lifecycle-errors.js";
import { deferSqlitePostCommitPublication } from "../infra/sqlite-post-commit.js";
import { findStartupMaintenanceRequiredError } from "../infra/startup-maintenance-required.js";
import {
  executeExistingOpenClawStateRead,
  getActiveOpenClawStateDatabaseReadSnapshotAsync,
  withExistingOpenClawStateDatabaseReadOnly,
} from "../state/openclaw-state-db-readonly.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";
import {
  prepareConfigHealthPatch,
  readConfigHealthReceipt,
  readConfigHealthStateInDatabase,
  writeConfigHealthPatchInDatabase,
} from "./io.health-state.kernel.js";
import type {
  ConfigHealthEntryChanges,
  ConfigHealthState,
  ConfigHealthSnapshot,
  ConfigHealthUpdateResult,
} from "./io.health-state.types.js";
import { setBoundedConfigIoWarningEntry } from "./io.state.js";

// Fresh config snapshots share a database; retain failures until a write recovers.
const loggedHealthWriteFailures = new Map<string, string>();
const healthSnapshots = new WeakMap<
  OpenClawStateWorkerContext["admission"],
  Map<
    OpenClawStateWorkerContext["databaseEngineSelection"],
    { receipt: object; snapshot: ConfigHealthSnapshot }
  >
>();

type ConfigHealthStateDeps = {
  env: NodeJS.ProcessEnv;
  homedir: () => string;
  logger: Pick<typeof console, "warn">;
};

function resolveConfigHealthStateEnv(deps: ConfigHealthStateDeps): NodeJS.ProcessEnv {
  if (deps.env.OPENCLAW_HOME || deps.env.HOME || deps.env.USERPROFILE || deps.env.PREFIX) {
    return deps.env;
  }
  return { ...deps.env, HOME: deps.homedir() };
}

function handleHealthReadFailure(error: unknown): ConfigHealthState {
  if (error instanceof OpenClawStateOwnershipError) {
    throw error;
  }
  return {};
}

function handleHealthWriteFailure(
  deps: ConfigHealthStateDeps,
  databasePath: string,
  error: unknown,
): void {
  if (error instanceof OpenClawStateOwnershipError || findStartupMaintenanceRequiredError(error)) {
    throw error;
  }
  const message = formatErrorMessage(error);
  const repeated = loggedHealthWriteFailures.get(databasePath) === message;
  setBoundedConfigIoWarningEntry(loggedHealthWriteFailures, databasePath, message);
  if (!repeated) {
    deps.logger.warn(`Config health-state write failed: ${message}`);
  }
}

export function readConfigHealthStateFromStore(deps: ConfigHealthStateDeps): ConfigHealthState {
  try {
    return (
      withExistingOpenClawStateDatabaseReadOnly(({ db }) => readConfigHealthStateInDatabase(db), {
        env: resolveConfigHealthStateEnv(deps),
      }) ?? {}
    );
  } catch (error) {
    return handleHealthReadFailure(error);
  }
}

export function patchConfigHealthEntryToStore(
  deps: ConfigHealthStateDeps,
  configPath: string,
  changes: ConfigHealthEntryChanges,
): void {
  const env = resolveConfigHealthStateEnv(deps);
  const databasePath = resolveOpenClawStateSqlitePath(env);
  try {
    const patch = prepareConfigHealthPatch(changes);
    if (Object.keys(patch).length === 0) {
      return;
    }
    const updatedAtMs = Date.now();
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        writeConfigHealthPatchInDatabase(db, configPath, patch, updatedAtMs);
        const publish = () => {
          loggedHealthWriteFailures.delete(databasePath);
        };
        if (!deferSqlitePostCommitPublication(db, publish)) {
          publish();
        }
      },
      { env, path: databasePath },
    );
  } catch (error) {
    handleHealthWriteFailure(deps, databasePath, error);
  }
}

type ConfigHealthStateStore = {
  assertCurrent: () => void;
  read(): Promise<ConfigHealthSnapshot>;
  update(
    changes: ConfigHealthEntryChanges,
    previous: ConfigHealthSnapshot,
  ): Promise<ConfigHealthUpdateResult>;
  updateAfterFileCommit(
    changes: ConfigHealthEntryChanges,
    previous: ConfigHealthSnapshot,
  ): Promise<ConfigHealthUpdateResult>;
};

/** Bind one asynchronous observation/recovery to its original shared-state owner. */
export function captureConfigHealthStateStore(
  deps: ConfigHealthStateDeps,
  configPath: string,
  assertAdmissionCurrent?: () => void,
): ConfigHealthStateStore {
  const env = resolveConfigHealthStateEnv(deps);
  const databasePath = resolveOpenClawStateSqlitePath(env);
  let captured:
    | { context: ReturnType<typeof captureOpenClawStateWorkerContext> }
    | { error: unknown };
  try {
    captured = { context: captureOpenClawStateWorkerContext({ path: databasePath, env }) };
  } catch (error) {
    // Capture is eager, but failures retain the health owner's read/write policy.
    captured = { error };
  }
  assertAdmissionCurrent?.();
  const assertCurrent = () => {
    assertAdmissionCurrent?.();
    if ("context" in captured) {
      captured.context.admission.assertCurrent();
    }
  };
  const store: ConfigHealthStateStore = {
    assertCurrent,
    async read(): Promise<ConfigHealthSnapshot> {
      try {
        if ("error" in captured) {
          throw captured.error;
        }
        assertCurrent();
        const context = captured.context;
        const options = { path: databasePath, env: context.environment };
        const receipt =
          !context.maintenanceScope &&
          !context.existingSchemaPath &&
          !(await getActiveOpenClawStateDatabaseReadSnapshotAsync(options))
            ? readConfigHealthReceipt(databasePath)
            : undefined;
        const snapshots = healthSnapshots.get(context.admission) ?? new Map();
        const cached = snapshots.get(context.databaseEngineSelection);
        if (receipt && cached?.receipt === receipt) {
          return cached.snapshot;
        }
        const reply = await executeExistingOpenClawStateRead(
          options,
          { type: "config.health.read", input: undefined },
          { context: captured.context },
        );
        assertCurrent();
        const snapshot = reply?.snapshot ?? { state: {}, basis: {} };
        if (receipt) {
          // A concurrent committed write replaces the receipt, retiring this observation.
          snapshots.set(context.databaseEngineSelection, { receipt, snapshot });
          healthSnapshots.set(context.admission, snapshots);
        }
        return snapshot;
      } catch (error) {
        assertCurrent();
        const state = handleHealthReadFailure(error);
        return { state, basis: null };
      }
    },
    async update(changes, previous): Promise<ConfigHealthUpdateResult> {
      try {
        const patch = prepareConfigHealthPatch(changes);
        if (Object.keys(patch).length === 0) {
          return { status: "applied" };
        }
        if ("error" in captured) {
          throw captured.error;
        }
        const prior = previous.basis?.[configPath];
        const expected = previous.basis === null ? undefined : (prior ?? null);
        const updatedAtMs = Date.now();
        const applied = await runOpenClawStateWorkerOperation(
          captured.context,
          (scope) =>
            scope.execute({
              type: "config.health.patch",
              input: { configPath, patch, expected, updatedAtMs },
            }),
          { assertCurrent },
        );
        if (applied) {
          loggedHealthWriteFailures.delete(databasePath);
          return { status: "applied" };
        }
        // A failed read supplies no comparison basis, not evidence of a CAS miss.
        return { status: expected === undefined ? "unavailable" : "conflict" };
      } catch (error) {
        if (
          error instanceof OpenClawStateOwnershipError ||
          findStartupMaintenanceRequiredError(error)
        ) {
          throw error;
        }
        assertCurrent();
        handleHealthWriteFailure(deps, databasePath, error);
        return { status: "unavailable" };
      }
    },
    async updateAfterFileCommit(changes, previous): Promise<ConfigHealthUpdateResult> {
      try {
        return await store.update(changes, previous);
      } catch (error) {
        // Ownership and maintenance refusals still propagate after the file commits.
        handleHealthWriteFailure(deps, databasePath, error);
        return { status: "unavailable" };
      }
    },
  };
  return store;
}
