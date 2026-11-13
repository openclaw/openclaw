import type { DatabaseSync } from "node:sqlite";
import { formatErrorMessage } from "../infra/errors.js";
import { repairCanonicalSqliteIndexes } from "../infra/sqlite-index-schema.js";
import {
  assertSqliteDatabaseHeader,
  type SqliteIntegrityDiagnostics,
} from "../infra/sqlite-integrity.js";
import type { SqliteTableContractReader } from "../infra/sqlite-schema-contract.js";
import { isSqliteSchemaMismatchError } from "../infra/sqlite-schema-issues.js";
import {
  assertExistingDatabaseIdentity,
  readDatabasePathIdentitySync,
  resolveDatabasePathKey,
} from "../infra/sqlite-worker-identity.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { runInDetachedAsyncContext } from "../shared/detached-async-context.js";
import type { createPermitPool } from "../shared/permit-pool.js";
import type { AgentDatabasePreparedIntegrity } from "./agent-database-preparation-context.js";
import { assertOpenClawAgentCurrentRuntimeSchema } from "./openclaw-agent-db-schema-helpers.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";

export type AgentDatabaseStartupVerifier = (input: {
  agentId: string;
  paths: readonly string[];
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  assertCurrent: () => void;
}) => Promise<void>;

type IntegrityWork = {
  pathname: string;
  statePath: string;
  signal: AbortSignal;
  assertCurrent: () => void;
  status: "pending" | "running" | "settled" | "inconclusive";
  completion?: Promise<void>;
};

// Retain completed attempts for the Gateway lifetime: native worker churn must not restart scans.
const pending = new Map<string, IntegrityWork>();

function releaseAgentDatabaseStartupVerification(signal: AbortSignal): void {
  for (const [key, owner] of pending) {
    if (owner.signal === signal) {
      pending.delete(key);
    }
  }
}

/** Startup may defer verification only while its exact background owner remains live. */
export function captureAgentDatabaseStartupVerification(pathname: string, env: NodeJS.ProcessEnv) {
  const canonicalPath = resolveDatabasePathKey(pathname);
  const statePath = resolveOpenClawStateSqlitePath(env);
  for (const owner of pending.values()) {
    if (
      owner.pathname === canonicalPath &&
      owner.statePath === statePath &&
      !owner.signal.aborted &&
      (owner.status === "pending" || owner.status === "running")
    ) {
      owner.assertCurrent();
      return owner.assertCurrent;
    }
  }
  return undefined;
}

/** Lifecycle revocation is not corruption; migrations and explicit verification keep their gate. */
export function admitAgentDatabaseRuntimeStructure(
  database: DatabaseSync,
  pathname: string,
  agentId: string,
  diagnostics?: SqliteIntegrityDiagnostics,
): string[] | undefined {
  assertSqliteDatabaseHeader(database, pathname);
  try {
    const validateSchema = (readTable?: SqliteTableContractReader) =>
      assertOpenClawAgentCurrentRuntimeSchema(
        database,
        {
          agentId,
          pathname,
          requireCanonicalIndexes: true,
        },
        readTable,
      );
    const startedAt = performance.now();
    const repaired = repairCanonicalSqliteIndexes(database, pathname, OPENCLAW_AGENT_SCHEMA_SQL, {
      nonUniqueOnly: true,
      verifyPhysicalIntegrity: false,
      validateAfterRepair: validateSchema,
      validateUnchanged: validateSchema,
    });
    if (diagnostics) {
      diagnostics.canonicalIndexMs = Math.floor(performance.now() - startedAt);
      diagnostics.repairedIndexCount = repaired.length;
      diagnostics.integrityGateMode = "deferred";
      diagnostics.integrityGateOutcome = "pending";
    }
    return repaired;
  } catch (error) {
    if (isSqliteSchemaMismatchError(error)) {
      return undefined;
    }
    throw error;
  }
}

/** Startup and runtime admission share the same bounded background verification owner. */
export function prepareAgentDatabaseStartupVerification(
  input: Omit<Parameters<AgentDatabaseStartupVerifier>[0], "assertCurrent">,
  activation: { isCurrent: () => boolean; verifyIntegrity?: AgentDatabaseStartupVerifier },
  permits: ReturnType<typeof createPermitPool>,
  prepared?: AgentDatabasePreparedIntegrity,
) {
  const verify = activation.verifyIntegrity;
  if (!verify) {
    return undefined;
  }
  const created: { key: string; owner: IntegrityWork }[] = [];
  const owners: IntegrityWork[] = [];
  const revoke = () => {
    for (const { key, owner } of created) {
      if (pending.get(key) === owner) {
        pending.delete(key);
      }
    }
  };
  try {
    for (const pathname of input.paths) {
      const identity = prepared
        ? {
            key: `file:${prepared.identity}`,
            birthtime: prepared.birthtime,
            canonicalPath: pathname,
          }
        : readDatabasePathIdentitySync(pathname);
      if (!identity.key.startsWith("file:")) {
        throw new Error("Deferred agent integrity requires an existing database");
      }
      const statePath = resolveOpenClawStateSqlitePath(input.env);
      const key = JSON.stringify([statePath, identity.key, identity.birthtime]);
      const previous = pending.get(key);
      if (previous && !previous.signal.aborted) {
        if (previous.signal !== input.signal) {
          throw new Error(`Another Gateway owns agent database verification: ${pathname}`);
        }
        owners.push(previous);
        continue;
      }
      const owner: IntegrityWork = {
        pathname: identity.canonicalPath,
        statePath,
        signal: input.signal,
        status: prepared?.integrityVerifiedAt !== undefined ? "settled" : "pending",
        assertCurrent() {
          input.signal.throwIfAborted();
          if (pending.get(key) !== owner || !activation.isCurrent()) {
            throw new Error(`Gateway no longer owns integrity verification for ${input.agentId}`);
          }
          assertExistingDatabaseIdentity(pathname, identity.key, identity.birthtime);
        },
      };
      pending.set(key, owner);
      created.push({ key, owner });
      owners.push(owner);
    }
  } catch (error) {
    revoke();
    throw error;
  }
  return {
    revoke,
    verify: async () => {
      await Promise.all(
        owners.map(async (owner) => {
          if (owner.status !== "pending") {
            return owner.completion;
          }
          owner.status = "running";
          return (owner.completion = (async () => {
            let release: (() => void) | null | undefined;
            try {
              release = await permits.acquire({ signal: owner.signal });
              owner.assertCurrent();
              await verify({
                ...input,
                paths: [owner.pathname],
                assertCurrent: owner.assertCurrent,
              });
              // The verifier publishes either verified proof or quarantine; completion itself is neither.
              owner.status = "settled";
            } catch (error) {
              owner.status = "inconclusive";
              if (!owner.signal.aborted) {
                createSubsystemLogger("state/agent-admission").warn(
                  `agent database background integrity verification incomplete: ${formatErrorMessage(error)}`,
                  { agentId: input.agentId, reason: formatErrorMessage(error) },
                );
              }
            } finally {
              release?.();
            }
          })());
        }),
      );
    },
  };
}

/** Runtime preparation contributes work to the adopted startup owner's lifetime and permits. */
async function verifyAgentDatabaseRuntimeIntegrity(
  prepared: AgentDatabasePreparedIntegrity,
  signal: AbortSignal,
  activating: Promise<
    { isCurrent: () => boolean; verifyIntegrity?: AgentDatabaseStartupVerifier } | undefined
  >,
  permits: ReturnType<typeof createPermitPool>,
): Promise<void> {
  const activation = await activating;
  if (!activation || signal.aborted) {
    return;
  }
  try {
    const integrity = prepareAgentDatabaseStartupVerification(
      {
        agentId: prepared.agentId,
        paths: [prepared.path],
        env: prepared.env,
        signal,
      },
      activation,
      permits,
      prepared,
    );
    await integrity?.verify();
  } catch (error) {
    createSubsystemLogger("state/agent-admission").warn(
      `agent database background integrity verification could not be scheduled: ${formatErrorMessage(error)}`,
      { agentId: prepared.agentId, reason: formatErrorMessage(error) },
    );
  }
}

export function createAgentDatabaseRuntimeIntegrityObserver(
  signal: AbortSignal,
  activation: Parameters<typeof verifyAgentDatabaseRuntimeIntegrity>[2],
  permits: ReturnType<typeof createPermitPool>,
  track: (work: Promise<void>) => void,
) {
  signal.addEventListener("abort", () => releaseAgentDatabaseStartupVerification(signal), {
    once: true,
  });
  return (prepared: AgentDatabasePreparedIntegrity) =>
    track(
      runInDetachedAsyncContext(() =>
        verifyAgentDatabaseRuntimeIntegrity(prepared, signal, activation, permits),
      ),
    );
}
