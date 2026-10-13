import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { loadSessionEntry } from "../config/sessions/session-accessor.sqlite-entry.js";
import { importSqliteSessionRows } from "../config/sessions/session-accessor.sqlite-import.test-support.js";
import { loadTranscriptEventsSync } from "../config/sessions/session-accessor.sqlite-read.js";
import { assertSessionStoreMigrationComplete } from "../config/sessions/startup-migration.js";
import { recordDeferredPluginMigrations } from "../infra/deferred-plugin-migrations.js";
import { createTranscriptEventReader } from "../infra/session-sqlite-migration-readers.js";
import * as pluginDoctor from "../infra/state-migrations.plugin-doctor.js";
import {
  RECOVERY_TRANSCRIPT_LINES,
  readMigrationManifest,
  useDoctorSessionSqliteTestFixture,
} from "./doctor-session-sqlite.test-support.js";
import { noteSessionTranscriptHealth } from "./doctor-session-transcripts.js";

const { createLegacyStore } = useDoctorSessionSqliteTestFixture();
afterEach(() => vi.restoreAllMocks());

it.each(["matching", "conflicting", "malformed", "pending-plugin"] as const)(
  "continues Doctor and later plugin repairs with %s residual history and an unreadable receipt",
  async (history) => {
    const store = createLegacyStore({ transcriptLines: RECOVERY_TRANSCRIPT_LINES });
    const pendingPlugin = history === "pending-plugin";
    if (pendingPlugin) {
      await recordDeferredPluginMigrations({
        env: store.env,
        pending: [
          {
            pluginId: "fixture-plugin",
            reason: "Fixture plugin still needs session inputs",
            command: "openclaw doctor --fix",
            requiresStateMigration: true,
          },
        ],
      });
    }
    const scope = {
      agentId: "main",
      env: store.env,
      sessionKey: "agent:main:main",
      storePath: store.storePath,
    };
    await importSqliteSessionRows({
      ...scope,
      entry: { sessionId: "session-1", label: "Current metadata", updatedAt: 5000 },
      readTranscriptEvents: createTranscriptEventReader(store.transcriptPath, "session-1"),
    });
    const transcriptScope = { ...scope, sessionId: "session-1" };
    const currentHistory = loadTranscriptEventsSync(transcriptScope);
    const runsDir = path.join(store.stateDir, "session-sqlite-migration-runs");
    fs.mkdirSync(runsDir, { recursive: true });
    const unreadableManifest = path.join(runsDir, "unreadable.json");
    fs.writeFileSync(unreadableManifest, "{");
    if (history === "conflicting" || pendingPlugin) {
      fs.writeFileSync(
        store.transcriptPath,
        fs.readFileSync(store.transcriptPath, "utf8").replace("preserved history", "conflict"),
      );
    } else if (history === "malformed") {
      fs.appendFileSync(store.transcriptPath, "{broken\n");
    }
    const original = fs.readFileSync(store.transcriptPath);
    const siblingDir = path.join(store.stateDir, "agents", "other", "sessions");
    fs.mkdirSync(siblingDir, { recursive: true });
    const siblingStore = path.join(siblingDir, "sessions.json");
    fs.writeFileSync(
      siblingStore,
      JSON.stringify({ "agent:other:main": { sessionId: "new-session", updatedAt: 1000 } }),
    );
    const newEvents = [
      {
        type: "session",
        version: 3,
        id: "new-session",
        cwd: "/fixture",
        timestamp: "2026-08-30T00:00:00Z",
      },
      { type: "message", id: "new", parentId: null, message: { role: "user", content: "new" } },
    ];
    const index = JSON.parse(fs.readFileSync(store.storePath, "utf8"));
    index["agent:main:new"] = { sessionId: "new-session", updatedAt: 1000 };
    fs.writeFileSync(store.storePath, JSON.stringify(index));
    fs.writeFileSync(
      path.join(store.sessionDir, "new-session.jsonl"),
      newEvents.map((event) => JSON.stringify(event)).join("\n") + "\n",
    );
    fs.writeFileSync(
      path.join(siblingDir, "new-session.jsonl"),
      newEvents.map((event) => JSON.stringify(event)).join("\n") + "\n",
    );
    // Observe the real session gate without running unrelated plugin discovery and hooks.
    const laterRepair = vi
      .spyOn(pluginDoctor, "runPostSessionPluginDoctorStateRepairs")
      .mockResolvedValue({ changes: [], warnings: [] });
    const warnings: string[] = [];
    const cfg = { agents: { entries: { main: {}, other: {} } } };

    await noteSessionTranscriptHealth({
      cfg,
      env: store.env,
      shouldRepair: true,
      onWarnings: (messages) => warnings.push(...messages),
    });

    expect(laterRepair).toHaveBeenCalledOnce();
    expect(() =>
      assertSessionStoreMigrationComplete({ cfg, env: store.env, operation: "doctor" }),
    ).not.toThrow();
    expect(loadSessionEntry(scope)).toMatchObject({
      label: "Current metadata",
      sessionId: "session-1",
    });
    expect(loadTranscriptEventsSync(transcriptScope)).toEqual(currentHistory);
    expect(loadTranscriptEventsSync({ ...scope, sessionId: "new-session" })).toEqual(newEvents);
    expect(
      loadTranscriptEventsSync({ agentId: "other", env: store.env, sessionId: "new-session" }),
    ).toEqual(newEvents);
    expect(fs.existsSync(siblingStore)).toBe(pendingPlugin);
    if (history !== "matching") {
      expect(warnings).toContainEqual(expect.stringContaining("[legacy_import_deferred]"));
      if (history === "conflicting") {
        expect(warnings).toContainEqual(expect.stringContaining("conflicts with the SQLite event"));
      }
    } else {
      expect(warnings).toEqual([]);
    }
    expect(fs.existsSync(store.storePath)).toBe(pendingPlugin);
    if (pendingPlugin) {
      expect(fs.readFileSync(store.transcriptPath)).toEqual(original);
      expect(warnings).toContainEqual(expect.stringContaining("plugin_migration_source_retained"));
      return;
    }
    const manifests = fs
      .readdirSync(runsDir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => path.join(runsDir, name))
      .filter((name) => name !== unreadableManifest)
      .map(readMigrationManifest);
    const move = manifests
      .flatMap((manifest) => manifest.targets.flatMap((target) => target.completedMoves))
      .find((candidate) => candidate.sourcePath === store.transcriptPath);
    expect(move).toBeDefined();
    expect(fs.readFileSync(move!.archivePath)).toEqual(original);
    expect(move!.artifact?.classification).toBe(history === "matching" ? "imported" : "protected");
  },
);
