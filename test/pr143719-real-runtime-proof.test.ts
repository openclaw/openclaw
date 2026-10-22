import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
/** Real Gateway/WebSocket + SQLite proof for PR #143719. */
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test } from "vitest";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../src/config/config.js";
import { replaceSessionEntrySync } from "../src/config/sessions/session-accessor.js";
import { clearSessionStoreCacheForTest } from "../src/config/sessions/store-writer-state.js";
import {
  disconnectGatewayClient,
  startGatewayWithClient,
} from "../src/gateway/test-helpers.e2e.js";
import {
  openOpenClawAgentDatabase,
  closeOpenClawAgentDatabasesForTest,
} from "../src/state/openclaw-agent-db.js";

const TOKEN = "pr143719-proof-token";
const envKeys = [
  "HOME",
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_GATEWAY_TOKEN",
  "OPENCLAW_SKIP_CHANNELS",
  "OPENCLAW_SKIP_GMAIL_WATCHER",
  "OPENCLAW_SKIP_CRON",
  "OPENCLAW_SKIP_CANVAS_HOST",
  "OPENCLAW_SKIP_BROWSER_CONTROL_SERVER",
  "OPENCLAW_SKIP_PROVIDERS",
  "OPENCLAW_BUNDLED_PLUGINS_DIR",
  "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
] as const;

const old = Date.now() - 31 * 24 * 60 * 60 * 1000;
const parent = "agent:main:dashboard:parent";
const fresh = "agent:main:dashboard:fresh";
const existing = "agent:main:dashboard:existing";
const stale = "agent:main:dashboard:stale";
const ordinary = "agent:main:subagent:ordinary";

const snapshots: string[] = [];
let tempHome: string | undefined;
const initialEnv = new Map<string, string | undefined>(
  envKeys.map((key) => [key, process.env[key]]),
);

afterEach(async () => {
  closeOpenClawAgentDatabasesForTest();
  clearRuntimeConfigSnapshot();
  clearConfigCache();
  clearSessionStoreCacheForTest();
  if (tempHome) await fs.rm(tempHome, { recursive: true, force: true });
  tempHome = undefined;
});

function record(label: string, value: unknown) {
  snapshots.push(`${label}: ${JSON.stringify(value)}\n`);
}

test(
  "proves dashboard-child pin persistence through the real Gateway and SQLite",
  { timeout: 120_000 },
  async () => {
    snapshots.length = 0;
    const previousEnv = new Map<string, string | undefined>(
      envKeys.map((key) => [key, process.env[key]]),
    );
    try {
      tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-pr143719-proof-"));
      const stateDir = path.join(tempHome, ".openclaw");
      const configPath = path.join(stateDir, "openclaw.json");
      const workspace = path.join(tempHome, "workspace");
      await fs.mkdir(workspace, { recursive: true });
      const env: Record<string, string> = {
        HOME: tempHome,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_GATEWAY_TOKEN: TOKEN,
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        OPENCLAW_SKIP_PROVIDERS: "1",
        OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(tempHome, "plugins"),
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      };
      for (const [key, value] of Object.entries(env)) process.env[key] = value;
      const sqlitePath = path.join(stateDir, "agents", "main", "sessions", "sessions.sqlite");
      const cfg = {
        agents: {
          defaults: { workspace, skipBootstrap: true },
          entries: { main: { default: true } },
        },
        session: { store: sqlitePath },
        gateway: { auth: { mode: "token", token: TOKEN } },
      };
      const seedEntries = {
        ["agent:main:main"]: { sessionId: "root", updatedAt: Date.now() },
        [parent]: { sessionId: "parent", updatedAt: Date.now(), boardFace: "dashboard" },
        [fresh]: {
          sessionId: "fresh",
          updatedAt: Date.now(),
          boardFace: "dashboard",
          parentSessionKey: parent,
        },
        [existing]: {
          sessionId: "existing",
          updatedAt: Date.now(),
          boardFace: "dashboard",
          parentSessionKey: parent,
          pinnedAt: Date.now() - 10_000,
        },
        [stale]: {
          sessionId: "stale",
          updatedAt: old,
          boardFace: "dashboard",
          parentSessionKey: parent,
          pinnedAt: old,
        },
        [ordinary]: { sessionId: "ordinary", updatedAt: Date.now(), spawnedBy: parent },
      };
      for (const [sessionKey, entry] of Object.entries(seedEntries))
        replaceSessionEntrySync(
          { agentId: "main", env: process.env, sessionKey, storePath: sqlitePath },
          entry,
        );
      const sqlitePathOwner = openOpenClawAgentDatabase({
        agentId: "main",
        env: process.env,
        path: sqlitePath,
      }).path;
      const sqlite = new DatabaseSync(sqlitePathOwner, { readOnly: true });
      record("sqlite.before", {
        basename: path.basename(sqlitePathOwner),
        sessionRows: (
          sqlite
            .prepare("SELECT COUNT(*) AS count FROM session_nodes WHERE session_key IN (?, ?, ?)")
            .get(fresh, existing, stale) as { count: number }
        ).count,
      });
      sqlite.close();

      const started = await startGatewayWithClient({
        cfg,
        configPath,
        token: TOKEN,
        clientDisplayName: "pr143719-proof",
      });
      let gateway = started;
      try {
        const freshPatch = await gateway.client.request<{
          ok: boolean;
          entry?: { pinnedAt?: number };
        }>("sessions.patch", { key: fresh, pinned: true });
        record("fresh-child-pin", {
          accepted: freshPatch.ok,
          pinned: typeof freshPatch.entry?.pinnedAt === "number",
        });
        expect(freshPatch.ok).toBe(true);
        let ordinaryRejected = false;
        let ordinaryError = "";
        try {
          await gateway.client.request("sessions.patch", { key: ordinary, pinned: true });
        } catch (error) {
          ordinaryRejected = true;
          ordinaryError = error instanceof Error ? error.message : "request rejected";
        }
        record("ordinary-child-pin", {
          accepted: false,
          rejected: ordinaryRejected,
          error: ordinaryError,
        });
        expect(ordinaryRejected).toBe(true);
        const listed = await gateway.client.request<{
          sessions: Array<{ key: string; pinned?: boolean }>;
        }>("sessions.list", {});
        record("shared-pin-metadata-projection", {
          pinnedKeys: listed.sessions.filter((s) => s.pinned).map((s) => s.key),
        });
        expect(listed.sessions.filter((s) => s.pinned).map((s) => s.key)).toEqual([
          fresh,
          existing,
          stale,
        ]);
      } finally {
        await disconnectGatewayClient(gateway.client);
        await gateway.server.close();
      }

      gateway = await startGatewayWithClient({
        cfg,
        configPath,
        token: TOKEN,
        clientDisplayName: "pr143719-proof-restart",
      });
      try {
        const afterRestart = await gateway.client.request<{
          sessions: Array<{ key: string; pinned?: boolean }>;
        }>("sessions.list", {});
        const pinnedAfterRestart = afterRestart.sessions.filter((s) => s.pinned).map((s) => s.key);
        record("reload-restart-persistence", { pinnedKeys: pinnedAfterRestart });
        expect(pinnedAfterRestart).toEqual([fresh, existing, stale]);
        const cleanup = await gateway.client.request<Record<string, unknown>>("sessions.cleanup", {
          enforce: true,
          fixMissing: false,
        });
        const afterCleanup = await gateway.client.request<{
          sessions: Array<{ key: string; pinned?: boolean }>;
        }>("sessions.list", {});
        const staleAfterCleanup = afterCleanup.sessions.find((s) => s.key === stale);
        const redactedCleanup = {
          ...cleanup,
          storePath:
            typeof cleanup.storePath === "string" ? path.basename(cleanup.storePath) : undefined,
        };
        record("stale-pin-maintenance", {
          cleanupAccepted: true,
          cleanup: redactedCleanup,
          staleStillPresent: Boolean(staleAfterCleanup),
          staleStillPinned: staleAfterCleanup?.pinned === true,
        });
        expect(staleAfterCleanup?.pinned).toBe(true);
      } finally {
        await disconnectGatewayClient(gateway.client);
        await gateway.server.close();
      }

      const persistedDb = new DatabaseSync(sqlitePathOwner, { readOnly: true });
      const persistedRows = persistedDb
        .prepare(
          "SELECT session_key, entry_json FROM session_nodes WHERE session_key IN (?, ?, ?, ?)",
        )
        .all(fresh, existing, stale, ordinary) as Array<{
        session_key: string;
        entry_json: string;
      }>;
      const persisted = new Map(
        persistedRows.map((row) => [
          row.session_key,
          JSON.parse(row.entry_json) as { pinnedAt?: number },
        ]),
      );
      record("sqlite.persistence", {
        freshPinned: typeof persisted.get(fresh)?.pinnedAt === "number",
        existingPinned: typeof persisted.get(existing)?.pinnedAt === "number",
        stalePinned: typeof persisted.get(stale)?.pinnedAt === "number",
        ordinaryPinned: typeof persisted.get(ordinary)?.pinnedAt === "number",
      });
      persistedDb.close();
      await fs.mkdir(path.join(process.cwd(), ".artifacts"), { recursive: true });
      await fs.writeFile(
        path.join(process.cwd(), ".artifacts", "pr-143719-gateway-runtime-proof.md"),
        [
          "# PR #143719 redacted runtime proof",
          "",
          `- head: ${process.env.PR143719_HEAD ?? "c25b4b8c1d985d5832e09dd170d6b3736e7be1c3"}`,
          "- transport: real in-process Gateway server + authenticated WebSocket client",
          "- storage: per-agent SQLite session store (`session_nodes`)",
          "",
          "```text",
          ...snapshots,
          "```",
          "",
        ].join("\n"),
      );
    } finally {
      for (const [key, value] of previousEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  },
);

test("restores shared-worker environment after the runtime proof", () => {
  for (const [key, value] of initialEnv) expect(process.env[key]).toBe(value);
});
