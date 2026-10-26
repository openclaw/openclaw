import "../flows/doctor-health.test-support.js";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  beginConversationDeliveryInDatabase,
  transitionConversationDeliveryInDatabase,
} from "../config/sessions/conversation-delivery-store.kernel.js";
import {
  conversationEntry,
  conversationRef,
} from "../config/sessions/conversation-delivery-store.test-support.js";
import { seedClaim } from "../config/sessions/legacy-main-session-migration.test-support.js";
import { readExactSessionEntryRowForCanonicalRepair } from "../config/sessions/session-accessor.sqlite-canonical-repair.js";
import { readSessionDeliveryRepairInventory } from "../config/sessions/session-accessor.sqlite-delivery-repair.js";
import { deleteSessionEntryLifecycle } from "../config/sessions/session-accessor.sqlite-lifecycle.js";
import { readTranscriptEventRows } from "../config/sessions/session-accessor.sqlite-read.js";
import { getSessionKysely } from "../config/sessions/session-accessor.sqlite-scope.js";
import { writeOpenClawConfig } from "../config/test-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runDoctorHealthFlow } from "../flows/doctor-health.js";
import { acquireGatewayStateOwner } from "../infra/gateway-state-owner.js";
import { executeSqliteQuerySync } from "../infra/kysely-sync.js";
import { buildUpdateRehearsalPathEnv } from "../infra/update-rehearsal-paths.js";
import { withOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import { listOpenClawRegisteredAgentDatabases } from "../state/openclaw-agent-db-registry-listing.js";
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
import * as configFlow from "./doctor-config-flow.js";
import { withDoctorConfigPreflightHome } from "./doctor-config-preflight.test-support.js";
import { repairRelativeSessionStores } from "./doctor-relative-session-store.js";
import { withDoctorSqliteMaintenanceLock } from "./doctor-sqlite-maintenance-lock.js";

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

function readSession(databasePath: string, key: string) {
  return withOpenClawAgentDatabaseReadOnly(
    (database) => {
      const entry = readExactSessionEntryRowForCanonicalRepair(database, key)?.entry;
      return (
        entry && {
          entry,
          events: readTranscriptEventRows(database, entry.sessionId).map((row) => row.eventJson),
          members: database.db
            .prepare(
              "SELECT identity_id FROM session_members WHERE session_key = ? ORDER BY identity_id",
            )
            .all(key),
        }
      );
    },
    { agentId: "main", path: databasePath },
  );
}

const agentDatabase = (root: string) =>
  path.join(root, "agents", "main", "agent", "openclaw-agent.sqlite");

async function withRelativeStore(
  run: (fixture: {
    home: string;
    cfg: OpenClawConfig;
    canonical: string;
    legacy: string;
  }) => Promise<void>,
) {
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
      const cwd = vi.spyOn(process, "cwd").mockReturnValue(home);
      try {
        await run({ home, cfg, canonical: agentDatabase(stateDir), legacy: agentDatabase(home) });
      } finally {
        cwd.mockRestore();
      }
    });
  });
}

it("merges the old HOME-relative store through Doctor without losing history or sharing", async () => {
  await withRelativeStore(async ({ cfg, canonical, legacy }) => {
    const key = "agent:main:legacy-home";
    const source = { databaseAgentId: "main", databasePath: legacy, key };
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
    const retained = readSession(canonical, "agent:main:retained");
    const canonicalConflict = readSession(canonical, collision);
    const sourceConflict = readSession(legacy, collision);
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
    expect(recovered.value).not.toBe(collision);
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
  });
});

it("merges a registered source from an unrelated prior working directory", async () => {
  await withRelativeStore(async ({ home, canonical }) => {
    const legacy = agentDatabase(path.join(home, "prior-working-directory"));
    const key = "agent:main:prior-cwd";
    seedClaim({ databaseAgentId: "main", databasePath: canonical, key: "agent:main:retained" });
    seedClaim({ databaseAgentId: "main", databasePath: legacy, key });
    const original = readSession(legacy, key);
    await repair();
    expect(readSession(canonical, key)).toEqual(original);
    expect(readSession(legacy, key)).toEqual(original);
    expect(listOpenClawRegisteredAgentDatabases().map((row) => row.path)).toEqual([canonical]);
  });
});

it.each(["history", "sharing"] as const)(
  "preserves both originals and refuses conflicting %s with the same session id",
  async (conflict) => {
    await withRelativeStore(async ({ canonical, legacy }) => {
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
      await expect(repair()).rejects.toThrow("conflicting session generations");
      expect(readSession(canonical, key)).toEqual(originalCanonical);
      expect(readSession(legacy, key)).toEqual(originalLegacy);
      expect(listOpenClawRegisteredAgentDatabases().map((row) => row.path)).toContain(legacy);
    });
  },
);

it.each(["completed", "created", "queued", "unknown", "outbox", "goal", "archive"] as const)(
  "preserves delivery evidence and refuses unsettled %s state before retiring the source",
  async (state) => {
    await withDoctorConfigPreflightHome(async (home) => {
      const canonical = agentDatabase(path.join(home, ".openclaw"));
      const legacy = agentDatabase(home);
      const key = "agent:main:receipt";
      const cfg: OpenClawConfig = { session: { store: "agents/{agentId}/sessions/sessions.json" } };
      seedClaim({ databaseAgentId: "main", databasePath: canonical, key: "agent:main:retained" });
      seedClaim({
        databaseAgentId: "main",
        databasePath: legacy,
        key,
        entry: conversationEntry("receipt-session", 100),
      });
      runOpenClawAgentWriteTransaction(
        (database) => {
          beginConversationDeliveryInDatabase(database, {
            operationId: "receipt",
            operationKind: "send",
            conversationRef,
            sourceSessionKey: key,
            message: "synthetic delivery",
          });
          const status =
            state === "created"
              ? "created"
              : state === "queued" || state === "unknown"
                ? state
                : "sent";
          transitionConversationDeliveryInDatabase(database, {
            operationId: "receipt",
            status,
            allowedFrom: ["created"],
            platformMessageId: "synthetic-message",
          });
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
        runOpenClawAgentWriteTransaction(
          (database) =>
            transitionConversationDeliveryInDatabase(database, {
              operationId: "receipt",
              status: "replied",
              allowedFrom: ["sent"],
              reply: { messageId: "late", text: "late reply", timestamp: 200 },
            }),
          { agentId: "main", path: legacy },
        );
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
        const canonical = agentDatabase(root);
        const legacy = agentDatabase(path.join(root, "prior-cwd"));
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
