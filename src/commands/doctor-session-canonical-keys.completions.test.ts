import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, describe, expect, it } from "vitest";
import { buildAgentRunTerminalOutcome } from "../agents/agent-run-terminal-outcome.js";
import {
  assignSessionOwner,
  deleteSessionEntryLifecycle,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import {
  stageSessionPendingInput,
  type SessionPendingInputReceipt,
} from "../config/sessions/session-accessor.pending-inputs.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { rotateAgentEventLifecycleGeneration } from "../infra/agent-events.js";
import { withAgentDatabaseMaintenanceLease } from "../state/openclaw-agent-db-maintenance-lease.js";
import { migrateOpenClawAgentDatabaseForMaintenance } from "../state/openclaw-agent-db-maintenance.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-schema-versions.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";
import { repairCanonicalSessionKeys } from "./doctor-session-canonical-keys.test-support.js";
import { createCanonicalRepairFixture } from "./doctor-session-repair-fixture.test-support.js";

const receipts: SessionPendingInputReceipt[] = [];
afterEach(async () => {
  for (const receipt of receipts.splice(0)) {
    receipt.finish("interrupted", "failed");
  }
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
});

function fixture(stateDir: string, alias = false) {
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  const sourceAgent = alias ? "main" : "ops";
  const sourcePath = path.join(stateDir, `${sourceAgent}.sqlite`);
  const destinationPath = path.join(stateDir, "main.sqlite");
  const sourceKey = alias
    ? "agent:main:matrix:channel:!parent:example.org"
    : "agent:main:private-parent";
  const canonicalKey = alias ? "agent:main:matrix:channel:!Parent:example.org" : sourceKey;
  const sessionId = "private-parent-generation";
  const cfg: OpenClawConfig = {
    agents: { ownership: "explicit", entries: { main: {}, ops: {} } },
    session: {
      store: path.join(stateDir, "{agentId}.sqlite"),
      ...(alias ? { mainKey: "work" } : {}),
    },
  };
  const database = (destination = false) =>
    openOpenClawAgentDatabase({
      agentId: destination ? "main" : sourceAgent,
      env,
      path: destination ? destinationPath : sourcePath,
    });
  const scope = (destination = false) => ({
    agentId: "main",
    env,
    sessionKey: destination ? canonicalKey : sourceKey,
    sessionId,
    storePath: destination ? destinationPath : sourcePath,
  });
  const create = (destination = false, updatedAt = 20) => {
    database(destination);
    replaceSessionEntrySync(scope(destination), { sessionId, updatedAt });
  };
  const stage = async (
    destination = false,
    content = "private child result",
    sessionKey = scope(destination).sessionKey,
  ) => {
    const receipt = expectDefined(
      await stageSessionPendingInput(
        { ...scope(destination), sessionKey },
        {
          runId: "announce:private-result",
          trackCompletion: true,
          assertCurrent: () => {},
          message: {
            role: "user",
            content,
            timestamp: 1,
            idempotencyKey: "announce:private-result:user",
            display: false,
            provenance: { kind: "inter_session", sourceTool: "subagent_announce" },
          },
        },
      ),
      "Expected private input custody",
    );
    receipts.push(receipt);
    return receipt;
  };
  const rows = (destination = false) =>
    database(destination).db.prepare("SELECT * FROM session_input_completions").all();
  const repair = () => repairCanonicalSessionKeys({ apply: true, cfg, env });
  const close = async () => {
    await closeOpenClawAgentDatabasesAsync(stateDir);
    closeOpenClawAgentDatabasesForTest();
  };
  const restart = async () => {
    rotateAgentEventLifecycleGeneration();
    await close();
  };
  return { database, scope, create, stage, rows, canonicalKey, repair, close, restart };
}

const completed = buildAgentRunTerminalOutcome({ status: "ok" });
const stopped = buildAgentRunTerminalOutcome({ status: "error", stopReason: "rpc" });

describe("Doctor canonical completion receipt repair", () => {
  it("preserves operator Stop semantics across owner repair and restart", async () => {
    await withStateDirEnv("doctor-private-completion-", async ({ stateDir }) => {
      const f = fixture(stateDir);
      f.create();
      const first = await f.stage();
      await first.completeAsync!(stopped);
      first.finish("interrupted", "failed");
      const before = f.rows();
      f.database(true).db.exec("DROP TABLE session_input_completions");
      await f.restart();
      expect(await f.repair()).toMatchObject({ repairedGroups: 1 });
      expect(f.rows(true)).toEqual(before);
      expect(f.rows()).toEqual([]);
      await f.close();
      const retry = await f.stage(true);
      expect(retry.completion).toEqual(stopped);
      expect(() => retry.run(() => "replayed work")).toThrow("already completed");
      expect(await f.repair()).toMatchObject({ repairedGroups: 0 });
      retry.finish("interrupted", "failed");
      const deleted = await deleteSessionEntryLifecycle({
        agentId: "main",
        storePath: f.scope(true).storePath,
        target: { canonicalKey: f.canonicalKey, storeKeys: [f.canonicalKey] },
        archiveTranscript: false,
        deleteTranscriptWithoutArchive: true,
      });
      expect(deleted.deleted).toBe(true);
      expect(f.rows(true)).toEqual([]);
    });
  });

  it("rekeys a final receipt before removing a same-store alias", async () => {
    await withStateDirEnv("doctor-private-alias-", async ({ stateDir }) => {
      const f = fixture(stateDir, true);
      f.create();
      await (
        await f.stage()
      ).completeAsync!(stopped);
      const before = f.rows();
      f.database()
        .db.prepare(
          "UPDATE session_nodes SET entry_json = json_set(entry_json, '$.delivery', json(?)) WHERE session_key = ?",
        )
        .run(
          JSON.stringify(
            normalizeSessionDeliveryState({
              context: { channel: "matrix", to: "!Parent:example.org" },
            }),
          ),
          f.scope().sessionKey,
        );
      await f.restart();
      await f.repair();
      for (const row of before) {
        row.session_key = f.canonicalKey;
      }
      expect(f.rows(true)).toEqual(before);
      expect((await f.stage(true)).completion).toEqual(stopped);
    });
  });

  it.each([false, true])(
    "rolls back conflicting receipt identities (other key: %s)",
    async (otherKey) => {
      await withStateDirEnv("doctor-private-conflict-", async ({ stateDir }) => {
        const f = fixture(stateDir);
        f.create(false, 20);
        const destinationKey = otherKey ? "agent:main:another-parent" : f.scope(true).sessionKey;
        replaceSessionEntrySync(
          { ...f.scope(true), sessionKey: destinationKey },
          { sessionId: f.scope(true).sessionId, updatedAt: 10 },
        );
        await (
          await f.stage()
        ).completeAsync!(completed);
        await (
          await f.stage(
            true,
            otherKey ? "private child result" : "different private result",
            destinationKey,
          )
        ).completeAsync!(stopped);
        const source = f.rows();
        const destination = f.rows(true);
        await f.restart();
        await expect(f.repair()).rejects.toThrow("conflicting input completions");
        expect(f.rows()).toEqual(source);
        expect(f.rows(true)).toEqual(destination);
      });
    },
  );
});

describe("Doctor canonical pending-input repair", () => {
  it("preserves version 42 user-stop retirement and message bytes across owner repair and restart", async () => {
    await withStateDirEnv("doctor-legacy-stopped-input-", async ({ stateDir }) => {
      const f = fixture(stateDir);
      f.create();
      const first = await f.stage();
      first.finish("cancelled", "failed");
      await first.settled?.();
      const filename = f.database().path;
      await f.restart();
      fs.copyFileSync(filename, `${filename}.previous`);
      fs.renameSync(`${filename}.previous`, filename);
      const legacyMessage = JSON.stringify({
        ...first.message,
        __openclaw: { pendingInputCancelledByUser: true },
      });
      {
        using old = new DatabaseSync(filename);
        old.exec(`
          ALTER TABLE session_members DROP COLUMN access;
          ALTER TABLE session_pending_inputs DROP COLUMN end_cause;
          ALTER TABLE session_pending_inputs DROP COLUMN origin_source_json;
          PRAGMA user_version = 42;
          UPDATE schema_meta SET schema_version = 42 WHERE meta_key = 'primary';
        `);
        old
          .prepare("UPDATE session_pending_inputs SET message_json = ? WHERE input_id = ?")
          .run(legacyMessage, first.inputId);
      }
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      await withAgentDatabaseMaintenanceLease({ env }, (maintenance) =>
        migrateOpenClawAgentDatabaseForMaintenance(
          { agentId: "ops", env, pathname: filename },
          maintenance,
        ),
      );

      expect(await f.repair()).toMatchObject({ repairedGroups: 1 });
      await f.restart();
      expect(f.database().db.prepare("PRAGMA user_version").get()).toEqual({
        user_version: OPENCLAW_AGENT_SCHEMA_VERSION,
      });
      expect(
        f
          .database()
          .db.prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'")
          .get(),
      ).toEqual({ schema_version: OPENCLAW_AGENT_SCHEMA_VERSION });
      expect(
        f
          .database(true)
          .db.prepare(
            "SELECT input_id, session_key, state, end_cause, message_json FROM session_pending_inputs",
          )
          .all(),
      ).toEqual([
        {
          input_id: first.inputId,
          session_key: f.canonicalKey,
          state: "cancelled",
          end_cause: "user-stop",
          message_json: legacyMessage,
        },
      ]);
      expect(f.database().db.prepare("SELECT * FROM session_pending_inputs").all()).toEqual([]);
      await expect(
        stageSessionPendingInput(f.scope(true), {
          runId: "announce:private-result",
          message: first.message,
          assertCurrent: () => {},
          trackCompletion: true,
          retryCancelled: true,
        }),
      ).rejects.toThrow("ownership ended");
      expect(await f.repair()).toMatchObject({ repairedGroups: 0 });
    });
  });

  it.each([
    ["user-stop", "failed"],
    ["failed", "user-stop"],
  ] as const)(
    "keeps a deliberate retirement when merging copies (source %s, destination %s)",
    async (sourceCause, destinationCause) => {
      await withStateDirEnv("doctor-merge-cause-", async ({ stateDir }) => {
        const f = fixture(stateDir);
        f.create(false, 20);
        f.create(true, 10);
        const source = await f.stage();
        source.finish("cancelled", sourceCause);
        await source.settled?.();
        const destination = await f.stage(true);
        destination.finish("cancelled", destinationCause);
        await destination.settled?.();
        await f.restart();
        expect(await f.repair()).toMatchObject({ repairedGroups: 1 });
        expect(
          f.database(true).db.prepare("SELECT state, end_cause FROM session_pending_inputs").all(),
        ).toEqual([{ state: "cancelled", end_cause: "user-stop" }]);
      });
    },
  );
});

describe("doctor transcript owner repair", () => {
  it.each([false, true])(
    "preserves required creation provenance during canonical repair: %o",
    async (requiredCanonical) => {
      await withStateDirEnv("openclaw-doctor-canonical-creation-stamp-", async ({ stateDir }) => {
        const { insert, load, expectRepair } = createCanonicalRepairFixture(stateDir, "work", [
          "main",
          "ops",
        ]);
        const canonicalKey = "agent:main:matrix:channel:!Creation:example.org";
        const canonicalStamp = {
          createdVia: "operator" as const,
          createdActor: {
            type: "human" as const,
            source: "profile" as const,
            id: "profile-canonical",
          },
          createdAt: 10,
          ...(requiredCanonical ? { sandbox: "required" as const } : {}),
        };
        const aliasStamp = {
          createdVia: "channel" as const,
          createdActor: { type: "human" as const, source: "channel" as const, id: "profile-alias" },
          createdAt: 20,
          sandbox: "required" as const,
        };
        insert(canonicalKey, {
          ...canonicalStamp,
          sessionId: "canonical-session",
          updatedAt: requiredCanonical ? 10 : 30,
        });
        insert(canonicalKey.toLowerCase(), {
          ...aliasStamp,
          delivery: normalizeSessionDeliveryState({
            context: { channel: "matrix", to: "!Creation:example.org" },
          }),
          sessionId: "alias-session",
          updatedAt: 20,
        });

        await expectRepair({ foundGroups: 1, repairedGroups: 1 });
        const repaired = load(canonicalKey)?.entry;
        const expectedStamp = !requiredCanonical ? aliasStamp : canonicalStamp;
        expect(repaired).toMatchObject({
          ...expectedStamp,
          sessionId: requiredCanonical ? "alias-session" : "canonical-session",
          updatedAt: requiredCanonical ? 20 : 30,
        });
      });
    },
  );

  it("replaces a stale same-store owner from the selected canonical-repair winner", async () => {
    await withStateDirEnv("openclaw-doctor-assigned-owner-", async ({ stateDir }) => {
      const { insert, load, database, scope, expectRepair } = createCanonicalRepairFixture(
        stateDir,
        "work",
      );
      const canonicalKey = "agent:main:matrix:channel:!Owner:example.org";
      const winnerKey = canonicalKey.toLowerCase();
      insert(canonicalKey, { sessionId: "stale-destination", updatedAt: 10 });
      assignSessionOwner(
        { ...scope(), sessionKey: canonicalKey },
        {
          owner: { type: "human", id: "profile-stale" },
          assignedBy: { type: "human", id: "profile-stale-assigner" },
          assignedAt: 10,
        },
      );
      insert(winnerKey, { sessionId: "selected-winner", updatedAt: 20 });
      const owner = assignSessionOwner(
        { ...scope(), sessionKey: winnerKey },
        {
          owner: { type: "human", id: "profile-winner" },
          assignedBy: { type: "agent", id: "research" },
          assignedAt: 1234,
        },
      );
      database()
        .db.prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?")
        .run(
          JSON.stringify({
            sessionId: "selected-winner",
            updatedAt: 20,
            delivery: normalizeSessionDeliveryState({
              context: { channel: "matrix", to: "!Owner:example.org" },
            }),
          }),
          winnerKey,
        );
      await expectRepair({ foundGroups: 1, repairedGroups: 1 });
      expect(load(canonicalKey)?.entry.owner).toEqual(owner);
    });
  });

  it("restores a valid node after an empty alias steals its transcript window", async () => {
    await withStateDirEnv("openclaw-doctor-transcript-owner-", async ({ stateDir }) => {
      const { insert, load, database, transcript, expectRepair } =
        createCanonicalRepairFixture(stateDir);
      const canonicalKey = "agent:main:main";
      const staleKey = "agent:main:telegram:default:direct:fixture-peer";
      const sessionId = "stolen-owner-session";
      insert(
        canonicalKey,
        { label: "canonical metadata", sessionId, updatedAt: 20 },
        "preserved history",
      );
      const db = database();
      db.db
        .prepare(
          "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at) VALUES (?, ?, '{}', ?)",
        )
        .run(staleKey, sessionId, 30);
      db.db
        .prepare("UPDATE session_nodes SET entry_valid = 1 WHERE session_key = ?")
        .run(canonicalKey);
      db.db
        .prepare("UPDATE session_windows SET session_key = ? WHERE session_id = ?")
        .run(staleKey, sessionId);

      await expectRepair({ foundGroups: 1, repairedGroups: 0 }, false);
      await expectRepair({ foundGroups: 1, removedRows: 1, repairedGroups: 1 });
      expect(load(staleKey)).toBeUndefined();
      expect(load(canonicalKey)?.entry).toMatchObject({ label: "canonical metadata", sessionId });
      expect(
        db.db
          .prepare("SELECT session_key FROM session_windows WHERE session_id = ?")
          .get(sessionId),
      ).toEqual({ session_key: canonicalKey });
      await transcript(canonicalKey, sessionId, "preserved history");
      await expectRepair({ foundGroups: 0, repairedGroups: 0 });
    });
  });
});
