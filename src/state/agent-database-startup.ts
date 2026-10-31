import { AsyncLocalStorage } from "node:async_hooks";
import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { sleepWithAbort } from "../infra/backoff.js";
import { formatErrorMessage } from "../infra/errors.js";
import { retryAsync } from "../infra/retry.js";
import {
  getOrLoadSqliteDatabaseAdmissionForPath,
  prepareSqliteDatabaseAdmission,
} from "../infra/sqlite-database-admission.js";
import { isSqliteLockError } from "../infra/sqlite-error-diagnostics.js";
import { readSqliteIntegrityFileIdentity } from "../infra/sqlite-file-generation.js";
import { withSqliteReadOnlyWorkerScope } from "../infra/sqlite-readonly-worker.js";
import { schemaAdmission } from "../infra/sqlite-schema-admission.js";
import { isSqliteWorkerError } from "../infra/sqlite-worker-contract.js";
import { WorkerTaskError } from "../infra/worker-task-pool.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { createDeferredCore } from "../shared/deferred.js";
import { runInDetachedAsyncContext } from "../shared/detached-async-context.js";
import { createPermitPool } from "../shared/permit-pool.js";
import { AgentDatabaseSchemaAdmissionChangedError } from "./agent-database-admission-error.js";
import {
  createAgentDatabaseInspectionRefusal,
  failPendingAgentDatabase,
  listAgentDatabaseAdmissionRefusals,
  preparePendingAgentDatabase,
  preparePendingAgentDatabaseRead,
  publishPendingAgentDatabaseReadAdmission,
  readAgentDatabaseAdmissionRefusal,
  type AgentDatabaseAdmissionRefusal,
} from "./agent-database-admission.js";
import { withAgentDatabasePreparationContext } from "./agent-database-preparation-context.js";
import { prepareAgentDatabaseStartupVerification } from "./agent-database-startup-integrity.js";
import {
  createAgentDatabaseStartupObservation,
  recoveryTiming,
} from "./agent-database-startup-observation.js";
import type {
  PreparedSchemaHeader,
  PreparedSchemaHeaders,
  PendingAgentDatabaseInspection as PendingInspection,
  AgentDatabaseStartupActivation as Activation,
  AgentDatabaseStartupPreparationPhase as PreparationPhase,
  PendingAgentDatabaseRecovery as PendingRecovery,
} from "./agent-database-startup.types.js";
import { readAgentDeletionJournalStatusInWorker } from "./agent-deletion-journal.read.js";
import {
  AGENT_DATABASE_PREFLIGHT_CONCURRENCY,
  AGENT_DATABASE_PREPARATION_CONCURRENCY,
  OPENCLAW_AGENT_SCHEMA_VERSION,
} from "./openclaw-agent-db-contract.js";
import {
  createOpenClawAgentDatabasePathMatcher,
  isSameOpenClawAgentDatabasePath,
} from "./openclaw-agent-db.paths.js";
import type { OpenClawDatabaseSchemaPreflight } from "./openclaw-database-preflight.types.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";

const PREPARATION_PROGRESS_INTERVAL_MS = 60_000;
const STARTUP_PUBLICATION_ATTEMPTS = 4;

function matchesInspectionPath(
  paths: readonly string[],
  target: string,
  samePath = isSameOpenClawAgentDatabasePath,
): boolean {
  return paths.some((pathname) => {
    try {
      return samePath(pathname, target);
    } catch {
      // An uncertain sibling cannot classify this target; its own inspection reports the failure.
      return false;
    }
  });
}

const log = createSubsystemLogger("state/agent-admission");
const startupAdmission = new AsyncLocalStorage<AgentDatabaseStartupAdmission>();

export class AgentDatabaseStartupSupersededError extends Error {
  constructor(agentId: string, subject: "startup" | "secrets") {
    super(`Agent ${agentId} ${subject} preparation was superseded`);
    this.name = "AgentDatabaseStartupSupersededError";
  }
}

/** Startup owns readers until the Gateway adopts them; only the Gateway activates agents. */
class AgentDatabaseStartupAdmission {
  constructor(private readonly deferInspections = true) {}

  private readonly controller = new AbortController();
  private readonly activation = createDeferredCore<Activation | undefined>();
  private readonly work = new Set<Promise<unknown>>();
  private readonly pending = new Map<string, PendingRecovery>();
  readonly observation = createAgentDatabaseStartupObservation(this.pending, this.signal);
  private adopted = false;
  private activated = false;
  private stopped = false;
  private stopping?: Promise<void>;
  private publication: Promise<void> = Promise.resolve();
  private publishingAgentId?: string;
  private progressTimer?: ReturnType<typeof setInterval>;
  private readonly opening = createPermitPool(AGENT_DATABASE_PREFLIGHT_CONCURRENCY);
  private readonly migrating = createPermitPool(AGENT_DATABASE_PREPARATION_CONCURRENCY);
  private readonly verifying = createPermitPool(2);
  // Readiness releases the whole fleet; leave room for other shared-state readers.
  private readonly journalReads = createPermitPool(8);
  private preparedSchemaHeaders?: PreparedSchemaHeaders;

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  private startProgress(): void {
    this.progressTimer ??= setInterval(() => {
      const now = performance.now();
      for (const [agentId, recovery] of this.pending) {
        log.warn("agent database startup preparation still running", {
          agentId,
          phase: recovery.phase,
          elapsedMs: Math.round(now - recovery.startedAt),
          phaseElapsedMs: Math.round(now - recovery.phaseStartedAt),
          ...(recovery.phase === "publication-wait"
            ? { publishingAgentId: this.publishingAgentId }
            : {}),
        });
      }
    }, PREPARATION_PROGRESS_INTERVAL_MS);
    this.progressTimer.unref();
  }

  private clearProgress(): void {
    clearInterval(this.progressTimer);
    this.progressTimer = undefined;
  }

  /** Bootstrap reuses this startup's compatibility headers; writable opens retain admission. */
  prepareSchemaHeaders(env: NodeJS.ProcessEnv) {
    const prepared: PreparedSchemaHeaders = {
      statePath: resolveOpenClawStateSqlitePath(env),
      headers: new Map(),
    };
    this.preparedSchemaHeaders = prepared;
    return (pathname: string) => {
      return ({ version, writerAppVersion, agentSchemaMeta }: PreparedSchemaHeader) => {
        if (
          !this.stopped &&
          this.preparedSchemaHeaders === prepared &&
          version === OPENCLAW_AGENT_SCHEMA_VERSION
        ) {
          prepared.headers.set(pathname, { version, writerAppVersion, agentSchemaMeta });
        }
      };
    };
  }

  takePreparedSchemaHeaders(env: NodeJS.ProcessEnv) {
    const prepared = this.preparedSchemaHeaders;
    this.preparedSchemaHeaders = undefined;
    return (pathname: string, supportedVersion: number) => {
      const header = prepared?.headers.get(pathname);
      return !this.stopped &&
        prepared?.statePath === resolveOpenClawStateSqlitePath(env) &&
        header?.version === supportedVersion
        ? header
        : undefined;
    };
  }

  recordStateSchemaPreparation(env: NodeJS.ProcessEnv): void {
    const prepared = this.preparedSchemaHeaders;
    if (this.stopped || prepared?.statePath !== resolveOpenClawStateSqlitePath(env)) {
      return;
    }
    const schema = getOrLoadSqliteDatabaseAdmissionForPath(
      prepared.statePath,
      schemaAdmission,
      () => undefined,
    );
    const identity = prepareSqliteDatabaseAdmission(prepared.statePath);
    if (schema && identity) {
      prepared.state = { identity, schemaAdmissionId: schema.admissionId };
    }
  }

  takePreparedStateSchema(env: NodeJS.ProcessEnv): (() => void) | undefined {
    const prepared = this.preparedSchemaHeaders;
    const state = prepared?.state;
    if (!prepared || !state || prepared.statePath !== resolveOpenClawStateSqlitePath(env)) {
      return undefined;
    }
    const assertCurrent = () => {
      const schema = getOrLoadSqliteDatabaseAdmissionForPath(
        prepared.statePath,
        schemaAdmission,
        () => undefined,
      );
      if (
        this.stopped ||
        prepareSqliteDatabaseAdmission(prepared.statePath) !== state.identity ||
        schema?.admissionId !== state.schemaAdmissionId
      ) {
        throw new Error("Prepared startup state schema changed before source inspection");
      }
    };
    try {
      assertCurrent();
      return assertCurrent;
    } catch {
      return undefined;
    }
  }

  /** Joins startup work already scheduled before a background consumer begins. */
  get pendingPreparation(): Promise<unknown> | undefined {
    return this.work.size > 0 ? Promise.allSettled(this.work) : undefined;
  }

  get hasPendingAgents(): boolean {
    return this.pending.size > 0;
  }

  readonly waitForAgentPreparation = this.observation.waitForAgentPreparation.bind(
    this.observation,
  );

  track(work: Promise<unknown>): void {
    this.work.add(work);
    void work.then(
      () => this.work.delete(work),
      () => this.work.delete(work),
    );
  }

  scheduling(
    env: NodeJS.ProcessEnv,
    runtimePaths: readonly string[],
    runtimeAgentIds: ReadonlySet<string>,
  ) {
    const samePath = createOpenClawAgentDatabasePathMatcher();
    return {
      signal: this.signal,
      canDefer: (target: PendingInspection["target"]) =>
        this.deferInspections &&
        target.agentId !== undefined &&
        runtimeAgentIds.has(target.agentId) &&
        matchesInspectionPath(runtimePaths, target.path, samePath),
      track: (work: Promise<unknown>) => this.track(work),
      defer: (inspections: PendingInspection[], reason: string) =>
        this.defer({ env, inspections, reason }),
    };
  }

  recordInspectionFailure(
    target: PendingInspection["target"],
    inspection: OpenClawDatabaseSchemaPreflight,
    error: unknown,
  ): boolean {
    this.signal.throwIfAborted();
    if (!target.agentId) {
      return false;
    }
    (inspection.agentRefusals ??= []).push(
      createAgentDatabaseInspectionRefusal({
        agentId: target.agentId,
        paths: [target.path],
        reason: formatErrorMessage(error),
        cause: error,
      }),
    );
    return true;
  }

  captureRefusals(env: NodeJS.ProcessEnv): ReadonlyMap<string, AgentDatabaseAdmissionRefusal> {
    return new Map(
      listAgentDatabaseAdmissionRefusals({ env })
        .filter((refusal) => this.pending.get(refusal.agentId)?.refusal === refusal)
        .map((refusal) => [refusal.agentId, refusal]),
    );
  }

  reuseRefusal(
    target: PendingInspection["target"],
    inspection: OpenClawDatabaseSchemaPreflight,
    priorRefusals?: ReadonlyMap<string, AgentDatabaseAdmissionRefusal>,
  ): boolean {
    const refusal = target.agentId && priorRefusals?.get(target.agentId);
    if (!refusal || !matchesInspectionPath(refusal.paths, target.path)) {
      return false;
    }
    (inspection.agentRefusals ??= []).push(refusal);
    return true;
  }

  defer(params: {
    env: NodeJS.ProcessEnv;
    inspections: readonly PendingInspection[];
    reason: string;
  }): AgentDatabaseAdmissionRefusal[] {
    this.signal.throwIfAborted();
    const env = cloneEnvWithPlatformSemantics(params.env);
    const grouped = new Map<string, PendingInspection[]>();
    for (const inspection of params.inspections) {
      const agentId = inspection.target.agentId;
      if (!agentId) {
        throw new Error(
          `Cannot defer a database without an agent owner: ${inspection.target.path}`,
        );
      }
      grouped.set(agentId, [...(grouped.get(agentId) ?? []), inspection]);
    }
    const refusals: AgentDatabaseAdmissionRefusal[] = [];
    for (const [agentId, inspections] of grouped) {
      const paths = [...new Set(inspections.map(({ target }) => target.path))];
      const refusal = createAgentDatabaseInspectionRefusal({
        agentId,
        paths,
        pending: true,
        reason: `Agent ${agentId} has not completed startup inspection and preparation. ${params.reason}`,
      });
      const startedAt = performance.now();
      const completion = createDeferredCore();
      const readReady = createDeferredCore();
      const inputReady = createDeferredCore();
      const recovery: PendingRecovery = {
        refusal,
        completion: completion.promise,
        readReady: readReady.promise,
        startedAt,
        phase: "inspection",
        phaseStartedAt: startedAt,
        phaseDurationsMs: {},
      };
      const finishInputs = () => {
        inputReady.resolve();
        if (this.pending.get(agentId) === recovery) {
          this.pending.delete(agentId);
        }
        if (this.pending.size === 0) {
          this.clearProgress();
        }
      };
      const phase = (name: PreparationPhase) => {
        const now = performance.now();
        recovery.phaseDurationsMs = recoveryTiming(recovery, now).phaseDurationsMs;
        recovery.phase = name;
        recovery.phaseStartedAt = now;
      };
      this.pending.set(agentId, recovery);
      this.startProgress();
      refusals.push(refusal);
      log.info(refusal.reason, { agentId, paths });
      const witnesses = paths.map((pathname) => {
        try {
          return { pathname, identity: readSqliteIntegrityFileIdentity(pathname) };
        } catch (error) {
          return { pathname, error };
        }
      });
      // Observe failures immediately, but publish their outcome only after startup
      // records the pending decisions and the Gateway accepts their lifetime.
      const checked = Promise.allSettled(inspections.map(({ result }) => result));
      // Gateway-owned recovery outlives the caller's temporary discovery snapshot.
      const work = runInDetachedAsyncContext(async () => {
        const preparation: {
          maintenance?: () => Promise<void>;
          recoverInputs?: () => Promise<void>;
        } = {};
        let revokeReadAdmission: (() => void) | undefined;
        let integrity: ReturnType<typeof prepareAgentDatabaseStartupVerification>;
        let preparedSuccessfully = false;
        try {
          const results = await checked;
          phase("activation");
          const activation = await this.activation.promise;
          if (!activation || this.stopped) {
            return;
          }
          const assertLifetimeCurrent = () => {
            this.signal.throwIfAborted();
            if (!activation.isCurrent() || this.pending.get(agentId) !== recovery) {
              throw new Error(`Gateway no longer owns preparation for agent ${agentId}`);
            }
          };
          const assertCurrent = () => {
            assertLifetimeCurrent();
            for (const witness of witnesses) {
              if (!witness.identity) {
                throw witness.error;
              }
              readSqliteIntegrityFileIdentity(witness.pathname, witness.identity);
            }
          };
          const capacityRetry = {
            attempts: 4,
            minDelayMs: 500,
            maxDelayMs: 8000,
            jitter: 0.2,
            sleep: (ms: number) => sleepWithAbort(ms, this.signal),
          };
          const assertNotDeleted = async () => {
            const deletion = await retryAsync(
              async () => {
                const release = await this.journalReads.acquire({ signal: this.signal });
                try {
                  assertCurrent();
                  return await readAgentDeletionJournalStatusInWorker(
                    agentId,
                    { env },
                    this.signal,
                  );
                } finally {
                  release?.();
                }
              },
              {
                ...capacityRetry,
                // Other producers can still saturate the shared pool after our permit wait.
                shouldRetry: (error) =>
                  error instanceof WorkerTaskError && error.code === "overloaded",
              },
            );
            assertCurrent();
            if (deletion !== "absent") {
              throw new Error(`Agent ${agentId} was deleted during startup inspection`);
            }
          };
          assertCurrent();
          for (const result of results) {
            if (result.status === "rejected") {
              throw result.reason;
            }
            const inspection = result.value;
            if (
              inspection.incompatible.length ||
              inspection.indeterminate.length ||
              inspection.agentRefusals?.length ||
              inspection.pendingMigrations?.length
            ) {
              throw new Error(
                inspection.agentRefusals?.map((entry) => entry.reason).join("; ") ||
                  inspection.indeterminate.map((entry) => entry.reason).join("; ") ||
                  `Agent ${agentId} database requires Doctor before preparation`,
              );
            }
          }
          const canReadBeforeOpen = inspections.every(({ target }, index) => {
            const result = results[index];
            return (
              result?.status === "fulfilled" &&
              matchesInspectionPath(result.value.readReadyAgentPaths ?? [], target.path)
            );
          });
          phase("readiness");
          await racePromiseWithAbortSignal(activation.preparationReady, this.signal);
          assertCurrent();
          if (canReadBeforeOpen) {
            integrity = prepareAgentDatabaseStartupVerification(
              { agentId, paths, env, signal: this.signal },
              activation,
              this.verifying,
            );
          }
          await withSqliteReadOnlyWorkerScope(
            async () => {
              await assertNotDeleted();
              await preparePendingAgentDatabase(refusal, { env, assertCurrent }, async () => {
                await using prepared = new AsyncDisposableStack();
                const input = {
                  agentId,
                  paths,
                  env,
                  signal: this.signal,
                  assertCurrent,
                  phase,
                };
                const publish = async () => {
                  const publicationComplete = createDeferredCore();
                  phase("publication-wait");
                  const previous = this.publication;
                  this.publication = publicationComplete.promise;
                  try {
                    await previous;
                    assertCurrent();
                    this.publishingAgentId = agentId;
                    for (let attempt = 1; ; attempt++) {
                      try {
                        await activation.publishAgent(input);
                        break;
                      } catch (error) {
                        const retryable =
                          error instanceof AgentDatabaseStartupSupersededError ||
                          error instanceof AgentDatabaseSchemaAdmissionChangedError;
                        if (!retryable || attempt >= STARTUP_PUBLICATION_ATTEMPTS) {
                          throw error;
                        }
                        log.warn("agent database startup preparation was superseded; retrying", {
                          agentId,
                          attempt,
                        });
                        await assertNotDeleted();
                      }
                    }
                    phase("publication");
                    await assertNotDeleted();
                  } finally {
                    if (this.publishingAgentId === agentId) {
                      this.publishingAgentId = undefined;
                    }
                    publicationComplete.resolve();
                  }
                };
                if (canReadBeforeOpen && activation.captureReadAdmission) {
                  // Exact existing schemas can serve committed snapshots while full integrity
                  // gates writes. Native readers retain schema, file, and quarantine checks.
                  const assertReadCurrent = activation.captureReadAdmission({
                    ...input,
                    assertCurrent: assertLifetimeCurrent,
                  });
                  assertReadCurrent();
                  await preparePendingAgentDatabaseRead(refusal, { env, assertCurrent }, publish);
                  assertReadCurrent();
                  assertCurrent();
                  revokeReadAdmission = publishPendingAgentDatabaseReadAdmission(refusal, {
                    env,
                    paths: results.flatMap((result) =>
                      result.status === "fulfilled" ? (result.value.readReadyAgentPaths ?? []) : [],
                    ),
                    assertCurrent: assertReadCurrent,
                  });
                  recovery.readReady = undefined;
                  readReady.resolve();
                  log.info("agent database reads ready while writable inspection continues", {
                    agentId,
                    ...recoveryTiming(recovery),
                  });
                  runInDetachedAsyncContext(() =>
                    sessionChanges.emit({ all: true, scope: { agentId, topology: true } }),
                  );
                }
                const retryPreparation = async (
                  run: () => Promise<void>,
                  shouldRetry = isSqliteLockError,
                ) => {
                  let preparationAttempts = 0;
                  await retryAsync(
                    async () => {
                      if (preparationAttempts++ > 0) {
                        await assertNotDeleted();
                      }
                      assertCurrent();
                      await run();
                    },
                    {
                      ...capacityRetry,
                      // Mixed cleanup failures and uncertain outcomes must not replay preparation.
                      shouldRetry,
                      onRetry: ({ attempt, err }) => {
                        const reason = isSqliteLockError(err) ? "locked" : "capacity reached";
                        log.warn(`agent database startup ${reason}; retrying preparation`, {
                          agentId,
                          phase: recovery.phase,
                          attempt,
                        });
                      },
                    },
                  );
                };
                await retryPreparation(
                  async () => {
                    phase("open-wait");
                    const release = await this.opening.acquire({ signal: this.signal });
                    try {
                      assertCurrent();
                      phase("open");
                      const opened = await activation.openAgent(input);
                      if (opened) {
                        prepared.use(opened);
                      }
                    } finally {
                      release?.();
                    }
                  },
                  (error) => isSqliteLockError(error) || isSqliteWorkerError(error, "overloaded"),
                );
                await retryPreparation(async () => {
                  phase("migration-wait");
                  const releaseMigration = await this.migrating.acquire({ signal: this.signal });
                  try {
                    assertCurrent();
                    phase("migration");
                    const migrated = await activation.migrateAgent(input);
                    preparation.maintenance = migrated ? migrated.maintain : undefined;
                    preparation.recoverInputs = migrated ? migrated.recoverInputs : undefined;
                    // Install input readiness before native write admission is published.
                    recovery.inputReady = preparation.recoverInputs
                      ? inputReady.promise
                      : undefined;
                  } finally {
                    releaseMigration?.();
                  }
                });
                if (!revokeReadAdmission) {
                  await publish();
                } else {
                  await assertNotDeleted();
                }
              });
            },
            { signal: this.signal, deadlineOwnedByCaller: true },
          );
          log.info("agent database recovered after background inspection and preparation", {
            agentId,
            paths,
            ...recoveryTiming(recovery),
          });
          preparedSuccessfully = true;
        } catch (error) {
          if (!this.stopped) {
            const reason = formatErrorMessage(error);
            failPendingAgentDatabase(refusal, error, { env });
            log.warn("agent database remains degraded", {
              agentId,
              paths,
              reason,
              repairHint: readAgentDatabaseAdmissionRefusal(agentId, { env })?.repairHint,
              ...recoveryTiming(recovery),
            });
          }
        } finally {
          if (!preparedSuccessfully) {
            integrity?.revoke();
          }
          revokeReadAdmission?.();
          if (this.publishingAgentId === agentId) {
            this.publishingAgentId = undefined;
          }
          readReady.resolve();
          completion.resolve();
          if (
            !preparation.recoverInputs ||
            this.stopped ||
            readAgentDatabaseAdmissionRefusal(agentId, { env })
          ) {
            finishInputs();
          }
        }
        if (preparedSuccessfully && integrity) {
          this.track(runInDetachedAsyncContext(integrity.verify));
        }
        try {
          // Recovery enters ordinary queues after the temporary database borrow has ended.
          // Its failure must not turn an admitted database into an inspection refusal.
          if (!readAgentDatabaseAdmissionRefusal(agentId, { env }) && !this.stopped) {
            if (preparation.recoverInputs) {
              phase("input-recovery");
              await preparation.recoverInputs();
            }
          }
        } catch (error) {
          if (!this.stopped) {
            log.warn("agent restart input recovery failed", {
              agentId,
              reason: formatErrorMessage(error),
            });
          }
        } finally {
          finishInputs();
        }
        // End the admission borrow and publication turn before advisory repair.
        if (!readAgentDatabaseAdmissionRefusal(agentId, { env }) && !this.stopped) {
          try {
            await preparation.maintenance?.();
          } catch (error) {
            if (!this.stopped) {
              log.warn("agent database background maintenance failed", {
                agentId,
                reason: formatErrorMessage(error),
              });
            }
          }
        }
      });
      this.track(work);
    }
    return refusals;
  }

  adopt(): { stop: () => Promise<void> } {
    this.signal.throwIfAborted();
    if (this.adopted) {
      throw new Error("Agent database startup admission already belongs to a Gateway");
    }
    this.adopted = true;
    return { stop: () => this.stop() };
  }

  activate(activation: Activation): void {
    if (!this.adopted || this.stopped || this.activated) {
      return;
    }
    this.activated = true;
    this.activation.resolve(activation);
  }

  async releaseStartup(): Promise<void> {
    if (!this.adopted) {
      await this.stop();
    }
  }

  stop(): Promise<void> {
    return (this.stopping ??= (async () => {
      this.stopped = true;
      this.clearProgress();
      this.preparedSchemaHeaders = undefined;
      this.controller.abort(new Error("Gateway stopped during agent database inspection"));
      this.activation.resolve(undefined);
      while (this.work.size > 0) {
        await Promise.allSettled(this.work);
      }
    })());
  }
}

export function getAgentDatabaseStartupAdmission(): AgentDatabaseStartupAdmission | undefined {
  const scope = startupAdmission.getStore();
  return scope?.isStopped ? undefined : scope;
}

export async function withAgentDatabaseStartupAdmission<T>(
  run: (admission: AgentDatabaseStartupAdmission) => Promise<T>,
  options: { deferInspections?: boolean } = {},
): Promise<T> {
  const admission =
    getAgentDatabaseStartupAdmission() ??
    new AgentDatabaseStartupAdmission(options.deferInspections);
  try {
    return await startupAdmission.run(admission, () =>
      withAgentDatabasePreparationContext(
        () => admission.observation,
        () => run(admission),
      ),
    );
  } finally {
    await admission.releaseStartup();
  }
}
