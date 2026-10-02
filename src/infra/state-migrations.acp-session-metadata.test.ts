import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { inspectAcpSessionClaimsForDoctor } from "../acp/runtime/session-meta-doctor.js";
import {
  buildAcpDatabaseSessionKey,
  selectAcpSessionRow,
} from "../acp/runtime/session-meta-keys.js";
import { writeAcpSessionMetaForMigration } from "../acp/runtime/session-meta.js";
import { noteSessionTranscriptHealth } from "../commands/doctor-session-transcripts.js";
import { loadTranscriptEvents } from "../config/sessions/session-accessor.sqlite-read.js";
import type { SessionAcpMeta } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { EMPTY_LEGACY_SESSION_SURFACES } from "../plugins/legacy-session-surfaces.types.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { migrateLegacyAcpSessionMetadata } from "./state-migrations.session-store.js";

it.each(["none", "matching", "different", "unbound"] as const)(
  "imports configured ACP binding ownership before session repair (current metadata: %s)",
  async (currentBinding) => {
    await withOpenClawTestState({ label: "acp-binding-owner-import" }, async (state) => {
      const agentId = "ops";
      // v2026.5.28 stored configured binding metadata in sessions.json. These
      // identities deliberately do not qualify for the later free-ACP alias repair.
      const sessionKey = "agent:ops:acp:binding:discord:default:af00112233445566";
      const sessionId = "configured-binding-session";
      const cfg: OpenClawConfig = {
        agents: { entries: { [agentId]: { default: true, workspace: state.workspaceDir } } },
        plugins: { enabled: false },
      };
      await state.writeConfig(cfg);
      const meta: SessionAcpMeta = {
        backend: "acpx",
        agent: "fixture",
        runtimeSessionName: "legacy-binding-runtime",
        mode: "persistent",
        state: "idle",
        lastActivityAt: 100,
      };
      const currentMeta = {
        ...meta,
        runtimeSessionName: "current-binding-runtime",
        lastActivityAt: 200,
      };
      const storePath = await state.writeJson(`agents/${agentId}/sessions/sessions.json`, {
        [sessionKey]: { sessionId, updatedAt: 100, acp: meta },
      });
      const message = {
        type: "message",
        id: "history-message",
        parentId: null,
        message: { role: "user", content: "Keep this binding's history." },
      };
      await state.writeText(
        `agents/${agentId}/sessions/${sessionId}.jsonl`,
        [{ type: "session", version: 3, id: sessionId }, message]
          .map((event) => JSON.stringify(event))
          .join("\n") + "\n",
      );
      const databaseKey = buildAcpDatabaseSessionKey(sessionKey, agentId);
      if (currentBinding !== "none") {
        writeAcpSessionMetaForMigration({
          sessionKey: databaseKey,
          sessionId:
            currentBinding === "unbound"
              ? undefined
              : currentBinding === "different"
                ? "different-binding-session"
                : sessionId,
          meta: currentMeta,
          env: state.env,
          now: () => 200,
        });
      }

      const migrate = () =>
        migrateLegacyAcpSessionMetadata({
          cfg,
          env: state.env,
          now: () => 300,
          pluginSessionStoreAgentIds: [],
          legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
        });
      if (currentBinding === "different" || currentBinding === "unbound") {
        const original = fs.readFileSync(storePath);
        const database = openOpenClawStateDatabase({ env: state.env });
        const current = selectAcpSessionRow(database.db, databaseKey);
        await expect(migrate()).rejects.toThrow(
          "Canonical ACP metadata has a conflicting session binding",
        );
        expect(fs.readFileSync(storePath)).toEqual(original);
        expect(selectAcpSessionRow(database.db, databaseKey)).toEqual(current);
        expect(selectAcpSessionRow(database.db, sessionKey)).toBeUndefined();
        return;
      }
      expect((await migrate()).warnings).toEqual([]);
      // Preserve Doctor's real order: metadata extraction precedes session import
      // and canonical-row repair; only then may a plugin inspect owner claims.
      await noteSessionTranscriptHealth({
        cfg,
        env: state.env,
        shouldRepair: true,
        postSessionPluginMigrationPlanBound: true,
      });
      const claims = await inspectAcpSessionClaimsForDoctor({
        config: cfg,
        env: state.env,
        pluginId: "acpx",
      });
      expect(claims.incomplete).toEqual([]);
      expect(claims.claims).toEqual([
        expect.objectContaining({
          agentId,
          sessionKey,
          binding: expect.objectContaining({ sessionId }),
          meta: currentBinding === "matching" ? currentMeta : meta,
        }),
      ]);
      const database = openOpenClawStateDatabase({ env: state.env });
      expect(selectAcpSessionRow(database.db, databaseKey)?.runtime_session_name).toBe(
        currentBinding === "matching" ? currentMeta.runtimeSessionName : meta.runtimeSessionName,
      );
      expect(selectAcpSessionRow(database.db, sessionKey)).toBeUndefined();
      await expect(
        loadTranscriptEvents({ agentId, sessionKey, sessionId, storePath, env: state.env }),
      ).resolves.toContainEqual(message);
      await expect(migrate()).resolves.toEqual({ changes: [], warnings: [] });
      expect(fs.existsSync(path.join(path.dirname(storePath), `${sessionId}.jsonl`))).toBe(false);
    });
  },
);
