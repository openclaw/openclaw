import fs from "node:fs";
import type { Worker } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { createSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import {
  createOpenClawAgentDatabaseClaim,
  type OpenClawAgentDatabaseClaim,
} from "./openclaw-agent-db-identity.js";
import {
  claimOpenClawAgentDatabaseLease,
  releaseOpenClawAgentDatabaseLease,
} from "./openclaw-agent-db-lease.js";
import { retainAgentDatabase } from "./openclaw-agent-db-lifecycle.js";
import {
  getOpenClawAgentDatabaseValidation,
  invalidateOpenClawAgentDatabaseValidation,
} from "./openclaw-agent-db-validation-cache.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  closeOpenClawAgentDatabaseByPath,
  openOpenClawAgentDatabase,
  recordOpenClawAgentDatabaseOpenFailure,
} from "./openclaw-agent-db.js";
import type { AgentDatabaseRequestExecutionSource } from "./openclaw-agent-execution-contract.js";
import { createAgentDatabaseNativeGeneration } from "./openclaw-agent-execution-native.js";
import {
  clearOpenClawAgentIntegrityVerification,
  resolveQuarantineStorePath,
} from "./openclaw-quarantine-store.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "./openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";

const counter = vi.hoisted(() => ({
  path: "",
  checks: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2),
}));
vi.mock("../infra/worker-cpu.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/worker-cpu.js")>();
  const preload = `
    import { DatabaseSync } from "node:sqlite";
    import { workerData } from "node:worker_threads";
    const prepare = DatabaseSync.prototype.prepare;
    DatabaseSync.prototype.prepare = function(sql) {
      const statement = prepare.call(this, sql);
      const match = /^PRAGMA (integrity_check|foreign_key_check);?$/i.exec(sql.trim());
      if (this.location() === workerData.testIntegrityPath && match) {
        for (const method of ["all", "get", "iterate", "run"]) {
          const execute = statement[method].bind(statement);
          statement[method] = (...args) => {
            Atomics.add(new Int32Array(workerData.testIntegrityChecks),
              match[1].toLowerCase() === "integrity_check" ? 0 : 1, 1);
            return execute(...args);
          };
        }
      }
      return statement;
    };
  `;
  return {
    ...actual,
    createCpuTrackedWorker(
      filename: string | URL,
      options: ConstructorParameters<typeof Worker>[1],
    ) {
      return actual.createCpuTrackedWorker(filename, {
        ...options,
        execArgv: [
          ...(options?.execArgv ?? []),
          "--import",
          `data:text/javascript,${encodeURIComponent(preload)}`,
        ],
        workerData: {
          ...options?.workerData,
          testIntegrityPath: counter.path,
          testIntegrityChecks: counter.checks,
        },
      });
    },
  };
});

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  }),
);

it.each([
  "verified",
  "invalidated",
  "failed",
  "revoked-before-grant",
  "missing-metadata",
  "version-mismatch",
  "closed-host",
  "closed-host-revoked",
  "closed-host-replaced",
] as const)("native execution borrows only current host integrity proof (%s)", async (proof) => {
  const env = { OPENCLAW_STATE_DIR: fs.realpathSync(tempDirs.make("agent-native-integrity-")) };
  const database = openOpenClawAgentDatabase({ agentId: "main", env });
  expect(getOpenClawAgentDatabaseValidation(database)).toBeDefined();
  counter.path = database.path;
  counter.checks = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
  const context = captureOpenClawStateWorkerContext({ env });
  const closedHost = proof.startsWith("closed-host");
  const siblingLease = closedHost
    ? claimOpenClawAgentDatabaseLease({ agentId: database.agentId, path: database.path, env })
    : undefined;
  const claim: OpenClawAgentDatabaseClaim | undefined = closedHost
    ? undefined
    : createOpenClawAgentDatabaseClaim(database, retainAgentDatabase(database.db));
  if (closedHost) {
    closeOpenClawAgentDatabaseByPath(database.path);
  }
  const assertCurrent = () => {
    claim?.assertCurrent();
    context.admission.assertCurrent();
  };
  let revokedBeforeGrant = false;
  const source: AgentDatabaseRequestExecutionSource = {
    assertCurrent,
    createAdmission(binding) {
      return () => ({
        nativeLocations: binding.nativeLocations,
        admission: createSqliteWorkerOperationAdmission((request, grant) => {
          binding.authorize(request);
          assertCurrent();
          if (
            proof === "revoked-before-grant" &&
            request.stage === "prepare" &&
            typeof request.facts === "object" &&
            request.facts !== null &&
            "kind" in request.facts &&
            request.facts.kind === "shared-owner"
          ) {
            // Revoke the already-sent proof while the native opener still awaits its grant.
            invalidateOpenClawAgentDatabaseValidation(database.path);
            revokedBeforeGrant = true;
          }
          if (!grant()) {
            throw new Error("Native integrity fixture lost its retained admission");
          }
        }),
      });
    },
  };
  const generation = createAgentDatabaseNativeGeneration(
    database.agentId,
    database.path,
    context,
    assertCurrent,
    assertCurrent,
    undefined,
    () => {},
  );
  if (proof === "invalidated" || proof === "closed-host-revoked") {
    invalidateOpenClawAgentDatabaseValidation(database.path);
  } else if (proof === "closed-host-replaced") {
    fs.copyFileSync(database.path, `${database.path}.replacement`);
    fs.renameSync(`${database.path}.replacement`, database.path);
  } else if (proof === "failed") {
    recordOpenClawAgentDatabaseOpenFailure(database.path, new Error("Synthetic host failure"));
  } else if (proof === "missing-metadata") {
    clearOpenClawAgentIntegrityVerification(database.path, env);
  } else if (proof === "version-mismatch") {
    const store = openNodeSqliteDatabase(resolveQuarantineStorePath(env));
    try {
      store.exec("UPDATE agent_integrity_verifications SET app_version='previous-release'");
    } finally {
      store.close();
    }
  }
  try {
    if (proof === "failed") {
      await expect(generation.runExisting(source, async () => "opened")).rejects.toThrow(
        "OpenClaw agent database claim is no longer current",
      );
      expect(getOpenClawAgentDatabaseValidation(database)).toBeUndefined();
      expect(Array.from(new Int32Array(counter.checks))).toEqual([0, 0]);
      return;
    }
    await expect(generation.runExisting(source, async () => "opened")).resolves.toBe("opened");
    expect(Array.from(new Int32Array(counter.checks))).toEqual(
      proof === "verified" || proof === "closed-host" ? [0, 0] : [1, 1],
    );
    expect(revokedBeforeGrant).toBe(proof === "revoked-before-grant");
  } finally {
    try {
      await generation.close();
    } finally {
      claim?.release();
      if (siblingLease) {
        releaseOpenClawAgentDatabaseLease(siblingLease, { env }, "read-only");
      }
    }
  }
});
