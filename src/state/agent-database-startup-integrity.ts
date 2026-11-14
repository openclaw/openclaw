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
import type { createPermitPool } from "../shared/permit-pool.js";
import { assertOpenClawAgentCurrentRuntimeSchema } from "./openclaw-agent-db-schema-helpers.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";

export type AgentDatabaseStartupIntegrity = { valid: SharedArrayBuffer };
export type AgentDatabaseStartupVerifier = (input: {
  agentId: string;
  paths: readonly string[];
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  assertCurrent: () => void;
}) => Promise<void>;

const pending = new Map<
  string,
  { agentId: string; policy: AgentDatabaseStartupIntegrity; assertCurrent: () => void }
>();

/** This Gateway lifetime permits recovery before the background full-file verdict. */
function prepareAgentDatabaseStartupIntegrity(pathname: string, agentId: string) {
  const identity = readDatabasePathIdentitySync(pathname);
  if (!identity.key.startsWith("file:")) {
    throw new Error("Deferred agent integrity requires an existing database");
  }
  const key = identity.canonicalPath;
  const previous = pending.get(key);
  if (previous) {
    throw new Error(`Agent database already has a startup integrity owner: ${pathname}`);
  }
  const policy = { valid: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT) };
  Atomics.store(new Int32Array(policy.valid), 0, 1);
  const owner = {
    agentId,
    policy,
    assertCurrent(this: void) {
      if (pending.get(key) !== owner || Atomics.load(new Int32Array(policy.valid), 0) !== 1) {
        throw new Error(`Agent database startup integrity owner ended: ${pathname}`);
      }
      assertExistingDatabaseIdentity(pathname, identity.key, identity.birthtime);
    },
  };
  pending.set(key, owner);
  return {
    assertCurrent: owner.assertCurrent,
    revoke() {
      Atomics.store(new Int32Array(policy.valid), 0, 0);
      if (pending.get(key) === owner) {
        pending.delete(key);
      }
    },
  };
}

/** Bounded admission repairs derived indexes; migrations retain their full gate. */
export function admitAgentDatabaseStartupStructure(
  database: DatabaseSync,
  pathname: string,
  agentId: string,
  policy: AgentDatabaseStartupIntegrity | undefined,
  diagnostics?: SqliteIntegrityDiagnostics,
): boolean {
  if (
    diagnostics?.integrityGateReason !== "no-proof" &&
    diagnostics?.integrityGateReason !== "schema-mismatch" &&
    (!policy || Atomics.load(new Int32Array(policy.valid), 0) !== 1)
  ) {
    return false;
  }
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
    }
    if (repaired.length) {
      createSubsystemLogger("state/agent-db").warn(
        `Rebuilt canonical agent SQLite indexes for ${agentId} (${pathname}): ${repaired.join(", ")}`,
      );
    }
  } catch (error) {
    if (isSqliteSchemaMismatchError(error)) {
      return false;
    }
    throw error;
  }
  if (diagnostics) {
    diagnostics.integrityGateMode = "deferred";
    diagnostics.integrityGateOutcome = "pending";
  }
  return true;
}

/** The startup owner releases readiness before running this cancellable verification. */
export function prepareAgentDatabaseStartupVerification(
  input: Omit<Parameters<AgentDatabaseStartupVerifier>[0], "assertCurrent">,
  activation: { isCurrent: () => boolean; verifyIntegrity?: AgentDatabaseStartupVerifier },
  permits: ReturnType<typeof createPermitPool>,
) {
  const verify = activation.verifyIntegrity;
  if (!verify) {
    return undefined;
  }
  const owners: ReturnType<typeof prepareAgentDatabaseStartupIntegrity>[] = [];
  const revoke = () => owners.forEach((owner) => owner.revoke());
  try {
    for (const pathname of input.paths) {
      owners.push(prepareAgentDatabaseStartupIntegrity(pathname, input.agentId));
    }
  } catch (error) {
    revoke();
    throw error;
  }
  const assertCurrent = () => {
    input.signal.throwIfAborted();
    if (!activation.isCurrent()) {
      throw new Error(`Gateway no longer owns integrity verification for ${input.agentId}`);
    }
    owners.forEach((owner) => owner.assertCurrent());
  };
  return {
    revoke,
    verify: async () => {
      let release: (() => void) | null | undefined;
      try {
        release = await permits.acquire({ signal: input.signal });
        assertCurrent();
        await verify({ ...input, assertCurrent });
      } catch (error) {
        if (!input.signal.aborted) {
          createSubsystemLogger("state/agent-admission").warn(
            "agent database background integrity verification incomplete",
            { agentId: input.agentId, reason: formatErrorMessage(error) },
          );
        }
      } finally {
        release?.();
        revoke();
      }
    },
  };
}

/** Only the native opener receives this private, physical-file-bound startup policy. */
export function captureAgentDatabaseStartupIntegrity(
  pathname: string,
  agentId: string,
): AgentDatabaseStartupIntegrity | undefined {
  const owner = pending.get(resolveDatabasePathKey(pathname));
  if (!owner || owner.agentId !== agentId) {
    return undefined;
  }
  owner.assertCurrent();
  return owner.policy;
}
