import "../server-start.js";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { getEnvironmentData } from "node:worker_threads";
import { Client } from "pg";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createCliProcessFixture } from "../../cli/isolated-process-fixture.test-support.js";
import type { CronJob } from "../../cron/types.js";
import { getDatabaseEngineSelection } from "../../infra/database-engine/context.js";
import { resetDatabaseEngineSelectionForTest } from "../../infra/database-engine/context.test-support.js";
import { readBackupEngine, type BackupEngine } from "../../snapshot/database-backup.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { readAgentDeletionJournal } from "../../test-utils/agent-deletion-journal.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { acquireTestPortBlock } from "../../test-utils/port-claims.js";
import { startGatewayServer } from "../server.js";
import { connectGatewayClient, disconnectGatewayClient } from "../test-helpers.e2e.js";
import { deletionGatewayEnv } from "./agents-delete.fixture.test-support.js";

const modes = [false, true, "offline CLI"] as const;
const configured = getEnvironmentData("openclaw.test.state.conformance.connection");
const postgresConnection = typeof configured === "string" ? configured : undefined;
type PostgresIdentity = Extract<BackupEngine, { engine: "postgres" }>;

// Each case closes its Gateway and fixture stores before the next boot selection.
beforeEach(resetDatabaseEngineSelectionForTest);
afterEach(resetDatabaseEngineSelectionForTest);

async function preserveDetachedState(mode: (typeof modes)[number], connection?: string) {
  const migrationHeld = mode !== false;
  const prefix = `detach_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const postgresEnv = connection ? { OPENCLAW_DETACH_TEST_DSN: connection } : {};
  await withOpenClawTestState(
    { label: "agent-detach-rpc", env: { ...deletionGatewayEnv, ...postgresEnv } },
    async (state) => {
      await using cleanup = new AsyncDisposableStack();
      const identities = new Map<string, PostgresIdentity>();
      const started = performance.now();
      let previous = started;
      const stage = (name: string) => {
        if (!connection) {
          return;
        }
        const now = performance.now();
        process.stderr.write(
          `${JSON.stringify({
            fixture: "offline-detach-postgres",
            prefix,
            stage: name,
            elapsedMs: Math.round(now - started),
            stageMs: Math.round(now - previous),
            identities: [...identities.values()],
          })}\n`,
        );
        previous = now;
      };
      stage("fixture allocated");
      const readAgentEngine = (agentId: string) => {
        const identity = readBackupEngine(
          resolveOpenClawAgentSqlitePath({ agentId, env: state.env }),
        );
        if (connection) {
          expect(identity.engine).toBe("postgres");
          if (identity.engine !== "postgres") {
            throw new Error("Expected the Native-created PostgreSQL agent anchor");
          }
          expect(identity.namespace).toBe(
            `${prefix}_agent_${identity.storeId.replaceAll("-", "").slice(0, 16)}`,
          );
          identities.set(identity.namespace, identity);
        }
        return identity;
      };
      if (connection) {
        const database = new Client({ connectionString: connection });
        cleanup.defer(() => database.end());
        await database.connect();
        expect((await database.query("SELECT current_database() AS name")).rows).toEqual([
          { name: decodeURIComponent(new URL(connection).pathname.slice(1)) },
        ]);
        expect(
          (
            await database.query("SELECT nspname FROM pg_namespace WHERE left(nspname, $1) = $2", [
              prefix.length + 1,
              `${prefix}_`,
            ])
          ).rows,
        ).toEqual([]);
        stage("TEST database and unused prefix verified");
        cleanup.defer(async () => {
          stage("namespace cleanup started");
          // Only fixture-created, anchor-recorded namespaces with the exact Native identity.
          for (const agentId of ["keeper", "traveler"]) {
            try {
              await fs.stat(resolveOpenClawAgentSqlitePath({ agentId, env: state.env }));
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                continue;
              }
              throw error;
            }
            readAgentEngine(agentId);
          }
          for (const identity of identities.values()) {
            expect(identity.namespace).toMatch(new RegExp(`^${prefix}_agent_[a-f0-9]{16}$`, "u"));
            expect(
              (
                await database.query(
                  `SELECT store_id FROM "${identity.namespace}".openclaw_schema_meta WHERE store = 'agent'`,
                )
              ).rows,
            ).toEqual([{ store_id: identity.storeId }]);
            await database.query(`DROP SCHEMA "${identity.namespace}" CASCADE`);
          }
          stage("namespace cleanup completed");
        });
      }
      const token = "synthetic-detach-test-token";
      await state.writeConfig({
        ...(connection
          ? {
              database: {
                engine: "sqlite",
                families: { agent: { engine: "postgres" } },
                postgres: {
                  connection: {
                    source: "env",
                    provider: "default",
                    id: "OPENCLAW_DETACH_TEST_DSN",
                  },
                  schemaPrefix: prefix,
                },
              },
            }
          : {}),
        gateway: { mode: "local", auth: { mode: "token", token } },
        agents: {
          ownership: "explicit",
          defaults: { skipBootstrap: true },
          entries: {
            keeper: { workspace: state.workspaceDir },
            traveler: { workspace: state.path("traveler-workspace") },
          },
        },
        plugins: { enabled: false },
      });
      const claim = await acquireTestPortBlock({ offsets: [0, 2] });
      let boots = 0;
      const start = () => {
        stage(`Gateway ${++boots} starting`);
        return startGatewayServer(claim.port, {
          bind: "loopback",
          auth: { mode: "token", token },
          controlUiEnabled: false,
          hotReloadRecovery: () => {
            throw new Error("Agent detach unexpectedly required a Gateway recovery restart");
          },
        });
      };
      const connect = () =>
        connectGatewayClient({
          url: `ws://127.0.0.1:${claim.port}`,
          token,
          scopes: ["operator.admin"],
        });
      let server = await start();
      let client: Awaited<ReturnType<typeof connect>> | undefined;
      try {
        await server.startupSettled;
        stage("initial Gateway ready");
        expect(getDatabaseEngineSelection()?.effectiveEngines).toMatchObject({
          state: "sqlite",
          agent: connection ? "postgres" : "sqlite",
        });
        client = await connect();
        const key = "agent:traveler:handoff";
        const created = await client.request<{ sessionId: string }>("sessions.create", {
          agentId: "traveler",
          key,
        });
        await client.request("chat.inject", {
          sessionKey: key,
          message: "Preserve this transcript across detach.",
        });
        const originalHistory = await client.request<{ sessionId: string; messages: unknown[] }>(
          "chat.history",
          { sessionKey: key },
        );
        expect(originalHistory.sessionId).toBe(created.sessionId);
        const job = await client.request<CronJob>("cron.add", {
          name: "Synthetic traveler schedule",
          agentId: "traveler",
          enabled: true,
          schedule: { kind: "every", everyMs: 3_600_000 },
          sessionTarget: "isolated",
          wakeMode: "next-heartbeat",
          payload: { kind: "agentTurn", message: "Synthetic schedule", toolsAllow: [] },
          delivery: { mode: "none" },
        });
        const originalEngine = connection ? readAgentEngine("traveler") : undefined;
        if (connection) {
          expect(readBackupEngine(state.statePath("state", "openclaw.sqlite"))).toEqual({
            engine: "sqlite",
          });
        }
        if (migrationHeld) {
          await client.request("cron.migration", {
            operationId: "traveler-handoff",
            phase: "hold",
            agentIds: ["traveler"],
          });
          await client.request("cron.migration", {
            operationId: "traveler-handoff",
            phase: "export",
          });
        }
        stage("session, transcript, store identity, job and migration hold seeded");
        const expectSourceCronDenied = async () => {
          const result = await client!.request<{ ran: boolean }>("cron.run", {
            id: job.id,
            mode: "force",
          });
          expect(result).toMatchObject({ ok: true, ran: false });
        };
        await expect(
          client.request("agents.detach", { agentId: "traveler", deleteFiles: true }),
        ).rejects.toThrow("invalid agents.detach params");
        if (mode === "offline CLI") {
          const cli = createCliProcessFixture(state.root, {
            ...state.env,
            OPENCLAW_TEST_RUNTIME_LOG: "1",
          });
          const args = ["agents", "detach", "traveler", "--force", "--json"];
          const attachedConfig = await fs.readFile(state.configPath, "utf8");
          stage("live CLI refusal started");
          const refused = await cli.run(args);
          const refusalDiagnostic = JSON.stringify(refused);
          expect(refused.code, refusalDiagnostic).toBe(1);
          expect(refused.stdout.trim(), refusalDiagnostic).not.toBe("");
          expect(JSON.parse(refused.stdout)).toMatchObject({
            ok: false,
            error: {
              message: expect.stringMatching(
                /exclusive offline state ownership|Agent traveler database is still open in another process; stop the Gateway and other OpenClaw processes/u,
              ),
            },
          });
          expect(await fs.readFile(state.configPath, "utf8")).toBe(attachedConfig);
          if (connection) {
            expect(readAgentEngine("traveler")).toEqual(originalEngine);
          }
          const attachedHistory = await client.request<{
            sessionId: string;
            messages: unknown[];
          }>("chat.history", { sessionKey: key });
          expect(attachedHistory.sessionId).toBe(created.sessionId);
          expect(attachedHistory.messages).toEqual(originalHistory.messages);
          expect(attachedHistory.messages).toEqual([
            expect.objectContaining({
              role: "assistant",
              content: [{ type: "text", text: "Preserve this transcript across detach." }],
            }),
          ]);
          stage("live CLI refusal and unchanged state verified");
          await disconnectGatewayClient(client);
          client = undefined;
          await server.close();
          stage("source Gateway closed");
          stage("offline CLI detach started");
          const detached = await cli.run(args);
          const detachDiagnostic = JSON.stringify({
            ...detached,
            ...(detached.stdout.trim()
              ? {}
              : {
                  journal: readAgentDeletionJournal("traveler", { env: state.env }),
                  config: JSON.parse(await fs.readFile(state.configPath, "utf8")),
                }),
          });
          expect(detached.code, detachDiagnostic).toBe(0);
          expect(detached.stdout.trim(), detachDiagnostic).not.toBe("");
          expect(JSON.parse(detached.stdout)).toMatchObject({
            agentId: "traveler",
            detached: true,
            storePreserved: true,
          });
          if (connection) {
            expect(readAgentEngine("traveler")).toEqual(originalEngine);
          }
          stage("offline CLI receipt and retained store identity verified");
          server = await start();
          await server.startupSettled;
          stage("detached Gateway ready");
          client = await connect();
        } else {
          await expect(
            client.request("agents.detach", { agentId: "traveler" }),
          ).resolves.toMatchObject({ ok: true, agentId: "traveler" });
        }
        await expect(
          client.request("chat.inject", { sessionKey: key, message: "Refused source write" }),
        ).rejects.toThrow();
        await expectSourceCronDenied();
        stage("detached source write and scheduler fences verified");
        if (!connection) {
          // SQLite covers the extra detached restart and unrelated keeper session.
          await client.request("sessions.create", {
            agentId: "keeper",
            key: "agent:keeper:unaffected",
          });
          await disconnectGatewayClient(client);
          client = undefined;
          await server.close();
          server = await start();
          await server.startupSettled;
          client = await connect();
          await expect(
            client.request("chat.inject", { sessionKey: key, message: "Refused after restart" }),
          ).rejects.toThrow();
          await expectSourceCronDenied();
        }
        await client.request("agents.create", {
          name: "traveler",
          workspace: state.path("traveler-workspace"),
        });
        stage("retained agent reattached");
        if (connection) {
          await disconnectGatewayClient(client);
          client = undefined;
          await server.close();
          server = await start();
          await server.startupSettled;
          stage("reattached Gateway ready");
          client = await connect();
          expect(readAgentEngine("traveler")).toEqual(originalEngine);
        }
        if (migrationHeld) {
          await expect(
            client.request("cron.update", { id: job.id, patch: { name: "Still held" } }),
          ).rejects.toThrow("is held for migration traveler-handoff");
          await client.request("cron.migration", {
            operationId: "traveler-handoff",
            phase: "resume",
          });
        }
        const retained = await client.request<{ jobs: CronJob[] }>("cron.list", {
          includeDisabled: true,
        });
        expect(retained.jobs).toContainEqual(
          expect.objectContaining({
            id: job.id,
            agentId: job.agentId,
            name: job.name,
            enabled: job.enabled,
            schedule: job.schedule,
            sessionTarget: job.sessionTarget,
            wakeMode: job.wakeMode,
            payload: job.payload,
            delivery: job.delivery,
          }),
        );
        const history = await client.request<{ sessionId: string; messages: unknown[] }>(
          "chat.history",
          { sessionKey: key },
        );
        expect(history.sessionId).toBe(created.sessionId);
        expect(history.messages).toEqual(originalHistory.messages);
        expect(history.messages).toEqual([
          expect.objectContaining({
            role: "assistant",
            content: [{ type: "text", text: "Preserve this transcript across detach." }],
          }),
        ]);
        stage("original store identity, complete history, job and hold continuity verified");
        await expect(
          client.request("chat.inject", { sessionKey: key, message: "Adopted agent can write" }),
        ).resolves.toMatchObject({ ok: true });
        await client.request("agents.delete", { agentId: "traveler", deleteFiles: false });
        const deleted = await client.request<{ jobs: { id: string; agentId?: string }[] }>(
          "cron.list",
          {
            includeDisabled: true,
          },
        );
        expect(deleted.jobs.filter((entry) => entry.agentId === "traveler")).toEqual([]);
        stage("reattached write and destructive deletion control verified");
      } finally {
        if (client) {
          await disconnectGatewayClient(client);
        }
        await server.close();
        await claim.release();
        stage("final Gateway closed");
      }
    },
  );
}

it.each(modes)("preserves detached state (held: %s)", async (mode) => {
  await preserveDetachedState(mode);
});

it.skipIf(!postgresConnection)(
  "preserves detached state (offline CLI PostgreSQL agent)",
  async () => {
    await preserveDetachedState("offline CLI", postgresConnection);
  },
);
