import "../flows/doctor-health.test-support.js";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  beginConversationDeliveryOperation,
  markConversationDeliveryQueued,
  markConversationDeliverySent,
  markConversationDeliveryUnknown,
  markConversationDeliveryReplied,
} from "../config/sessions/conversation-delivery-store.js";
import { seedClaim } from "../config/sessions/legacy-main-session-migration.test-support.js";
import { readExactSessionEntryRowForCanonicalRepair } from "../config/sessions/session-accessor.sqlite-canonical-repair.js";
import { readSessionDeliveryRepairInventory } from "../config/sessions/session-accessor.sqlite-delivery-repair.js";
import { readSqliteSessionGenerationWindows } from "../config/sessions/session-accessor.sqlite-generation-copy.js";
import { deleteSessionEntryLifecycle } from "../config/sessions/session-accessor.sqlite-lifecycle.js";
import { readTranscriptEventRows } from "../config/sessions/session-accessor.sqlite-read.js";
import { getSessionKysely } from "../config/sessions/session-accessor.sqlite-scope.js";
import { resolveSessionColdArchivePath } from "../config/sessions/session-cold-storage-codec.js";
import { runSessionColdStorageMaintenance } from "../config/sessions/session-cold-storage.js";
import {
  createSessionColdStorageFixture,
  maintenanceConfig,
} from "../config/sessions/session-cold-storage.test-support.js";
import { writeOpenClawConfig } from "../config/test-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runDoctorHealthFlow } from "../flows/doctor-health.js";
import { acquireGatewayStateOwner } from "../infra/gateway-state-owner.js";
import { executeSqliteQuerySync } from "../infra/kysely-sync.js";
import { buildUpdateRehearsalPathEnv } from "../infra/update-rehearsal-paths.js";
import { buildConversationRef } from "../routing/conversation-ref.js";
import { withOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import { listOpenClawRegisteredAgentDatabases } from "../state/openclaw-agent-db-registry-listing.js";
import { unregisterOpenClawAgentDatabase } from "../state/openclaw-agent-db-registry.js";
import {
  closeOpenClawAgentDatabasesAsync,
  runOpenClawAgentWriteTransaction,
} from "../state/openclaw-agent-db.js";
import { ensureSessionTranscriptArchiveSchema } from "../state/openclaw-agent-session-transcript-archive-schema.js";
import { createOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { withEnvAsync } from "../test-utils/env.js";
import { cleanupSessionStateForTest } from "../test-utils/session-state-cleanup.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";
import * as configFlow from "./doctor-config-flow.js";
import { withDoctorConfigPreflightHome } from "./doctor-config-preflight.test-support.js";
import { resolveRelativeSessionStoreMigrationTargets } from "./doctor-relative-session-store-paths.js";
import { repairRelativeSessionStores } from "./doctor-relative-session-store.js";
import { withDoctorSqliteMaintenanceLock } from "./doctor-sqlite-maintenance-lock.js";

const conversationRef = buildConversationRef({
  channel: "reef",
  accountId: "default",
  kind: "direct",
  peerId: "peer-agent",
});
const conversationEntry = (sessionId: string, updatedAt: number) => ({
  sessionId,
  updatedAt,
  chatType: "direct" as const,
  delivery: normalizeSessionDeliveryState({
    context: { channel: "reef", accountId: "default", to: "reef:peer-agent" },
    origin: { provider: "reef", accountId: "default", nativeDirectUserId: "peer-agent" },
  }),
});

const { mocks } = await import("../flows/doctor-health.test-support.js");

beforeEach(async () => {
  mocks.packageRoot.mockReturnValue(undefined);
  mocks.runContributions.mockReset().mockResolvedValue(undefined);
  const actual =
    await vi.importActual<typeof import("./doctor-config-flow.js")>("./doctor-config-flow.js");
  vi.spyOn(configFlow, "loadAndMaybeMigrateDoctorConfig").mockImplementation(
    actual.loadAndMaybeMigrateDoctorConfig,
  );
});

afterEach(async () => {
  await cleanupSessionStateForTest();
  vi.restoreAllMocks();
});

async function repair() {
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
  const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
  await runDoctorHealthFlow(runtime, { repair: true, nonInteractive: true });
  expect(runtime.error.mock.calls.flat().join("\n")).toBe("");
  expect(runtime.exit).not.toHaveBeenCalled();
}

async function repairOwner(cfg: OpenClawConfig) {
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
  return withDoctorSqliteMaintenanceLock({
    operation: "relative session store regression",
    run: async (authority) => {
      const maintenance = createOpenClawDatabaseMaintenanceScope({
        schemaMaintenance: true,
        assertOwnerCurrent: () => authority.assertCurrent(),
      });
      try {
        return await maintenance.run(() => repairRelativeSessionStores({ cfg, env: process.env }));
      } finally {
        await maintenance.close();
      }
    },
  });
}

function addMember(databasePath: string, key: string, identity: string) {
  runOpenClawAgentWriteTransaction(
    (database) =>
      database.db
        .prepare(
          "INSERT INTO session_members (session_key, identity_id, added_by, added_at) VALUES (?, ?, 'synthetic-owner', 100)",
        )
        .run(key, identity),
    { agentId: "main", path: databasePath },
  );
}

function readSession(databasePath: string, key: string, agentId = "main") {
  return withOpenClawAgentDatabaseReadOnly(
    (database) => {
      const entry = readExactSessionEntryRowForCanonicalRepair(database, key)?.entry;
      return (
        entry && {
          entry,
          events: readTranscriptEventRows(database, entry.sessionId).map((row) => row.eventJson),
          generations: readSqliteSessionGenerationWindows(database, [key], []).map((window) => ({
            sessionId: window.session_id,
            events: readTranscriptEventRows(database, window.session_id).map(
              (row) => row.eventJson,
            ),
          })),
          members: database.db
            .prepare(
              "SELECT identity_id FROM session_members WHERE session_key = ? ORDER BY identity_id",
            )
            .all(key),
        }
      );
    },
    { agentId, path: databasePath },
  );
}

it("merges the old HOME-relative store through Doctor without losing history or sharing", async () => {
  await withDoctorConfigPreflightHome(async (home) => {
    const stateDir = path.join(home, ".openclaw");
    const workspace = path.join(stateDir, "workspace");
    fs.mkdirSync(workspace, { recursive: true });
    const cfg: OpenClawConfig = {
      gateway: { mode: "local" },
      plugins: { enabled: false },
      agents: { ownership: "explicit", entries: { main: { workspace } } },
      session: { store: "agents/{agentId}/sessions/sessions.json" },
    };
    await writeOpenClawConfig(home, cfg);
    await withEnvAsync({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }, async () => {
      const canonical = path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
      const legacy = path.join(home, "agents", "main", "agent", "openclaw-agent.sqlite");
      const key = "agent:main:legacy-home";
      const source = { databaseAgentId: "main", databasePath: legacy, key };
      seedClaim({
        ...source,
        entry: { sessionId: "retained-previous-generation", updatedAt: 50 },
        events: [{ type: "message", id: "older-event", text: "previous generation history" }],
      });
      seedClaim(source);
      seedClaim({ databaseAgentId: "main", databasePath: canonical, key: "agent:main:retained" });
      const collision = "agent:main:collision";
      seedClaim({
        databaseAgentId: "main",
        databasePath: legacy,
        key: collision,
        entry: { sessionId: "legacy-conflict", updatedAt: 100 },
      });
      seedClaim({
        databaseAgentId: "main",
        databasePath: canonical,
        key: collision,
        entry: { sessionId: "canonical-conflict", updatedAt: 100 },
      });
      addMember(legacy, key, "synthetic-member");
      addMember(legacy, collision, "source-conflict-member");
      addMember(canonical, collision, "canonical-conflict-member");
      const original = readSession(legacy, key);
      expect(original.found && original.value?.generations).toHaveLength(2);
      const retained = readSession(canonical, "agent:main:retained");
      const canonicalConflict = readSession(canonical, collision);
      const sourceConflict = readSession(legacy, collision);
      const cwd = vi.spyOn(process, "cwd").mockReturnValue(home);
      try {
        await repair();
        expect(readSession(canonical, key)).toEqual(original);
        expect(readSession(canonical, "agent:main:retained")).toEqual(retained);
        expect(readSession(canonical, collision)).toEqual(canonicalConflict);
        const recovered = withOpenClawAgentDatabaseReadOnly(
          (database) =>
            executeSqliteQuerySync(
              database.db,
              getSessionKysely(database.db)
                .selectFrom("session_nodes")
                .select("session_key")
                .where("current_session_id", "=", "legacy-conflict"),
            ).rows[0]?.session_key,
          { agentId: "main", path: canonical },
        );
        if (!recovered.found || !recovered.value) {
          throw new Error("Doctor did not preserve the conflicting source conversation");
        }
        const recoveryDigest = createHash("sha256")
          .update(fs.realpathSync(legacy) + "\n" + collision)
          .digest("hex")
          .slice(0, 24);
        expect(recovered.value).toBe("agent:main:relative-store-recovery-" + recoveryDigest);
        expect(readSession(canonical, recovered.value)).toEqual(sourceConflict);
        expect(readSession(legacy, key)).toEqual(original);
        expect(listOpenClawRegisteredAgentDatabases().map((row) => row.path)).toEqual([canonical]);
        expect(
          fs
            .readdirSync(path.dirname(legacy))
            .some(
              (file) =>
                file.startsWith("openclaw-agent.sqlite.pre-startup-migration-") &&
                file.endsWith(".bak"),
            ),
        ).toBe(true);
        await repairOwner(cfg);
        expect(readSession(canonical, key)).toEqual(original);

        expect(
          await deleteSessionEntryLifecycle({
            agentId: "main",
            storePath: canonical,
            archiveTranscript: false,
            deleteTranscriptWithoutArchive: true,
            target: { canonicalKey: key, storeKeys: [key] },
          }),
        ).toMatchObject({ deleted: true });
        await repairOwner(cfg);
        expect(readSession(canonical, key)).toEqual({ found: true, value: undefined });
        expect(readSession(legacy, key)).toEqual(original);
      } finally {
        cwd.mockRestore();
      }
    });
  });
});

it("merges a registered source from an unrelated prior working directory", async () => {
  await withDoctorConfigPreflightHome(async (home) => {
    const stateDir = path.join(home, ".openclaw");
    const workspace = path.join(stateDir, "workspace");
    fs.mkdirSync(workspace, { recursive: true });
    await writeOpenClawConfig(home, {
      gateway: { mode: "local" },
      plugins: { enabled: false },
      agents: { ownership: "explicit", entries: { main: { workspace } } },
      session: { store: "agents/{agentId}/sessions/sessions.json" },
    });
    await withEnvAsync({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }, async () => {
      const canonical = path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
      const legacy = path.join(
        home,
        "prior-working-directory",
        "agents",
        "main",
        "agent",
        "openclaw-agent.sqlite",
      );
      const key = "agent:main:prior-cwd";
      seedClaim({ databaseAgentId: "main", databasePath: canonical, key: "agent:main:retained" });
      seedClaim({ databaseAgentId: "main", databasePath: legacy, key });
      const original = readSession(legacy, key);
      const cwd = vi.spyOn(process, "cwd").mockReturnValue(home);
      try {
        await repair();
        expect(readSession(canonical, key)).toEqual(original);
        expect(readSession(legacy, key)).toEqual(original);
        expect(listOpenClawRegisteredAgentDatabases().map((row) => row.path)).toEqual([canonical]);
      } finally {
        cwd.mockRestore();
      }
    });
  });
});

it.each(["history", "sharing"] as const)(
  "preserves both originals and refuses conflicting %s with the same session id",
  async (conflict) => {
    await withDoctorConfigPreflightHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      const workspace = path.join(stateDir, "workspace");
      fs.mkdirSync(workspace, { recursive: true });
      await writeOpenClawConfig(home, {
        gateway: { mode: "local" },
        plugins: { enabled: false },
        agents: { ownership: "explicit", entries: { main: { workspace } } },
        session: { store: "agents/{agentId}/sessions/sessions.json" },
      });
      await withEnvAsync({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }, async () => {
        const canonical = path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
        const legacy = path.join(home, "agents", "main", "agent", "openclaw-agent.sqlite");
        const key = "agent:main:collision";
        for (const [databasePath, text] of [
          [canonical, "canonical history"],
          [legacy, conflict === "history" ? "legacy history" : "canonical history"],
        ] as const) {
          seedClaim({
            databaseAgentId: "main",
            databasePath,
            key,
            entry: { sessionId: "same-session-id", updatedAt: 100 },
            events: [{ type: "message", id: "event-1", text }],
          });
        }
        if (conflict === "sharing") {
          addMember(canonical, key, "canonical-member");
          addMember(legacy, key, "source-member");
        }
        const originalCanonical = readSession(canonical, key);
        const originalLegacy = readSession(legacy, key);
        const cwd = vi.spyOn(process, "cwd").mockReturnValue(home);
        try {
          await expect(repair()).rejects.toThrow("conflicting session generations");
          expect(readSession(canonical, key)).toEqual(originalCanonical);
          expect(readSession(legacy, key)).toEqual(originalLegacy);
          expect(listOpenClawRegisteredAgentDatabases().map((row) => row.path)).toContain(legacy);
        } finally {
          cwd.mockRestore();
        }
      });
    });
  },
);

it.each(["completed", "created", "queued", "unknown", "outbox", "goal", "archive"] as const)(
  "preserves delivery evidence and refuses unsettled %s state before retiring the source",
  async (state) => {
    await withDoctorConfigPreflightHome(async (home) => {
      const canonical = path.join(
        home,
        ".openclaw",
        "agents",
        "main",
        "agent",
        "openclaw-agent.sqlite",
      );
      const legacy = path.join(home, "agents", "main", "agent", "openclaw-agent.sqlite");
      const key = "agent:main:receipt";
      const cfg: OpenClawConfig = { session: { store: "agents/{agentId}/sessions/sessions.json" } };
      seedClaim({ databaseAgentId: "main", databasePath: canonical, key: "agent:main:retained" });
      seedClaim({
        databaseAgentId: "main",
        databasePath: legacy,
        key,
        entry: conversationEntry("receipt-session", 100),
      });
      const deliveryScope = { agentId: "main", storePath: legacy };
      beginConversationDeliveryOperation(deliveryScope, {
        operationId: "receipt",
        operationKind: "send",
        conversationRef,
        sourceSessionKey: key,
        message: "synthetic delivery",
      });
      if (state === "queued") {
        markConversationDeliveryQueued(deliveryScope, "receipt", "synthetic-queue");
      } else if (state === "unknown") {
        markConversationDeliveryUnknown(deliveryScope, "receipt");
      } else if (state !== "created") {
        markConversationDeliverySent(deliveryScope, "receipt", "synthetic-message");
      }
      runOpenClawAgentWriteTransaction(
        (database) => {
          database.db
            .prepare(
              "INSERT INTO cache_entries (scope, key, value_json, updated_at) VALUES ('conversation-progress', 'receipt', ?, 100)",
            )
            .run(JSON.stringify({ lines: ["Retained progress"] }));
          if (state === "outbox") {
            database.db
              .prepare(
                "INSERT INTO context_engine_turn_outbox (advancement_key, engine_id, session_id, payload_json, created_at) VALUES ('pending', 'synthetic', 'receipt-session', '{}', 100)",
              )
              .run();
          } else if (state === "goal") {
            database.db
              .prepare(
                "INSERT INTO session_goal_operations (session_key, operation_id, session_id, request_fingerprint, result_json, expires_at) VALUES (?, 'pending-goal', 'receipt-session', 'request', '{}', ?)",
              )
              .run(key, Date.parse("2100-01-01T00:00:00Z"));
          } else if (state === "archive") {
            ensureSessionTranscriptArchiveSchema(database.db);
            const archive = Buffer.from('{"type":"session","id":"archived"}\n');
            database.db
              .prepare(
                "INSERT INTO session_transcript_archives (session_id, generation, session_key, reason, archive_name, archive_sha256, encoding, archive_blob, created_at) VALUES ('archived', 'generation', ?, 'reset', 'synthetic.jsonl', ?, 'identity', ?, 100)",
              )
              .run(key, createHash("sha256").update(archive).digest("hex"), archive);
          }
        },
        { agentId: "main", path: legacy },
      );
      const original = readSession(legacy, key);
      const inventory = (pathname: string) =>
        withOpenClawAgentDatabaseReadOnly(readSessionDeliveryRepairInventory, {
          agentId: "main",
          path: pathname,
        });
      const sourceEvidence = inventory(legacy);
      if (state === "completed") {
        await repairOwner(cfg);
        expect(inventory(canonical)).toEqual(sourceEvidence);
        expect(readSession(canonical, key)).toEqual(original);
        await repairOwner(cfg);
        expect(inventory(canonical)).toEqual(sourceEvidence);
        markConversationDeliveryReplied(deliveryScope, {
          operationId: "receipt",
          reply: { messageId: "late", text: "late reply", timestamp: 200 },
        });
        await expect(repairOwner(cfg)).rejects.toThrow("retired source");
        expect(inventory(canonical)).toEqual(sourceEvidence);
      } else {
        await expect(repairOwner(cfg)).rejects.toThrow(
          /pending|goal-operation|transcript archives/,
        );
        expect(readSession(canonical, key)).toEqual({ found: true, value: undefined });
        expect(readSession(legacy, key)).toEqual(original);
        expect(inventory(legacy)).toEqual(sourceEvidence);
        expect(listOpenClawRegisteredAgentDatabases().map((row) => row.path)).toContain(legacy);
      }
    });
  },
);

it("keeps verified pre-merge backups inside a disposable update rehearsal", async () => {
  await withDoctorConfigPreflightHome(async (home) => {
    const stateDir = path.join(home, ".openclaw");
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const root = fs.realpathSync(stateDir);
    fs.chmodSync(root, 0o700);
    await withEnvAsync(
      {
        ...buildUpdateRehearsalPathEnv(root),
        OPENCLAW_UPDATE_IN_PROGRESS: "1",
        OPENCLAW_SERVICE_REPAIR_POLICY: "external",
        OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR: "0",
        OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION: "0",
        OPENCLAW_COMPATIBILITY_HOST_VERSION: undefined,
      },
      async () => {
        const canonical = path.join(root, "agents", "main", "agent", "openclaw-agent.sqlite");
        const legacy = path.join(
          root,
          "prior-cwd",
          "agents",
          "main",
          "agent",
          "openclaw-agent.sqlite",
        );
        const shared = resolveOpenClawStateSqlitePath(process.env);
        const key = "agent:main:copied-rehearsal";
        const retainedKey = "agent:main:retained";
        const cfg: OpenClawConfig = {
          session: { store: "agents/{agentId}/sessions/sessions.json" },
        };
        seedClaim({ databaseAgentId: "main", databasePath: legacy, key });
        seedClaim({ databaseAgentId: "main", databasePath: canonical, key: retainedKey });
        const original = readSession(legacy, key);
        const retained = readSession(canonical, retainedKey);
        await closeOpenClawAgentDatabasesAsync();
        await closeOpenClawStateDatabaseAsync();
        const owner = acquireGatewayStateOwner({ databasePath: shared });
        const scope = createOpenClawDatabaseMaintenanceScope({
          schemaMaintenance: true,
          assertOwnerCurrent: () => owner.assertCurrent(),
          assertDatabaseAccess: (filename) => owner.assertDatabaseAccess(filename),
        });
        try {
          await scope.run(() => repairOwner(cfg));
        } finally {
          await scope.close();
          owner.release();
        }
        expect(readSession(canonical, key)).toEqual(original);
        const snapshot = (filename: string) => {
          const archives = fs
            .readdirSync(path.dirname(filename))
            .filter(
              (name) =>
                name.startsWith(`${path.basename(filename)}.pre-startup-migration-`) &&
                name.endsWith(".bak"),
            );
          expect(archives).toHaveLength(1);
          return path.join(path.dirname(filename), archives[0]!);
        };
        expect(readSession(snapshot(legacy), key)).toEqual(original);
        const canonicalSnapshot = snapshot(canonical);
        expect(readSession(canonicalSnapshot, retainedKey)).toEqual(retained);
        expect(readSession(canonicalSnapshot, key)).toEqual({ found: true, value: undefined });
        using sharedSnapshot = new DatabaseSync(snapshot(shared), { readOnly: true });
        expect(
          sharedSnapshot.prepare("SELECT path FROM agent_databases ORDER BY path").all(),
        ).toEqual([
          { path: path.join("agents", "main", "agent", "openclaw-agent.sqlite") },
          { path: path.join("prior-cwd", "agents", "main", "agent", "openclaw-agent.sqlite") },
        ]);
      },
    );
  });
});

it.each([
  { registered: true, suffixed: false },
  { registered: false, suffixed: false },
  { registered: true, suffixed: true },
  { registered: false, suffixed: true },
])(
  "preserves retired fixed-store ownership ($registered registered, $suffixed suffixed)",
  async ({ registered, suffixed }) => {
    await withDoctorConfigPreflightHome(async (home) => {
      const cfg: OpenClawConfig = {
        agents: { entries: { ops: { default: true } } },
        session: { store: "shared/sessions.json" },
      };
      const legacy = path.join(
        home,
        "shared",
        suffixed ? "openclaw-agent.retired.sqlite" : "openclaw-agent.sqlite",
      );
      const canonicalRoot = path.join(home, ".openclaw", "shared");
      const canonical = path.join(canonicalRoot, "openclaw-agent.retired.sqlite");
      const key = "agent:retired:retained";
      seedClaim({
        databaseAgentId: "ops",
        databasePath: path.join(canonicalRoot, "openclaw-agent.sqlite"),
        key: "agent:ops:retained",
      });
      seedClaim({ databaseAgentId: "retired", databasePath: legacy, key });
      const original = readSession(legacy, key, "retired");
      if (!registered) {
        unregisterOpenClawAgentDatabase({ agentId: "retired", path: legacy });
      }
      const registry = listOpenClawRegisteredAgentDatabases();
      const cwd = vi.spyOn(process, "cwd").mockReturnValue(home);
      try {
        expect(
          resolveRelativeSessionStoreMigrationTargets(cfg, process.env, registry),
        ).toContainEqual({
          agentId: "retired",
          configuredAgentId: "retired",
          path: legacy,
          storePath: path.join(home, "shared", "sessions.json"),
        });
        await repairOwner(cfg);
        expect(readSession(canonical, key, "retired")).toEqual(original);
        expect(readSession(legacy, key, "retired")).toEqual(original);
        expect(listOpenClawRegisteredAgentDatabases()).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ agentId: "retired", path: canonical }),
          ]),
        );
        expect(listOpenClawRegisteredAgentDatabases().map((row) => row.path)).not.toContain(legacy);
      } finally {
        cwd.mockRestore();
      }
    });
  },
);

function seedWidget(databasePath: string, key: string, name: string, html: string) {
  runOpenClawAgentWriteTransaction(
    (database) => {
      database.db
        .prepare(
          "INSERT OR IGNORE INTO board_tabs (session_key, tab_id, title, position, created_by, revision) VALUES (?, 'tab', 'Retained board', 0, 'user', 1)",
        )
        .run(key);
      database.db
        .prepare(
          "INSERT INTO board_widgets (session_key, name, tab_id, content_kind, html, sha256, view_generation, revision, size_w, size_h, position, created_by, created_at, updated_at) VALUES (?, ?, 'tab', 'html', ?, ?, 'view', 1, 4, 3, 0, 'user', 100, 100)",
        )
        .run(key, name, Buffer.from(html), createHash("sha256").update(html).digest("hex"));
    },
    { agentId: "main", path: databasePath },
  );
}

function readWidgets(databasePath: string, key: string) {
  return withOpenClawAgentDatabaseReadOnly(
    (database) =>
      database.db
        .prepare("SELECT name, html FROM board_widgets WHERE session_key = ? ORDER BY name")
        .all(key),
    { agentId: "main", path: databasePath },
  );
}

it.each([false, true])(
  "preserves user-authored board content with overlapping widget identity: %s",
  async (conflicting) => {
    await withDoctorConfigPreflightHome(async (home) => {
      const cfg: OpenClawConfig = { session: { store: "agents/{agentId}/sessions/sessions.json" } };
      const legacy = path.join(home, "agents", "main", "agent", "openclaw-agent.sqlite");
      const canonical = path.join(
        home,
        ".openclaw",
        "agents",
        "main",
        "agent",
        "openclaw-agent.sqlite",
      );
      const key = "agent:main:board";
      for (const databasePath of [legacy, canonical]) {
        seedClaim({ databaseAgentId: "main", databasePath, key });
      }
      seedWidget(legacy, key, "source-widget", "<p>Source user content</p>");
      seedWidget(
        canonical,
        key,
        conflicting ? "source-widget" : "destination-widget",
        "<p>Destination user content</p>",
      );
      const source = readWidgets(legacy, key);
      const destination = readWidgets(canonical, key);
      const cwd = vi.spyOn(process, "cwd").mockReturnValue(home);
      try {
        if (conflicting) {
          await expect(repairOwner(cfg)).rejects.toThrow("conflicting session generations");
          expect(readWidgets(canonical, key)).toEqual(destination);
          expect(listOpenClawRegisteredAgentDatabases().map((row) => row.path)).toContain(legacy);
        } else {
          await repairOwner(cfg);
          expect(readWidgets(canonical, key)).toEqual({
            found: true,
            value: [
              {
                name: "destination-widget",
                html: new Uint8Array(Buffer.from("<p>Destination user content</p>")),
              },
              {
                name: "source-widget",
                html: new Uint8Array(Buffer.from("<p>Source user content</p>")),
              },
            ],
          });
        }
        expect(readWidgets(legacy, key)).toEqual(source);
      } finally {
        cwd.mockRestore();
      }
    });
  },
);

it.skipIf(process.platform === "win32")(
  "restores external cold history through the original file-symlink locator",
  async () => {
    await withDoctorConfigPreflightHome(async (home) => {
      const legacy = path.join(home, "agents", "main", "agent", "openclaw-agent.sqlite");
      const canonical = path.join(
        home,
        ".openclaw",
        "agents",
        "main",
        "agent",
        "openclaw-agent.sqlite",
      );
      const backing = path.join(home, "physical", "backing.sqlite");
      const key = "agent:main:symlink-cold";
      await createSessionColdStorageFixture(legacy, key);
      const original = readSession(legacy, key);
      expect(await runSessionColdStorageMaintenance({ config: maintenanceConfig(legacy) })).toEqual(
        { archivedTranscripts: 1, externalizedTranscripts: 0 },
      );
      await closeOpenClawAgentDatabasesAsync();
      fs.mkdirSync(path.dirname(backing), { recursive: true });
      fs.renameSync(legacy, backing);
      fs.symlinkSync(backing, legacy);
      expect(fs.realpathSync(legacy)).toBe(backing);
      const archived = withOpenClawAgentDatabaseReadOnly(
        (database) =>
          executeSqliteQuerySync(
            database.db,
            getSessionKysely(database.db)
              .selectFrom("session_transcript_cold_archives")
              .select(["archive_name", "storage"]),
          ).rows[0],
        { agentId: "main", path: legacy },
      );
      if (!archived.found || !archived.value) {
        throw new Error("Cold fixture did not retain an external archive");
      }
      expect(archived.value.storage).toBe("file");
      expect(
        fs.existsSync(resolveSessionColdArchivePath(legacy, archived.value.archive_name)),
      ).toBe(true);
      expect(
        fs.existsSync(resolveSessionColdArchivePath(backing, archived.value.archive_name)),
      ).toBe(false);
      seedClaim({ databaseAgentId: "main", databasePath: canonical, key: "agent:main:retained" });
      const cwd = vi.spyOn(process, "cwd").mockReturnValue(home);
      try {
        await repairOwner({ session: { store: "agents/{agentId}/sessions/sessions.json" } });
        expect(readSession(canonical, key)).toEqual(original);
        expect(readSession(legacy, key)).toEqual(original);
      } finally {
        cwd.mockRestore();
      }
    });
  },
);
