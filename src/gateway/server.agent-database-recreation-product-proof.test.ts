import "./test-helpers.mocks.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import type { AgentsDeleteResult } from "../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { resolveAgentDir } from "../agents/agent-scope-config.js";
import {
  createApiKeyCredential,
  createAuthProfileStoreFixture,
} from "../agents/auth-profiles/credential-fixtures.test-support.js";
import { readAuthProfileJsonCellText } from "../agents/auth-profiles/sqlite-json.js";
import {
  acquireAuthProfileReadDatabase,
  closeAuthProfileReadPool,
} from "../agents/auth-profiles/sqlite-read-pool.js";
import { saveAuthProfileStore } from "../agents/auth-profiles/store-runtime.js";
import { loadConfig, writeConfigFile } from "../config/config.js";
import {
  loadSessionEntryReadOnly,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.sqlite-entry.js";
import { decodeAgentDatabaseReaderRequest } from "../infra/agent-database-readers.js";
import { isPathInside } from "../infra/path-guards.js";
import { readSqliteReaderDiagnosticsForPath } from "../infra/sqlite-reader-lifecycle.js";
import { createOwnedWorkerTaskPool } from "../infra/worker-task-pool.js";
import type {
  ResourceFixtureInput,
  ResourceFixtureReply,
} from "../infra/worker-task-pool.resources.test-support.js";
import { registerMemoryCapability } from "../plugins/memory-state.js";
import { disposePluginRegistryInstances, requireActivePluginRegistry } from "../plugins/runtime.js";
import { readAgentDeletionJournal } from "../state/agent-deletion-journal.js";
import { registerOpenClawAgentDatabase } from "../state/openclaw-agent-db-registry.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  closeOpenClawAgentDatabasesForTest,
  inspectOpenClawAgentDatabaseOwner,
  listOpenClawRegisteredAgentDatabases,
} from "../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { beginAgentDeletionJournal } from "../test-utils/agent-deletion-journal.js";
import { withEnvAsync } from "../test-utils/env.js";
import { acquireTestPortBlock } from "../test-utils/port-claims.js";
import type { GatewayClient } from "./client.js";
import { createGatewayMemoryCloseRegistryFactory } from "./server-close.memory.test-support.js";
import type { SessionsListResult } from "./session-utils.types.js";
import { connectGatewayClient, disconnectGatewayClient } from "./test-helpers.e2e.js";
import { installGatewayTestHooks, startTestGatewayServer, testState } from "./test-helpers.js";

const AGENT_ID = "recreated-agent";
const EXTERNAL_STATE_AGENT_ID = "external-state-agent";
const SESSION_KEY = `agent:${AGENT_ID}:product-proof`;
const SESSION_KEYS = [SESSION_KEY, `${SESSION_KEY}-second`];

async function expectSessionListPages(client: GatewayClient) {
  const first = await client.request<SessionsListResult>("sessions.list", {
    agentId: AGENT_ID,
    limit: 1,
  });
  const full = await client.request<SessionsListResult>("sessions.list", {
    agentId: AGENT_ID,
    limit: 100,
  });
  const next = await client.request<SessionsListResult>("sessions.list", {
    agentId: AGENT_ID,
    limit: 1,
    offset: 1,
  });
  expect(first).toMatchObject({ count: 1, totalCount: 2 });
  expect(full).toMatchObject({ count: 2, totalCount: 2 });
  expect(next).toMatchObject({ count: 1, totalCount: 2 });
  expect(new Set(full.sessions.map((row) => row.key))).toEqual(new Set(SESSION_KEYS));
  expect(new Set([...first.sessions, ...next.sessions].map((row) => row.key))).toEqual(
    new Set(SESSION_KEYS),
  );
}

installGatewayTestHooks();

describe("agent database recreation product proof", () => {
  it(
    "recreates and registers a deleted agent database through one real Gateway process",
    { timeout: 180_000 },
    async () => {
      const token = "agent-database-recreation-product-proof-token";
      testState.sessionStorePath = path.join(
        process.env.OPENCLAW_STATE_DIR!,
        "external",
        "agents",
        "{agentId}",
        "agent",
        "openclaw-agent.sqlite",
      );
      await writeConfigFile({ ...loadConfig(), session: { store: testState.sessionStorePath } });
      const portClaim = await acquireTestPortBlock({ offsets: [0, 1, 2, 3, 4] });
      const url = `ws://127.0.0.1:${portClaim.port}`;
      const server = await startTestGatewayServer(portClaim, {
        bind: "loopback",
        auth: { mode: "token", token },
        controlUiEnabled: false,
      });
      let client: GatewayClient | undefined;
      try {
        client = await connectGatewayClient({
          url,
          token,
          role: "operator",
          scopes: ["operator.admin", "operator.read", "operator.write"],
        });

        const workspace = path.join(
          process.env.OPENCLAW_STATE_DIR ?? process.cwd(),
          "workspace-recreated-agent",
        );
        const created = await client.request<{ agentId: string; ok: true }>("agents.create", {
          name: "Recreated Agent",
          workspace,
        });
        expect(created).toMatchObject({ agentId: AGENT_ID, ok: true });
        for (const key of SESSION_KEYS) {
          await expect(
            client.request("sessions.create", { agentId: AGENT_ID, key }),
          ).resolves.toMatchObject({ key });
        }
        await expectSessionListPages(client);
        expect(listOpenClawRegisteredAgentDatabases({ env: process.env })).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              agentId: AGENT_ID,
              path: testState.sessionStorePath.replace("{agentId}", AGENT_ID),
            }),
          ]),
        );

        const databasePath = testState.sessionStorePath.replace("{agentId}", AGENT_ID);
        const originalIdentity = await fs.stat(databasePath, { bigint: true });

        const readers = createOwnedWorkerTaskPool<ResourceFixtureInput, ResourceFixtureReply>({
          workerUrl: new URL(
            "../infra/worker-task-pool.resources.test-support.ts",
            import.meta.url,
          ),
          maxWorkers: 1,
        });
        const prepared = createDeferred();
        const releaseRead = createDeferred();
        const input = { database: { agentId: AGENT_ID, path: databasePath } };
        const pendingRead = readers.run(async () => {
          prepared.resolve();
          await releaseRead.promise;
          return input;
        }, {});
        try {
          await prepared.promise;
          await expect(
            client.request("agents.delete", { agentId: AGENT_ID, deleteFiles: false }),
          ).resolves.toMatchObject({ agentId: AGENT_ID, ok: true });
          expect((await fs.stat(databasePath, { bigint: true })).ino).toBe(originalIdentity.ino);
          releaseRead.resolve();
          const first = await pendingRead;
          expect(first.databaseFound).toBe(false);
          await readers.rotate();
          const replacement = await readers.run(input, {});
          expect(replacement.databaseFound).toBe(false);
          expect(replacement.threadId).not.toBe(first.threadId);
          let refusedRevival = false;
          const send: unknown = Object.getOwnPropertyDescriptor(
            Worker.prototype,
            "postMessage",
          )?.value;
          if (typeof send !== "function") {
            throw new Error("Worker postMessage implementation is unavailable");
          }
          const delivery = vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (
            this: Worker,
            ...args: Parameters<Worker["postMessage"]>
          ) {
            if (
              this.threadId === replacement.threadId &&
              isRecord(args[0]) &&
              args[0].closeResource === true &&
              typeof args[0].key === "string" &&
              decodeAgentDatabaseReaderRequest(args[0].key)?.kind === "revive"
            ) {
              refusedRevival = true;
              throw new Error("worker revival delivery failed");
            }
            return send.apply(this, args);
          });
          try {
            await expect(
              client.request("agents.create", { name: "Recreated Agent", workspace }),
            ).resolves.toMatchObject({ agentId: AGENT_ID, ok: true });
            expect(refusedRevival).toBe(true);
          } finally {
            delivery.mockRestore();
          }
          expect((await readers.run(input, {})).databaseFound).toBe(true);

          const staleAgentId = "shared-path-retired-agent";
          const survivorDir = resolveAgentDir(loadConfig(), AGENT_ID);
          const survivorPath = path.join(survivorDir, "openclaw-agent.sqlite");
          const survivorStore = createAuthProfileStoreFixture({
            "fixture:survivor": createApiKeyCredential(
              "fixture",
              "synthetic-shared-path-survivor-key",
            ),
          });
          saveAuthProfileStore(survivorStore, survivorDir);
          const survivorSession = {
            agentId: AGENT_ID,
            storePath: survivorPath,
            sessionKey: `agent:${AGENT_ID}:shared-path-survivor`,
            readConsistency: "latest" as const,
          };
          const survivorSessionId = "shared-path-survivor-session";
          replaceSessionEntrySync(survivorSession, {
            sessionId: survivorSessionId,
            updatedAt: 1,
          });
          // Recovery retains readers, but a live foreign writer must still block deletion.
          await closeOpenClawAgentDatabaseByPathAsync(survivorPath, AGENT_ID);
          const survivorIdentity = await fs.stat(survivorPath, { bigint: true });
          const survivorInput = {
            database: { agentId: AGENT_ID, path: survivorPath, readAuthStore: true },
          };
          const parentReader = acquireAuthProfileReadDatabase(survivorPath);
          expect(parentReader.status).toBe("readable");
          if (parentReader.status !== "readable") {
            throw new Error("Expected the surviving agent's retained auth reader");
          }
          try {
            const readParentStore = () =>
              JSON.parse(readAuthProfileJsonCellText(parentReader.db, "store", "agent") ?? "null");
            expect(readParentStore()).toEqual(survivorStore);
            expect(loadSessionEntryReadOnly(survivorSession)?.sessionId).toBe(survivorSessionId);
            // Recovery must remove this historical registration without fencing its new owner.
            registerOpenClawAgentDatabase({ agentId: staleAgentId, path: survivorPath });
            expect(listOpenClawRegisteredAgentDatabases()).toEqual(
              expect.arrayContaining([
                expect.objectContaining({ agentId: AGENT_ID, path: survivorPath }),
                expect.objectContaining({ agentId: staleAgentId, path: survivorPath }),
              ]),
            );
            beginAgentDeletionJournal({
              agentId: staleAgentId,
              operationId: "shared-path-recovery",
              agentDir: survivorDir,
              workspaceDir: workspace,
              sessionsDir: path.join(
                process.env.OPENCLAW_STATE_DIR!,
                "agents",
                staleAgentId,
                "sessions",
              ),
              deleteFiles: true,
            });
            expect(parentReader.db.isOpen).toBe(true);
            expect(readParentStore()).toEqual(survivorStore);
            const beforeRecovery = await readers.run(survivorInput, {});
            expect(beforeRecovery.databaseFound).toBe(true);
            expect(JSON.parse(beforeRecovery.authStore ?? "null")).toEqual(survivorStore);
            await expect(
              client.request("agents.delete", { agentId: staleAgentId, deleteFiles: true }),
            ).resolves.toMatchObject({ agentId: staleAgentId, ok: true, failed: [] });

            expect(parentReader.db.isOpen).toBe(true);
            expect(readParentStore()).toEqual(survivorStore);
            const afterRecovery = await readers.run(survivorInput, {});
            expect(afterRecovery.threadId).toBe(beforeRecovery.threadId);
            expect(afterRecovery.databaseFound).toBe(true);
            expect(JSON.parse(afterRecovery.authStore ?? "null")).toEqual(survivorStore);
            await readers.rotate();
            const survivorReplacement = await readers.run(survivorInput, {});
            expect(survivorReplacement.threadId).not.toBe(afterRecovery.threadId);
            expect(survivorReplacement.databaseFound).toBe(true);
            expect(JSON.parse(survivorReplacement.authStore ?? "null")).toEqual(survivorStore);
            expect(loadSessionEntryReadOnly(survivorSession)?.sessionId).toBe(survivorSessionId);
            expect((await fs.stat(survivorPath, { bigint: true })).ino).toBe(survivorIdentity.ino);
            expect(inspectOpenClawAgentDatabaseOwner(survivorPath)).toEqual({
              agentId: AGENT_ID,
              status: "owned",
            });
            expect(
              listOpenClawRegisteredAgentDatabases().filter((entry) => entry.path === survivorPath),
            ).toEqual([expect.objectContaining({ agentId: AGENT_ID, path: survivorPath })]);
            expect(readAgentDeletionJournal(staleAgentId)).toMatchObject({
              cleanupCompleted: true,
            });
          } finally {
            closeAuthProfileReadPool({ kind: "database", databasePath: survivorPath });
          }
        } finally {
          releaseRead.resolve();
          await readers.close();
          await pendingRead;
        }

        await expect(
          client.request("agents.delete", { agentId: AGENT_ID, deleteFiles: true }),
        ).resolves.toMatchObject({ agentId: AGENT_ID, ok: true });
        await expect(fs.stat(databasePath)).rejects.toMatchObject({ code: "ENOENT" });

        const recreated = await client.request<{ agentId: string; ok: true }>("agents.create", {
          name: "Recreated Agent",
          workspace,
        });
        expect(recreated).toMatchObject({ agentId: AGENT_ID, ok: true });
        for (const key of SESSION_KEYS) {
          await expect(
            client.request("sessions.create", { agentId: AGENT_ID, key }),
          ).resolves.toMatchObject({ key });
        }
        await expectSessionListPages(client);
        await expect(client.request("health", { probe: true })).resolves.toBeDefined();

        const recreatedIdentity = await fs.stat(databasePath, { bigint: true });
        expect({
          birthtimeNs: recreatedIdentity.birthtimeNs,
          dev: recreatedIdentity.dev,
          ino: recreatedIdentity.ino,
        }).not.toEqual({
          birthtimeNs: originalIdentity.birthtimeNs,
          dev: originalIdentity.dev,
          ino: originalIdentity.ino,
        });
        expect(inspectOpenClawAgentDatabaseOwner(databasePath)).toEqual({
          agentId: AGENT_ID,
          status: "owned",
        });
        expect(listOpenClawRegisteredAgentDatabases({ env: process.env })).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ agentId: AGENT_ID, path: databasePath }),
          ]),
        );
      } finally {
        if (client) {
          await disconnectGatewayClient(client);
        }
        await server.close({ reason: "agent database recreation product proof complete" });
        closeOpenClawAgentDatabasesForTest();
        closeOpenClawStateDatabaseForTest();
      }
    },
  );
});

describe("agent deletion product proof with a state dir outside home and the temp dir", () => {
  it(
    "moves the deleted agent's files to Trash through one real Gateway process",
    { timeout: 180_000 },
    async () => {
      // Volume-backed deployments keep OPENCLAW_STATE_DIR outside HOME and os.tmpdir()
      // (for example /data on Fly), which are fs-safe's default Trash roots.
      const realTmp = await fs.realpath(os.tmpdir());
      const tmpOverride = await fs.mkdtemp(path.join(realTmp, "openclaw-tmp-override-"));
      const stateDir = await fs.mkdtemp(path.join(realTmp, "openclaw-external-state-"));
      const token = "agent-delete-external-state-dir-token";
      try {
        await withEnvAsync(
          {
            OPENCLAW_STATE_DIR: stateDir,
            TMPDIR: tmpOverride,
            TMP: tmpOverride,
            TEMP: tmpOverride,
          },
          async () => {
            expect(isPathInside(await fs.realpath(os.homedir()), stateDir)).toBe(false);
            expect(isPathInside(await fs.realpath(os.tmpdir()), stateDir)).toBe(false);
            const portClaim = await acquireTestPortBlock({ offsets: [0, 1, 2, 3, 4] });
            const server = await startTestGatewayServer(portClaim, {
              bind: "loopback",
              auth: { mode: "token", token },
              controlUiEnabled: false,
            });
            let client: GatewayClient | undefined;
            try {
              client = await connectGatewayClient({
                url: `ws://127.0.0.1:${portClaim.port}`,
                token,
                role: "operator",
                scopes: ["operator.admin", "operator.read", "operator.write"],
              });
              const workspace = path.join(stateDir, "workspace-external-state-agent");
              await expect(
                client.request("agents.create", { name: "External State Agent", workspace }),
              ).resolves.toMatchObject({ agentId: EXTERNAL_STATE_AGENT_ID, ok: true });
              await fs.writeFile(path.join(workspace, "NOTES.md"), "keep me in Trash\n");
              await client.request("sessions.create", {
                agentId: EXTERNAL_STATE_AGENT_ID,
                key: `agent:${EXTERNAL_STATE_AGENT_ID}:main`,
              });
              await client.request("secrets.reload", {});
              const databasePath = resolveOpenClawAgentSqlitePath({
                agentId: EXTERNAL_STATE_AGENT_ID,
                env: process.env,
              });
              const memoryConfig = {
                ...loadConfig(),
                memory: {
                  search: {
                    provider: "fixture-embedding",
                    model: "synthetic-embedding",
                    fallback: "none" as const,
                    store: { vector: { enabled: false } },
                  },
                },
              };
              let memoryCloses = 0;
              const createMemory = await createGatewayMemoryCloseRegistryFactory(memoryConfig);
              const memory = createMemory(async () => {
                memoryCloses += 1;
              });
              const registry = requireActivePluginRegistry();
              const priorMemoryCapabilities = [...registry.memoryCapabilities];
              registerMemoryCapability("memory-fixture", { runtime: memory.runtime });
              let result: AgentsDeleteResult;
              try {
                const opened = await memory.runtime.getMemorySearchManager({
                  cfg: memoryConfig,
                  agentId: EXTERNAL_STATE_AGENT_ID,
                });
                expect(opened.manager, opened.error).not.toBeNull();
                await expect(opened.manager!.probeEmbeddingAvailability()).resolves.toMatchObject({
                  ok: true,
                });
                const survivor = await memory.runtime.getMemorySearchManager({
                  cfg: memoryConfig,
                  agentId: "main",
                });
                expect(survivor.manager, survivor.error).not.toBeNull();
                await expect(survivor.manager!.probeEmbeddingAvailability()).resolves.toMatchObject(
                  {
                    ok: true,
                  },
                );
                result = await client.request<AgentsDeleteResult>("agents.delete", {
                  agentId: EXTERNAL_STATE_AGENT_ID,
                  deleteFiles: true,
                });
                expect(memoryCloses).toBe(1);
                expect(survivor.manager!.status().dbPath).toBe(
                  resolveOpenClawAgentSqlitePath({ agentId: "main" }),
                );
              } finally {
                registry.memoryCapabilities = priorMemoryCapabilities;
                await memory.runtime.closeAllMemorySearchManagers?.();
                await disposePluginRegistryInstances(memory.registry);
              }
              expect(readSqliteReaderDiagnosticsForPath(databasePath).connections).toEqual([]);

              // Database files are removed by the database-owned deletion first; the
              // workspace and session directories are what reach Trash here.
              expect(result).toMatchObject({
                agentId: EXTERNAL_STATE_AGENT_ID,
                ok: true,
                failed: [],
              });
              expect(result.removed).toEqual(
                expect.arrayContaining([{ path: workspace, method: "trash" }]),
              );
              await expect(fs.stat(workspace)).rejects.toMatchObject({ code: "ENOENT" });
            } finally {
              if (client) {
                await disconnectGatewayClient(client);
              }
              await server.close({ reason: "agent delete external state dir test complete" });
            }
          },
        );
      } finally {
        closeOpenClawAgentDatabasesForTest();
        closeOpenClawStateDatabaseForTest();
        await fs.rm(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
        await fs.rm(tmpOverride, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
      }
    },
  );
});
