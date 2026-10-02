/**
 * Real-trigger proof for the `sessions.abort` state-contention fix (PR #159282).
 *
 * The contention is not injected: since #157413, ordinary state writes are
 * transactions on actual SQLite databases, so production contention is a foreign
 * process holding write transactions on the databases Stop must touch. A child
 * process holds `BEGIN EXCLUSIVE` on both the shared-state `openclaw.sqlite` and
 * the agent database while a Control UI client calls `sessions.abort` for a
 * session with a live run.
 *
 * Both files are locked because main's read path moved under #161124: session
 * reads are served from the row-projection/read-worker tier, which reads WAL
 * snapshots and never contends with a foreign writer. The live contention
 * surface is the abort's own state persistence, and that write can land in
 * either database depending on which session-store tier the run takes.
 *
 * Expected on the fixed head: the RPC rejects with the typed
 * `UNAVAILABLE` / `details.errorKind === "state_contention"` shape.
 * Expected on unmodified base production: the raw SQLite lock error escapes the
 * handler unclassified instead.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer, type Server, type ServerResponse } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { stopChildProcess } from "../../../test/helpers/stop-child-process.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../../config/config.js";
import { clearSessionStoreCacheForTest } from "../../config/sessions/store-writer-state.js";
import {
  closeOpenClawAgentDatabasesForTest,
  closeOpenClawAgentDatabasesAsync,
} from "../../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { acquireTestPortBlock } from "../../test-utils/port-claims.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../../utils/message-channel.js";
import { disconnectGatewayClient, startGatewayWithClient } from "../test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "../test-openai-responses-model.js";

const GATEWAY_TOKEN = "sessions-abort-live-proof-token";
const SESSION_KEY = "agent:main:sessions-abort-live-proof";

let state: OpenClawTestState | undefined;
let providerServer: Server | undefined;
let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
let lockChild: ChildProcess | undefined;

/**
 * Releases the foreign write transaction and reports whether the child rolled
 * back and exited by itself. Only an unresponsive child is killed, so a
 * still-held lock cannot hide behind the five-second exit timeout.
 */
async function releaseLockChild(): Promise<boolean> {
  const child = lockChild;
  lockChild = undefined;
  if (!child) {
    return true;
  }
  if (child.exitCode !== null) {
    return true;
  }
  if (child.connected) {
    child.send({ release: true });
  }
  const exitedOnRelease = await once(child, "close", { signal: AbortSignal.timeout(5_000) }).then(
    () => true,
    () => false,
  );
  if (!exitedOnRelease) {
    await stopChildProcess(child, 5_000).catch(() => undefined);
  }
  return exitedOnRelease;
}

/**
 * Holds a foreign write transaction on the real state database from a separate
 * OS process. The journal mode is left untouched: the database stays in WAL,
 * exactly as the Gateway runs it.
 */
async function holdStateDatabaseWriteLock(databasePaths: string[]): Promise<void> {
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `
        import { DatabaseSync } from 'node:sqlite';
        const databases = process.argv.slice(1).map((databasePath) => {
          const db = new DatabaseSync(databasePath);
          db.exec('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE');
          return db;
        });
        process.send({ ready: true });
        process.once('message', () => {
          for (const db of databases) {
            db.exec('ROLLBACK');
            db.close();
          }
          process.disconnect();
        });
      `,
      ...databasePaths,
    ],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
  lockChild = child;
  const [ready] = await once(child, "message", { signal: AbortSignal.timeout(10_000) });
  expect(ready).toEqual({ ready: true });
}

afterEach(async () => {
  await releaseLockChild();
  if (gateway) {
    await disconnectGatewayClient(gateway.client).catch(() => undefined);
    await gateway.server.close().catch(() => undefined);
    gateway = undefined;
  }
  if (providerServer?.listening) {
    const server = providerServer;
    providerServer = undefined;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
  await closeOpenClawAgentDatabasesAsync().catch(() => undefined);
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  clearSessionStoreCacheForTest();
  clearRuntimeConfigSnapshot();
  clearConfigCache();
  await state?.cleanup();
  state = undefined;
});

it(
  "sessions.abort keeps the typed state-contention outcome under a foreign lock",
  { timeout: 150_000 },
  async () => {
    const testState = await createOpenClawTestState({
      layout: "home",
      prefix: "openclaw-sessions-abort-live-",
      env: {
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        OPENCLAW_SKIP_PROVIDERS: "1",
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      },
    });
    state = testState;

    // A provider that accepts the turn and then never completes it: the run stays
    // active for the whole proof window, so Stop has a real live run to cancel.
    const stalledResponses: ServerResponse[] = [];
    providerServer = createServer((request, response) => {
      request.resume();
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      response.write(
        `data: ${JSON.stringify({
          type: "response.output_item.added",
          output_index: 0,
          item: {
            type: "message",
            id: "stalled-proof-item",
            role: "assistant",
            status: "in_progress",
            content: [],
          },
        })}\n\n`,
      );
      stalledResponses.push(response);
    });
    await new Promise<void>((resolve, reject) => {
      providerServer?.once("error", reject);
      providerServer?.listen(0, "127.0.0.1", resolve);
    });
    const providerAddress = providerServer.address();
    if (!providerAddress || typeof providerAddress === "string") {
      throw new Error("proof provider did not bind a loopback port");
    }
    const provider = buildMockOpenAiResponsesProvider(
      `http://127.0.0.1:${providerAddress.port}/v1`,
    );

    const portClaim = await acquireTestPortBlock({ offsets: [0, 1, 2, 3, 4] });
    gateway = await startGatewayWithClient({
      portClaim,
      origin: `http://127.0.0.1:${portClaim.port}`,
      cfg: {
        agents: {
          defaults: {
            workspace: testState.workspaceDir,
            skipBootstrap: true,
            model: { primary: provider.modelRef },
          },
          entries: { main: { default: true } },
        },
        models: { mode: "replace", providers: { [provider.providerId]: provider.config } },
        gateway: { auth: { mode: "token", token: GATEWAY_TOKEN } },
      },
      configPath: testState.configPath,
      token: GATEWAY_TOKEN,
      clientName: GATEWAY_CLIENT_NAMES.CONTROL_UI,
      mode: GATEWAY_CLIENT_MODES.WEBCHAT,
      clientDisplayName: "sessions-abort-live-proof",
      // The Control UI operator carries admin; the session-write scope is present
      // because it is the documented narrow alternative for sessions.abort.
      scopes: ["operator.admin", "operator.sessions.write"],
    });

    const started = await gateway.client.request<{ runId?: string; status?: string }>("chat.send", {
      sessionKey: SESSION_KEY,
      message: "Hold this turn open until the proof stops it.",
      deliver: false,
      idempotencyKey: "sessions-abort-live-proof-run",
    });
    expect(started.status).toBe("started");
    const runId = started.runId;
    expect(runId).toBeTruthy();
    const waiting = await gateway.client.request<{ status?: string }>(
      "agent.wait",
      { runId, timeoutMs: 250 },
      { timeoutMs: 10_000 },
    );
    // "timeout" proves the run is still live at the moment Stop is sent.
    expect(waiting.status).toBe("timeout");

    // Drop the Gateway's own agent database handles so the lock child can take
    // exclusive write transactions on every database Stop may touch.
    await closeOpenClawAgentDatabasesAsync();

    // Resolve the real shared-state and agent databases the Gateway serves, then
    // hand both write locks to a child process so no in-process connection can
    // absorb the contention. Reads alone no longer contend on main: the
    // row-projection/read-worker tier serves WAL snapshots under a foreign
    // writer, so the lock pair must cover the abort's persistence write
    // whichever store tier it lands in.
    const databasePath = resolveOpenClawStateSqlitePath(testState.env);
    const agentDatabasePath = resolveOpenClawAgentSqlitePath({
      agentId: "main",
      env: testState.env,
    });
    await holdStateDatabaseWriteLock([databasePath, agentDatabasePath]);

    // The child owns both write locks: a fresh connection cannot start a write
    // transaction on either database while it holds them.
    for (const lockedPath of [databasePath, agentDatabasePath]) {
      const probe = new DatabaseSync(lockedPath);
      try {
        probe.exec("PRAGMA busy_timeout = 0");
        expect(() => probe.exec("BEGIN IMMEDIATE")).toThrowError(/database is locked/);
      } finally {
        probe.close();
      }
    }

    const outcome = await gateway.client
      .request("sessions.abort", { key: SESSION_KEY, runId }, { timeoutMs: 30_000 })
      .then(
        (payload) => ({ rpc: "resolved" as const, payload }),
        (error: unknown) => ({
          rpc: "rejected" as const,
          name: (error as Error)?.name,
          code: (error as { code?: string })?.code,
          details: (error as { details?: unknown })?.details,
          message: (error as Error)?.message,
        }),
      );
    console.info(`SESSIONS_ABORT_CONTENTION_LIVE ${JSON.stringify(outcome)}`);

    // The child must roll back over IPC and exit by itself; a kill here would
    // hide a lock that is still held and burn the full exit timeout.
    expect(await releaseLockChild()).toBe(true);
    for (const response of stalledResponses) {
      response.destroy();
    }

    expect(outcome).toMatchObject({
      rpc: "rejected",
      code: "UNAVAILABLE",
      details: { errorKind: "state_contention" },
      message: expect.stringContaining("SQLite transaction admission remained busy"),
    });
  },
);
