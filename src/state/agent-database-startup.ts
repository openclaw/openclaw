import { AsyncLocalStorage } from "node:async_hooks";
import { statSync } from "node:fs";
import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  sameFileMutationFingerprint,
  type FileMutationFingerprint,
} from "../infra/file-descriptor.js";
import { readSqliteIntegrityFileIdentity } from "../infra/sqlite-file-generation.js";
import { withSqliteReadOnlyWorkerScope } from "../infra/sqlite-readonly-worker.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { createDeferredCore } from "../shared/deferred.js";
import { runInDetachedAsyncContext } from "../shared/detached-async-context.js";
import { createPermitPool } from "../shared/permit-pool.js";
import {
  createAgentDatabaseInspectionRefusal,
  failPendingAgentDatabase,
  listAgentDatabaseAdmissionRefusals,
  preparePendingAgentDatabase,
  readAgentDatabaseAdmissionRefusal,
  type AgentDatabaseAdmissionRefusal,
} from "./agent-database-admission.js";
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
import type { AgentSchemaInspection } from "./openclaw-agent-schema-inspection.js";
import type { OpenClawDatabaseSchemaPreflight } from "./openclaw-database-preflight.types.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";

type PendingInspection = {
  target: { agentId?: string; path: string };
  result: Promise<OpenClawDatabaseSchemaPreflight>;
};
type PreparationInput = {
  agentId: string;
  paths: readonly string[];
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  assertCurrent: () => void;
  phase: (name: "secrets" | "models") => void;
};
type Activation = {
  isCurrent: () => boolean;
  preparationReady: Promise<void>;
  openAgent: (input: PreparationInput) => Promise<void>;
  migrateAgent: (input: PreparationInput) => Promise<void>;
  publishAgent: (input: PreparationInput) => Promise<void>;
};
type PreparationPhase =
  | "inspection"
  | "activation"
  | "readiness"
  | "open-wait"
  | "open"
  | "migration-wait"
  | "migration"
  | "publication-wait"
  | "secrets"
  | "models"
  | "publication";
type PendingRecovery = {
  refusal: AgentDatabaseAdmissionRefusal;
  completion: Promise<void>;
  startedAt: number;
  phase: PreparationPhase;
  phaseStartedAt: number;
  phaseDurationsMs: Partial<Record<PreparationPhase, number>>;
};

const PREPARATION_PROGRESS_INTERVAL_MS = 60_000;

function recoveryTiming(recovery: PendingRecovery, now = performance.now()) {
  return {
    elapsedMs: Math.round(now - recovery.startedAt),
    phaseDurationsMs: {
      ...recovery.phaseDurationsMs,
      [recovery.phase]: Math.round(
        (recovery.phaseDurationsMs[recovery.phase] ?? 0) + now - recovery.phaseStartedAt,
      ),
    },
  };
}
type SchemaSourceWitness = Array<FileMutationFingerprint | undefined>;
type PreparedSchemaHeader = Pick<
  AgentSchemaInspection,
  "version" | "writerAppVersion" | "agentSchemaMeta"
>;
type PreparedSchemaHeaders = {
  statePath: string;
  headers: Map<string, { inspection: PreparedSchemaHeader; witness: SchemaSourceWitness }>;
};

function readSchemaSourceWitness(pathname: string): SchemaSourceWitness | undefined {
  try {
    const files = ["", "-wal", "-journal"].map((suffix) =>
      statSync(`${pathname}${suffix}`, { bigint: true, throwIfNoEntry: false }),
    );
    return files[0] && files.every((file) => !file || file.isFile()) ? files : undefined;
  } catch {
    return undefined;
  }
}

function matchesSchemaSourceWitness(
  before: SchemaSourceWitness,
  after: SchemaSourceWitness | undefined,
): boolean {
  return Boolean(
    after &&
    before.every((file, index) => {
      const current = after[index];
      return file ? current && sameFileMutationFingerprint(file, current) : !current;
    }),
  );
}

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

/** Startup owns readers until the Gateway adopts them; only the Gateway activates agents. */
class AgentDatabaseStartupAdmission {
  constructor(private readonly deferInspections = true) {}

  private readonly controller = new AbortController();
  private readonly activation = createDeferredCore<Activation | undefined>();
  private readonly work = new Set<Promise<unknown>>();
  private readonly pending = new Map<string, PendingRecovery>();
  private adopted = false;
  private activated = false;
  private stopped = false;
  private stopping?: Promise<void>;
  private publication: Promise<void> = Promise.resolve();
  private publishingAgentId?: string;
  private progressTimer?: ReturnType<typeof setInterval>;
  private readonly opening = createPermitPool(AGENT_DATABASE_PREFLIGHT_CONCURRENCY);
  private readonly migrating = createPermitPool(AGENT_DATABASE_PREPARATION_CONCURRENCY);
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

  /** Full readiness stays fresh; only unchanged compatibility headers cross into bootstrap. */
  prepareSchemaHeaders(env: NodeJS.ProcessEnv) {
    const prepared: PreparedSchemaHeaders = {
      statePath: resolveOpenClawStateSqlitePath(env),
      headers: new Map(),
    };
    this.preparedSchemaHeaders = prepared;
    return (pathname: string) => {
      const before = readSchemaSourceWitness(pathname);
      return ({ version, writerAppVersion, agentSchemaMeta }: PreparedSchemaHeader) => {
        if (
          !this.stopped &&
          this.preparedSchemaHeaders === prepared &&
          before &&
          version === OPENCLAW_AGENT_SCHEMA_VERSION &&
          matchesSchemaSourceWitness(before, readSchemaSourceWitness(pathname))
        ) {
          prepared.headers.set(pathname, {
            inspection: { version, writerAppVersion, agentSchemaMeta },
            witness: before,
          });
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
        header?.inspection.version === supportedVersion &&
        matchesSchemaSourceWitness(header.witness, readSchemaSourceWitness(pathname))
        ? header.inspection
        : undefined;
    };
  }

  /** Joins startup work already scheduled before a background consumer begins. */
  get pendingPreparation(): Promise<unknown> | undefined {
    return this.work.size > 0 ? Promise.allSettled(this.work) : undefined;
  }

  /** Join only the current agent preparation, without holding channel startup or healthy agents. */
  waitForAgentPreparation(
    agentId: string,
    options: { env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {},
  ): Promise<void> | undefined {
    const pending = this.pending.get(normalizeAgentId(agentId));
    if (!pending || readAgentDatabaseAdmissionRefusal(agentId, options) !== pending.refusal) {
      return undefined;
    }
    return racePromiseWithAbortSignal(
      pending.completion,
      options.signal ? AbortSignal.any([this.signal, options.signal]) : this.signal,
    );
  }

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
      const recovery: PendingRecovery = {
        refusal,
        completion: completion.promise,
        startedAt,
        phase: "inspection",
        phaseStartedAt: startedAt,
        phaseDurationsMs: {},
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
      log.warn(refusal.reason, { agentId, paths, repairHint: refusal.repairHint });
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
        const publicationComplete = createDeferredCore();
        try {
          const results = await checked;
          phase("activation");
          const activation = await this.activation.promise;
          if (!activation || this.stopped) {
            return;
          }
          const assertCurrent = () => {
            this.signal.throwIfAborted();
            if (!activation.isCurrent() || this.pending.get(agentId) !== recovery) {
              throw new Error(`Gateway no longer owns preparation for agent ${agentId}`);
            }
            for (const witness of witnesses) {
              if (!witness.identity) {
                throw witness.error;
              }
              readSqliteIntegrityFileIdentity(witness.pathname, witness.identity);
            }
          };
          const assertNotDeleted = async () => {
            assertCurrent();
            const deletion = await readAgentDeletionJournalStatusInWorker(
              agentId,
              { env },
              this.signal,
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
          phase("readiness");
          await racePromiseWithAbortSignal(activation.preparationReady, this.signal);
          assertCurrent();
          await withSqliteReadOnlyWorkerScope(
            async () => {
              await assertNotDeleted();
              await preparePendingAgentDatabase(refusal, { env, assertCurrent }, async () => {
                const input = {
                  agentId,
                  paths,
                  env,
                  signal: this.signal,
                  assertCurrent,
                  phase,
                };
                phase("open-wait");
                const release = await this.opening.acquire({ signal: this.signal });
                try {
                  assertCurrent();
                  phase("open");
                  await activation.openAgent(input);
                } finally {
                  release?.();
                }
                phase("migration-wait");
                const releaseMigration = await this.migrating.acquire({ signal: this.signal });
                try {
                  assertCurrent();
                  phase("migration");
                  await activation.migrateAgent(input);
                } finally {
                  releaseMigration?.();
                }
                // Keep the revision until admission publishes after its final journal check.
                phase("publication-wait");
                const previous = this.publication;
                this.publication = publicationComplete.promise;
                await previous;
                assertCurrent();
                this.publishingAgentId = agentId;
                await activation.publishAgent(input);
                phase("publication");
                await assertNotDeleted();
              });
            },
            { signal: this.signal, deadlineOwnedByCaller: true },
          );
          log.info("agent database recovered after background inspection and preparation", {
            agentId,
            paths,
            ...recoveryTiming(recovery),
          });
        } catch (error) {
          if (!this.stopped) {
            const reason = formatErrorMessage(error);
            failPendingAgentDatabase(refusal, error, { env });
            log.warn("agent database remains degraded", {
              agentId,
              paths,
              reason,
              ...recoveryTiming(recovery),
            });
          }
        } finally {
          if (this.pending.get(agentId) === recovery) {
            this.pending.delete(agentId);
          }
          if (this.pending.size === 0) {
            this.clearProgress();
          }
          if (this.publishingAgentId === agentId) {
            this.publishingAgentId = undefined;
          }
          publicationComplete.resolve();
          completion.resolve();
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
    return await startupAdmission.run(admission, () => run(admission));
  } finally {
    await admission.releaseStartup();
  }
}
