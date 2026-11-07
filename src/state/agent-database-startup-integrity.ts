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

export type AgentDatabaseStartupVerifier = (input: {
  agentId: string;
  paths: readonly string[];
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  assertCurrent: () => void;
}) => Promise<void>;

const pending = new Map<string, { assertCurrent: () => void }>();

/** Background verification retains its original physical file and startup lifetime. */
function prepareAgentDatabaseStartupIntegrity(pathname: string) {
  const identity = readDatabasePathIdentitySync(pathname);
  if (!identity.key.startsWith("file:")) {
    throw new Error("Deferred agent integrity requires an existing database");
  }
  const key = identity.canonicalPath;
  const previous = pending.get(key);
  if (previous) {
    throw new Error(`Agent database already has a startup integrity owner: ${pathname}`);
  }
  const owner = {
    assertCurrent(this: void) {
      if (pending.get(key) !== owner) {
        throw new Error(`Agent database startup integrity owner ended: ${pathname}`);
      }
      assertExistingDatabaseIdentity(pathname, identity.key, identity.birthtime);
    },
  };
  pending.set(key, owner);
  return {
    assertCurrent: owner.assertCurrent,
    revoke() {
      if (pending.get(key) === owner) {
        pending.delete(key);
      }
    },
  };
}

/** Startup may defer verification only while its exact background owner remains live. */
export function captureAgentDatabaseStartupVerification(pathname: string) {
  const owner = pending.get(resolveDatabasePathKey(pathname));
  owner?.assertCurrent();
  return owner?.assertCurrent;
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
      owners.push(prepareAgentDatabaseStartupIntegrity(pathname));
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
