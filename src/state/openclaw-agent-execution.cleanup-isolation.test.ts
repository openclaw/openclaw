import assert from "node:assert/strict";
import fs from "node:fs";
import type { Worker } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { AUTH_TOKEN, withGatewayServer } from "../gateway/server-http.test-harness.js";
import { createReadinessChecker } from "../gateway/server/readiness.js";
import { collectNestedErrorCandidates } from "../infra/error-graph-internal.js";
import { formatErrorMessageWithCode } from "../infra/errors.js";
import { createSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import { readLoggingConfig } from "../logging/config.js";
import { applyLoggingConfig } from "../logging/logger.js";
import { reserveTestPortListener } from "../test-utils/port-claims.js";
import { closeOpenClawAgentDatabasesAsync } from "./openclaw-agent-db-lifecycle.js";
import type { AgentDatabaseRequestExecutionSource } from "./openclaw-agent-execution-admission-contract.js";
import {
  captureOpenClawAgentDatabaseExecution,
  getOpenClawAgentDatabaseCleanupFailures,
} from "./openclaw-agent-execution.js";
import { closeOpenClawStateDatabaseAsync, openOpenClawStateDatabase } from "./openclaw-state-db.js";

const fault = vi.hoisted(() => ({
  path: "",
  enabled: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
}));
vi.mock("../infra/worker-cpu.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/worker-cpu.js")>();
  const preload = `
    import { DatabaseSync } from "node:sqlite";
    import { workerData } from "node:worker_threads";
    const prepare = DatabaseSync.prototype.prepare;
    DatabaseSync.prototype.prepare = function(sql) {
      const statement = prepare.call(this, sql);
      if (/delete from "?agent_database_leases"?/i.test(sql)) {
        // DELETE RETURNING uses all() on current Node and iterate() on Bun.
        for (const method of ["run", "all", "iterate"]) {
          const execute = statement[method].bind(statement);
          statement[method] = (...args) => {
            if (Atomics.load(new Int32Array(workerData.cleanupFaultEnabled), 0)) {
              const selected = prepare.call(this, "SELECT path FROM agent_database_leases WHERE lease_id = ?");
              if (args.some((value) => typeof value === "string" && selected.get(value)?.path === workerData.cleanupFaultPath)) {
                throw new AggregateError([
                  Object.assign(new Error("controlled idle worker lease failure; cleanup-canary-private; Authorization: Bearer synthetic-cleanup-secret"), { code: "ERR_SQLITE_ERROR", errcode: 5 }),
                  new Error("controlled lease release refused"),
                ], "Agent database cleanup failed");
              }
            }
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
          cleanupFaultPath: fault.path,
          cleanupFaultEnabled: fault.enabled,
        },
      });
    },
  };
});

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  }),
);
const source: AgentDatabaseRequestExecutionSource = {
  assertCurrent: () => undefined,
  createAdmission(binding) {
    return () => ({
      nativeLocations: binding.nativeLocations,
      admission: createSqliteWorkerOperationAdmission((request, grant) => {
        binding.authorize(request);
        if (!grant()) {
          throw new Error("Cleanup isolation fixture lost admission");
        }
      }, binding.attachment),
    });
  },
};

it("keeps healthy agents usable while real worker lease cleanup fails, then recovers its exact owner", async () => {
  const previousLogging = readLoggingConfig();
  const env = { OPENCLAW_STATE_DIR: fs.realpathSync(tempDirs.make("agent-cleanup-isolation-")) };
  const shared = openOpenClawStateDatabase({ env });
  const first = captureOpenClawAgentDatabaseExecution({ agentId: "first", env });
  const initial = [
    first,
    ...["second", "third", "fourth"].map((agentId) =>
      captureOpenClawAgentDatabaseExecution({ agentId, env }),
    ),
  ];
  const fifth = captureOpenClawAgentDatabaseExecution({ agentId: "fifth", env });
  const leases = () =>
    shared.db.prepare("SELECT lease_id FROM agent_database_leases WHERE path = ?").all(first.path);
  fault.path = first.path;
  let retry: ReturnType<typeof captureOpenClawAgentDatabaseExecution> | undefined;
  let healthy: ReturnType<typeof captureOpenClawAgentDatabaseExecution> | undefined;
  try {
    for (const execution of initial) {
      await execution.prepare(source);
      await execution.release();
    }
    const retained = leases();
    expect(retained).toHaveLength(1);
    const retainedLease = retained[0];
    assert(retainedLease);
    Atomics.store(new Int32Array(fault.enabled), 0, 1);

    await fifth.prepare(source);
    // Releasing a fifth warm owner crosses the real native-close and lease-cleanup boundaries.
    await fifth.release();
    expect(leases()).toEqual(retained);
    expect(getOpenClawAgentDatabaseCleanupFailures(shared.path)).toEqual([
      expect.objectContaining({ agentId: "first" }),
    ]);
    const reported = getOpenClawAgentDatabaseCleanupFailures(shared.path)[0];
    assert(reported);
    const diagnostic = reported.reason;
    expect(diagnostic).toContain("ERR_SQLITE_ERROR");
    expect.soft(diagnostic).toContain("errcode=5");
    expect(diagnostic).toContain("controlled idle worker lease failure");
    expect(diagnostic).toContain("controlled lease release refused");
    expect(diagnostic).not.toContain("synthetic-cleanup-secret");

    const getReadiness = createReadinessChecker({
      channelManager: {
        getRuntimeSnapshot: () => ({ channels: {}, channelAccounts: {} }),
        getAutostartSuppression: () => null,
        isAmbientAutostartSuppressed: () => false,
      },
      startedAt: Date.now(),
      getAgentDatabaseCleanupFailures: () => getOpenClawAgentDatabaseCleanupFailures(shared.path),
    });
    const proxyConfig = { gateway: { trustedProxies: ["127.0.0.1"] } };
    await withGatewayServer({
      prefix: "cleanup-readiness-",
      resolvedAuth: AUTH_TOKEN,
      overrides: { getReadiness, getRuntimeConfig: () => proxyConfig },
      run: async (server) => {
        const reserved = await reserveTestPortListener({
          offsets: [0],
          createListener: () => server,
        });
        await runQaGatewayFixture(
          async () => {
            const url = `http://127.0.0.1:${reserved.claim.port}/readyz`;
            const remote = { "x-forwarded-for": "198.51.100.8" };
            const authenticated = { ...remote, authorization: "Bearer test-token" };
            const before = await fetch(url, { headers: authenticated });
            const beforeBody = await before.text();
            expect(before.status).toBe(200);
            expect(beforeBody).toContain("cleanup-canary-private");
            applyLoggingConfig({
              ...previousLogging,
              redactPatterns: [
                ...(previousLogging?.redactPatterns ?? []),
                "cleanup-canary-private",
              ],
            });
            const after = await fetch(url, { headers: authenticated });
            const afterBody = await after.text();
            expect(after.status).toBe(200);
            expect.soft(afterBody).not.toContain("cleanup-canary-private");
            expect.soft(afterBody).toContain("errcode=5");
            expect(afterBody).not.toContain("synthetic-cleanup-secret");
            const unauthenticated = await fetch(url, { headers: remote });
            const publicBody: unknown = await unauthenticated.json();
            expect(unauthenticated.status).toBe(200);
            expect(publicBody).toEqual({ ready: true });
          },
          () => {
            server.closeAllConnections();
            return reserved.releaseListener();
          },
          reserved.claim.release,
        );
      },
    });
    applyLoggingConfig(previousLogging);

    healthy = captureOpenClawAgentDatabaseExecution({ agentId: "fifth", env });
    await healthy.prepare(source);
    expect(
      await healthy.runExisting(source, (scope) =>
        scope.execute({
          type: "database.walMaintenance",
          input: { maxPages: 0, checkpointMode: "PASSIVE" },
        }),
      ),
    ).toMatchObject({ reclaimedPages: 0 });
    await healthy.release();

    retry = captureOpenClawAgentDatabaseExecution({ agentId: "first", env });
    const failure: unknown = await retry.prepare(source).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(collectNestedErrorCandidates(failure)).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "ERR_SQLITE_ERROR", errcode: 5 })]),
    );
    expect(formatErrorMessageWithCode(failure)).toContain("controlled idle worker lease failure");
    expect(formatErrorMessageWithCode(failure)).not.toContain("synthetic-cleanup-secret");
    expect(leases()).toEqual(retained);
    Atomics.store(new Int32Array(fault.enabled), 0, 0);
    await retry.prepare(source);
    expect(
      await retry.runExisting(source, (scope) =>
        scope.execute({
          type: "database.walMaintenance",
          input: { maxPages: 0, checkpointMode: "PASSIVE" },
        }),
      ),
    ).toMatchObject({ reclaimedPages: 0 });
    const replacement = leases();
    expect(replacement).toHaveLength(1);
    const replacementLease = replacement[0];
    assert(replacementLease);
    expect(replacementLease.lease_id).not.toBe(retainedLease.lease_id);
    expect(getOpenClawAgentDatabaseCleanupFailures(shared.path)).toEqual([]);
  } finally {
    applyLoggingConfig(previousLogging);
    Atomics.store(new Int32Array(fault.enabled), 0, 0);
    await Promise.all([
      ...initial.map((execution) => execution.release()),
      fifth.release(),
      healthy?.release(),
      retry?.release(),
    ]);
  }
});
