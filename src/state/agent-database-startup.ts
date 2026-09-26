import { AsyncLocalStorage } from "node:async_hooks";
import { statSync } from "node:fs";
import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  sameFileMutationFingerprint,
  type FileMutationFingerprint,
} from "../infra/file-descriptor.js";
import { readSqliteIntegrityFileIdentity } from "../infra/sqlite-file-generation.js";
import { withSqliteReadOnlyWorkerScope } from "../infra/sqlite-readonly-worker.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  createAgentDatabaseInspectionRefusal,
  failPendingAgentDatabase,
  listAgentDatabaseAdmissionRefusals,
  preparePendingAgentDatabase,
  type AgentDatabaseAdmissionRefusal,
} from "./agent-database-admission.js";
import { readAgentDeletionJournalStatusInWorker } from "./agent-deletion-journal.read.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "./openclaw-agent-db-contract.js";
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
};
type Activation = {
  isCurrent: () => boolean;
  prepareAgent: (input: PreparationInput) => Promise<void>;
};
type SchemaSourceWitness = Array<FileMutationFingerprint | undefined>;
type PreparedSchemaHeaders = {
  statePath: string;
  headers: Map<
    string,
    { version: typeof OPENCLAW_AGENT_SCHEMA_VERSION; witness: SchemaSourceWitness }
  >;
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

const log = createSubsystemLogger("state/agent-admission");
const startupAdmission = new AsyncLocalStorage<AgentDatabaseStartupAdmission>();

/** Startup owns readers until the Gateway adopts them; only the Gateway activates agents. */
class AgentDatabaseStartupAdmission {
  private readonly controller = new AbortController();
  private readonly activation = createDeferredCore<Activation | undefined>();
  private readonly work = new Set<Promise<unknown>>();
  private readonly pending = new Map<string, AgentDatabaseAdmissionRefusal>();
  private adopted = false;
  private activated = false;
  private stopped = false;
  private stopping?: Promise<void>;
  private preparation: Promise<void> = Promise.resolve();
  private preparedSchemaHeaders?: PreparedSchemaHeaders;

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get isStopped(): boolean {
    return this.stopped;
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
      return (version: number) => {
        if (
          !this.stopped &&
          this.preparedSchemaHeaders === prepared &&
          before &&
          version === OPENCLAW_AGENT_SCHEMA_VERSION &&
          matchesSchemaSourceWitness(before, readSchemaSourceWitness(pathname))
        ) {
          prepared.headers.set(pathname, { version, witness: before });
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
        header?.version === supportedVersion &&
        matchesSchemaSourceWitness(header.witness, readSchemaSourceWitness(pathname))
        ? { version: header.version }
        : undefined;
    };
  }

  track(work: Promise<unknown>): void {
    this.work.add(work);
    void work.then(
      () => this.work.delete(work),
      () => this.work.delete(work),
    );
  }

  scheduling(env: NodeJS.ProcessEnv) {
    return {
      signal: this.signal,
      path: (target: PendingInspection["target"]) => target.path,
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
      }),
    );
    return true;
  }

  captureRefusals(env: NodeJS.ProcessEnv): ReadonlyMap<string, AgentDatabaseAdmissionRefusal> {
    return new Map(
      listAgentDatabaseAdmissionRefusals({ env })
        .filter((refusal) => this.pending.get(refusal.agentId) === refusal)
        .map((refusal) => [refusal.agentId, refusal]),
    );
  }

  reuseRefusal(
    target: PendingInspection["target"],
    inspection: OpenClawDatabaseSchemaPreflight,
    priorRefusals?: ReadonlyMap<string, AgentDatabaseAdmissionRefusal>,
  ): boolean {
    const refusal = target.agentId && priorRefusals?.get(target.agentId);
    if (!refusal) {
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
      this.pending.set(agentId, refusal);
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
      const recovery = (async () => {
        const results = await checked;
        const activation = await this.activation.promise;
        if (!activation || this.stopped) {
          return;
        }
        const prepare = async () => {
          const assertCurrent = () => {
            this.signal.throwIfAborted();
            if (!activation.isCurrent() || this.pending.get(agentId) !== refusal) {
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
          try {
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
            await withSqliteReadOnlyWorkerScope(
              async () => {
                await assertNotDeleted();
                await preparePendingAgentDatabase(refusal, { env, assertCurrent }, async () => {
                  await activation.prepareAgent({
                    agentId,
                    paths,
                    env,
                    signal: this.signal,
                    assertCurrent,
                  });
                  await assertNotDeleted();
                });
              },
              { signal: this.signal, deadlineOwnedByCaller: true },
            );
            log.info("agent database recovered after background inspection and preparation", {
              agentId,
              paths,
            });
          } catch (error) {
            if (!this.stopped) {
              const reason = formatErrorMessage(error);
              failPendingAgentDatabase(refusal, reason, { env });
              log.warn("agent database remains degraded", { agentId, paths, reason });
            }
          } finally {
            if (this.pending.get(agentId) === refusal) {
              this.pending.delete(agentId);
            }
          }
        };
        const prepared = this.preparation.then(prepare);
        this.preparation = prepared.catch(() => {});
        await prepared;
      })();
      this.track(recovery);
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
): Promise<T> {
  const admission = getAgentDatabaseStartupAdmission() ?? new AgentDatabaseStartupAdmission();
  try {
    return await startupAdmission.run(admission, () => run(admission));
  } finally {
    await admission.releaseStartup();
  }
}
