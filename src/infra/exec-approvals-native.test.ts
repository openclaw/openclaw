import fs from "node:fs/promises";
import path from "node:path";
import { getEnvironmentData } from "node:worker_threads";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { adminStateOwnerFixtureEntrypoint } from "../cli/cli-entrypoint.test-support.js";
import { runCliProcessChild } from "../cli/cli-process-child.test-helpers.js";
import {
  commitNativeExecLocal,
  loadSnapshotLocal,
  saveSnapshotLocal,
} from "../cli/exec-approvals-local.js";
import { runWithLocalStateOwner } from "../cli/local-state-owner.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { withEngineStoreAdmission } from "./database-engine/admission-scope.js";
import { resetDatabaseEngineSelectionForTest } from "./database-engine/context.test-support.js";
import { getPostgresPhysicalFacts } from "./database-engine/physical-facts.js";
import { createExecApprovalPolicySnapshot } from "./exec-approvals-allow-always.js";
import {
  commitNativeExecAuthorization,
  type NativeExecAuthorization,
} from "./exec-approvals-native.js";
import { acquireGatewayLock } from "./gateway-lock.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";

const configured: unknown = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;
const roots = useAutoCleanupTempDirTracker(afterEach);

describe.each(["sqlite", ...(connection ? ["postgres"] : [])])(
  "native exec owner on %s",
  (engine) => {
    let namespace: string | undefined;
    let root: string;
    const entry = { id: "echo", pattern: "/usr/bin/echo" };
    const input = (): NativeExecAuthorization => ({
      agentId: "main",
      command: "echo native",
      uses: [{ match: entry, resolvedPath: "/usr/bin/echo" }],
      grants: [],
      authorization: {
        source: "current-policy",
        security: "allowlist",
        ask: "on-miss",
        allowlistSatisfied: true,
      },
    });
    const inspect = <T>(run: (database: ReturnType<typeof openOpenClawStateDatabase>) => T) =>
      runWithLocalStateOwner({
        method: "native-owner-fixture",
        params: {},
        target: "synthetic native owner fixture",
        databaseEngine: "configured",
        runLocal: async () =>
          withEngineStoreAdmission(() => {
            const database = openOpenClawStateDatabase();
            namespace = getPostgresPhysicalFacts(database.db)?.namespace;
            return run(database);
          }),
      });

    beforeEach(async () => {
      resetDatabaseEngineSelectionForTest();
      root = roots.make("exec-native-owner-");
      vi.stubEnv("OPENCLAW_STATE_DIR", root);
      vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(root, "openclaw.json"));
      await fs.writeFile(
        path.join(root, "openclaw.json"),
        JSON.stringify(
          engine === "postgres"
            ? {
                database: {
                  engine: "postgres",
                  postgres: { connection, schemaPrefix: "native_exec" },
                },
              }
            : {},
        ),
      );
      const snapshot = await loadSnapshotLocal();
      await saveSnapshotLocal(
        {
          version: 1,
          defaults: { security: "allowlist", ask: "on-miss" },
          agents: { main: { allowlist: [entry] } },
        },
        snapshot.hash,
      );
      await inspect(() => undefined);
    });

    afterEach(async () => {
      await closeOpenClawStateDatabaseAsync();
      resetDatabaseEngineSelectionForTest();
      vi.unstubAllEnvs();
      if (namespace && connection) {
        const client = new pg.Client({ connectionString: connection });
        await client.connect();
        try {
          await client.query(`DROP SCHEMA "${namespace.replaceAll('"', '""')}" CASCADE`);
        } finally {
          await client.end();
        }
      }
      namespace = undefined;
    });

    it("uses one policy for redacted reads, compare-and-swap replacement, and usage", async () => {
      const stored = await loadSnapshotLocal();
      await inspect((database) =>
        runOpenClawStateWriteTransaction(
          ({ db }) => {
            db.prepare(
              "UPDATE exec_approvals_config SET raw_json = ? WHERE config_key = 'current'",
            ).run(
              JSON.stringify({
                ...stored.file,
                socket: { path: "/synthetic/approval.sock", token: "synthetic-private-token" },
              }),
            );
          },
          { database },
        ),
      );
      const snapshot = await loadSnapshotLocal();
      expect(snapshot).not.toHaveProperty("raw");
      expect(snapshot.file.socket?.token).toBeUndefined();
      expect(JSON.stringify(snapshot)).not.toContain("synthetic-private-token");
      await saveSnapshotLocal(
        { ...snapshot.file, defaults: { security: "allowlist", ask: "always" } },
        snapshot.hash,
      );
      await expect(saveSnapshotLocal(snapshot.file, snapshot.hash)).rejects.toThrow(/changed/u);
      await expect(commitNativeExecLocal(input())).rejects.toThrow(/changed before execution/u);
      const latest = await loadSnapshotLocal();
      await saveSnapshotLocal(snapshot.file, latest.hash);
      await expect(commitNativeExecLocal(input())).resolves.toEqual({ authorized: true });
      expect((await loadSnapshotLocal()).file.agents?.main?.allowlist?.[0]).toMatchObject({
        lastUsedCommand: "echo native",
        lastResolvedPath: "/usr/bin/echo",
      });
    });

    it("binds delayed approvals to current policy and records grant usage atomically", async () => {
      const snapshot = await loadSnapshotLocal();
      const authorization = {
        ...input().authorization,
        source: "explicit-approval" as const,
        policySnapshot: createExecApprovalPolicySnapshot({ file: snapshot.file, agentId: "main" }),
      };
      const grant = {
        pattern: "/usr/bin/printf",
        argPattern: "^native$",
        resolvedPath: "/usr/bin/printf",
      };
      await expect(
        commitNativeExecLocal({ ...input(), authorization, grants: [grant] }),
      ).resolves.toEqual({ authorized: true });
      expect((await loadSnapshotLocal()).file.agents?.main?.allowlist).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            pattern: grant.pattern,
            source: "allow-always",
            lastUsedCommand: "echo native",
            lastResolvedPath: grant.resolvedPath,
          }),
        ]),
      );
      const current = await loadSnapshotLocal();
      await saveSnapshotLocal({ ...current.file, defaults: { security: "deny" } }, current.hash);
      await expect(commitNativeExecLocal({ ...input(), authorization })).rejects.toThrow(
        /changed before execution/u,
      );
    });

    it("denies when an allow-always write cannot persist", async () => {
      const snapshot = await loadSnapshotLocal();
      const authorization: NativeExecAuthorization["authorization"] = {
        ...input().authorization,
        source: "explicit-approval",
        policySnapshot: createExecApprovalPolicySnapshot({ file: snapshot.file, agentId: "main" }),
      };
      await runWithLocalStateOwner({
        method: "native-owner-persistence-fixture",
        params: {},
        target: "synthetic persistence failure",
        databaseEngine: "configured",
        runLocal: async ({ assertCurrent }) => {
          const context = captureOpenClawStateWorkerContext();
          // Admit the writer before the synthetic trigger so this reaches persistence, not schema admission.
          await commitNativeExecAuthorization(
            { ...input(), uses: [], authorization },
            assertCurrent,
            context,
          );
          const { db } = withEngineStoreAdmission(() => openOpenClawStateDatabase());
          withEngineStoreAdmission(() => {
            if (engine === "postgres") {
              db.exec(
                "CREATE FUNCTION native_exec_refuse_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic persistence failure'; END; $$",
              );
              db.exec(
                "CREATE TRIGGER native_exec_refuse_write BEFORE UPDATE ON exec_approvals_config FOR EACH ROW EXECUTE FUNCTION native_exec_refuse_write()",
              );
            } else {
              db.exec(
                "CREATE TRIGGER native_exec_refuse_write BEFORE UPDATE ON exec_approvals_config BEGIN SELECT RAISE(ABORT, 'synthetic persistence failure'); END",
              );
            }
          });
          try {
            await expect(
              commitNativeExecAuthorization(
                { ...input(), grants: [{ pattern: "/usr/bin/printf" }], authorization },
                assertCurrent,
                context,
              ),
            ).rejects.toThrow(/synthetic persistence failure/u);
          } finally {
            withEngineStoreAdmission(() => {
              db.exec(
                engine === "postgres"
                  ? "DROP TRIGGER native_exec_refuse_write ON exec_approvals_config"
                  : "DROP TRIGGER native_exec_refuse_write",
              );
              if (engine === "postgres") {
                db.exec("DROP FUNCTION native_exec_refuse_write()");
              }
            });
          }
        },
      });
      expect((await loadSnapshotLocal()).file.agents?.main?.allowlist).toEqual([entry]);
    });

    it("denies a deleted agent even when full policy requires no usage writes", async () => {
      const snapshot = await loadSnapshotLocal();
      await saveSnapshotLocal(
        { version: 1, defaults: { security: "full", ask: "off" } },
        snapshot.hash,
      );
      await inspect((database) =>
        runOpenClawStateWriteTransaction(
          ({ db }) => {
            db.prepare(
              "INSERT INTO agent_deletion_journal(agent_id, operation_id, agent_dir, workspace_dir, sessions_dir, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            ).run("main", "deletion", "/agent", "/workspace", "/sessions", 1);
          },
          { database },
        ),
      );
      await expect(
        commitNativeExecLocal({
          ...input(),
          uses: [],
          authorization: {
            source: "current-policy",
            security: "full",
            ask: "off",
            allowlistSatisfied: false,
          },
        }),
      ).rejects.toThrow(/agent deletion/u);
    });

    it("denies when another owner is unavailable instead of opening its database", async () => {
      const owner = await acquireGatewayLock({ env: process.env, port: 1, allowInTests: true });
      expect(owner).not.toBeNull();
      try {
        const result = await runCliProcessChild({
          nodeArgs: [
            ...resolveRuntimeWorkerArgv(resolveRuntimeWorkerUrl(adminStateOwnerFixtureEntrypoint)),
            "approvals",
            "native",
            "--stdin",
          ],
          env: { ...process.env, OPENCLAW_HOME: root },
          input: JSON.stringify({ operation: "commit", ...input() }),
          timeoutMs: 15_000,
        });
        expect(result.code).toBe(1);
        expect(result.stderr).toMatch(/No local (?:mutation|fallback)/u);
      } finally {
        await owner?.release();
      }
    });
  },
);
