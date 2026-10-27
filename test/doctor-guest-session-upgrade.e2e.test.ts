import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { ensureControlUiAssetsBuilt } from "../src/infra/control-ui-assets.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../src/state/openclaw-agent-db-contract.js";
import { OPENCLAW_AGENT_SCHEMA_V25_SQL } from "../src/state/openclaw-agent-schema-v25.test-support.js";
import { readBuildIdFromBuildInfoForModuleUrl } from "../src/version.js";
import { createOpenClawTestInstance } from "./helpers/openclaw-test-instance.js";

it(
  "preserves released memberships and mention watermarks when enabling invited guest access",
  { timeout: 180_000 },
  async () => {
    const instance = await createOpenClawTestInstance({
      name: "doctor-guest-session-upgrade",
      config: {
        agents: { entries: { main: {} } },
        gateway: {
          roles: {
            default: "guest",
            definitions: {
              guest: {
                agents: ["main"],
                scopes: ["operator.sessions.read", "operator.sessions.write"],
                sessions: { others: "none" },
              },
            },
          },
        },
      },
    });
    try {
      // CI runtime artifacts omit UI assets. Prepare the complete install before
      // timing doctor so its source UI build cannot consume the migration deadline.
      const [entrypoint] = await instance.entrypoint();
      const buildId = readBuildIdFromBuildInfoForModuleUrl(
        pathToFileURL(path.resolve(entrypoint!)).href,
      );
      expect(buildId).not.toBeNull();
      const ui = await ensureControlUiAssetsBuilt(undefined, {
        root: process.cwd(),
        expectedBuildId: buildId,
      });
      expect(ui.ok, ui.ok ? undefined : ui.message).toBe(true);
      const databasePath = path.join(
        instance.stateDir,
        "agents",
        "main",
        "agent",
        "openclaw-agent.sqlite",
      );
      fs.mkdirSync(path.dirname(databasePath), { recursive: true });
      const sessionKey = "agent:main:upgrade-member";
      // A personal hide must retain its watermark so old mentions cannot become new invitations.
      const expectedInvolvement = {
        key: sessionKey,
        profiles: {
          guest: {
            hidden: true,
            updatedAt: 2,
            lastMention: { generation: "upgrade-member", sequence: 1, timestamp: 1 },
          },
        },
      };
      // Seed a complete retained transcript so doctor does not repair a missing header.
      const header = JSON.stringify({
        type: "session",
        version: 3,
        id: "upgrade-member",
        timestamp: "2026-10-07T00:00:00.000Z",
        cwd: "/workspace",
      });
      const event = JSON.stringify({
        type: "message",
        id: "upgrade-message",
        parentId: null,
        timestamp: "2026-10-07T00:00:00.000Z",
        message: { role: "user", content: "Retained guest conversation", timestamp: 1 },
      });
      {
        using database = new DatabaseSync(databasePath);
        // This frozen fixture is byte-identical to the v2026.10.7 release schema.
        database.exec(OPENCLAW_AGENT_SCHEMA_V25_SQL);
        database.exec(`
        PRAGMA user_version = 25;
        INSERT INTO schema_meta (meta_key, role, schema_version, agent_id, created_at, updated_at)
        VALUES ('primary', 'agent', 25, 'main', 1, 1);
      `);
        for (const sessionId of ["upgrade-member", "upgrade-private"]) {
          const key = `agent:main:${sessionId}`;
          database
            .prepare(`INSERT INTO session_nodes
          (session_key, current_session_id, entry_json, entry_valid, updated_at)
          VALUES (?, ?, ?, 1, 1)`)
            .run(
              key,
              sessionId,
              JSON.stringify({
                sessionId,
                updatedAt: 1,
                createdActor: { type: "human", source: "profile", id: "owner" },
                visibility: "shared",
                ...(sessionId === "upgrade-member"
                  ? { profileInvolvement: expectedInvolvement }
                  : {}),
              }),
            );
          database
            .prepare(`INSERT INTO session_windows
          (session_id, session_key, reason, created_at, updated_at)
          VALUES (?, ?, 'initial', 1, 1)`)
            .run(sessionId, key);
        }
        database
          .prepare(`INSERT INTO session_members (session_key, identity_id, added_by, added_at)
        VALUES (?, 'guest', 'owner', 1)`)
          .run(sessionKey);
        database
          .prepare(`INSERT INTO transcript_events (session_id, seq, event_json, created_at)
        VALUES ('upgrade-member', 0, ?, 1), ('upgrade-member', 1, ?, 1)`)
          .run(header, event);
        expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(25);
      }

      for (const others of ["none", "invited", "invited"] as const) {
        const cfg = JSON.parse(fs.readFileSync(instance.configPath, "utf8")) as OpenClawConfig;
        cfg.gateway!.roles!.definitions.guest!.sessions!.others = others;
        await instance.state.writeConfig(cfg);
        const doctor = await instance.cli(
          ["doctor", "--fix", "--non-interactive", "--yes", "--no-workspace-suggestions"],
          { timeoutMs: 60_000 },
        );
        expect(doctor.code, `${doctor.stdout}\n${doctor.stderr}`).toBe(0);
        const updated = JSON.parse(fs.readFileSync(instance.configPath, "utf8")) as OpenClawConfig;
        expect(updated.gateway?.roles?.definitions.guest?.sessions?.others).toBe(others);
        using database = new DatabaseSync(databasePath, { readOnly: true });
        expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(
          OPENCLAW_AGENT_SCHEMA_VERSION,
        );
        expect(database.prepare("SELECT * FROM session_members").all()).toEqual([
          { session_key: sessionKey, identity_id: "guest", added_by: "owner", added_at: 1 },
        ]);
        const entry = database
          .prepare("SELECT entry_json FROM session_nodes WHERE session_key = ?")
          .get(sessionKey);
        expect(entry).toMatchObject({ entry_json: expect.any(String) });
        expect(JSON.parse(entry!.entry_json as string).profileInvolvement).toEqual(
          expectedInvolvement,
        );
        expect(
          database.prepare("SELECT event_json FROM transcript_events ORDER BY seq").all(),
        ).toEqual([{ event_json: header }, { event_json: event }]);
      }
    } finally {
      await instance.cleanup();
    }
  },
);
