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
import { loadSessionTranscriptEvents } from "../config/sessions/session-transcript-events.js";
import type { SessionAcpMeta } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { EMPTY_LEGACY_SESSION_SURFACES } from "../plugins/legacy-session-surfaces.types.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { migrateLegacyAcpSessionMetadata } from "./state-migrations.session-store.js";

it.each(["plugin", "none", "matching", "different", "unbound"] as const)(
  "migrates ACP ownership with %s canonical metadata",
  async (currentBinding) => {
    await withOpenClawTestState({ label: "acp-owner-import" }, async (state) => {
      const plugin = currentBinding === "plugin";
      const agentId = plugin ? "voice" : "ops";
      const sessionId = plugin ? "plugin-session" : "configured-binding-session";
      // Keep configured bindings ineligible for the later free-ACP alias repair.
      const sessionKey = plugin
        ? "agent:voice:acp:plugin-session"
        : "agent:ops:acp:binding:discord:default:af00112233445566";
      const cfg: OpenClawConfig = {
        agents: {
          entries: plugin ? { main: {} } : { [agentId]: { workspace: state.workspaceDir } },
        },
        plugins: { enabled: false },
      };
      if (plugin) {
        cfg.session = { store: path.join(state.stateDir, "plugin-sessions", "{agentId}.json") };
      }
      await state.writeConfig(cfg);
      const meta: SessionAcpMeta = {
        backend: "acpx",
        agent: "fixture",
        mode: "persistent",
        state: "idle",
        lastActivityAt: 100,
        runtimeSessionName: plugin ? "plugin-owner-runtime" : "legacy-binding-runtime",
      };
      const storePath = await state.writeJson(
        plugin ? "plugin-sessions/voice.json" : `agents/${agentId}/sessions/sessions.json`,
        { [sessionKey]: { sessionId, updatedAt: 100, acp: meta } },
      );
      const databaseKey = buildAcpDatabaseSessionKey(sessionKey, agentId);
      const row = (key = databaseKey) =>
        selectAcpSessionRow(openOpenClawStateDatabase({ env: state.env }).db, key);
      const run = () =>
        migrateLegacyAcpSessionMetadata({
          cfg,
          env: state.env,
          now: () => 300,
          pluginSessionStoreAgentIds: plugin ? [agentId] : [],
          legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
        });
      if (plugin) {
        // Custom plugin stores are outside the canonical roster and directory scan.
        expect(await run()).toEqual({
          changes: ["Migrated 1 ACP session metadata row → shared SQLite state"],
          warnings: [],
        });
        expect(row()).toMatchObject({
          session_id: sessionId,
          runtime_session_name: meta.runtimeSessionName,
        });
        expect(JSON.parse(fs.readFileSync(storePath, "utf8"))[sessionKey]).not.toHaveProperty(
          "acp",
        );
        expect(cfg.agents?.entries).toEqual({ main: {} });
        return;
      }
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
      const currentMeta = {
        ...meta,
        runtimeSessionName: "current-binding-runtime",
        lastActivityAt: 200,
      };
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
      if (currentBinding === "different" || currentBinding === "unbound") {
        const original = fs.readFileSync(storePath);
        const current = row();
        await expect(run()).rejects.toThrow(
          "Canonical ACP metadata has a conflicting session binding",
        );
        expect(fs.readFileSync(storePath)).toEqual(original);
        expect(row()).toEqual(current);
        expect(row(sessionKey)).toBeUndefined();
        return;
      }
      expect((await run()).warnings).toEqual([]);
      // Doctor extracts metadata before repairing sessions and inspecting plugin claims.
      await noteSessionTranscriptHealth({
        cfg,
        env: state.env,
        shouldRepair: true,
        postSessionPluginMigrationPlanBound: true,
      });
      const expectedMeta = currentBinding === "matching" ? currentMeta : meta;
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
          meta: expectedMeta,
        }),
      ]);
      expect(row()?.runtime_session_name).toBe(expectedMeta.runtimeSessionName);
      expect(row(sessionKey)).toBeUndefined();
      await expect(
        loadSessionTranscriptEvents({ agentId, sessionKey, sessionId, storePath, env: state.env }),
      ).resolves.toContainEqual(message);
      await expect(run()).resolves.toEqual({ changes: [], warnings: [] });
      expect(fs.existsSync(path.join(path.dirname(storePath), `${sessionId}.jsonl`))).toBe(false);
    });
  },
);
