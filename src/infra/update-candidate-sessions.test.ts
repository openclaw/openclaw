import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { runDoctorSessionSqlite } from "../commands/doctor-session-sqlite.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.sqlite-entry.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { recordDeferredPluginMigrations } from "./deferred-plugin-migrations.js";
import {
  moveMigrationArtifact,
  readMigrationArtifactIdentity,
} from "./session-sqlite-migration-artifact.js";
import {
  createSessionSqliteMigrationRun,
  recordCompletedMigrationMoves,
  recordPlannedMigrationMoves,
  updateMigrationManifestTarget,
  writeSessionSqliteMigrationManifest,
  type SessionSqliteMigrationMove,
} from "./session-sqlite-migration-manifest.js";
import { resolveTargetSqlitePath } from "./session-sqlite-migration-readers.js";
import { prepareUpdateCandidateSessions } from "./update-candidate-sessions.js";
import { readUpdateCandidateStateInventoryInProcess } from "./update-candidate-state.js";
import { snapshotUpdateCandidateState } from "./update-candidate-state.snapshot.js";

it.each([false, true])(
  "copies shared-store transcripts from each record's admitted agent (legacy main alias: %s)",
  async (legacyMainAlias) => {
    await withOpenClawTestState({ label: "snapshot-session-owners" }, async (state) => {
      const storePath = state.statePath("shared", "sessions.json");
      const config: OpenClawConfig = {
        agents: {
          entries: legacyMainAlias
            ? { ops: { default: true } }
            : { main: { default: true }, ops: {} },
        },
        session: { store: storePath },
      };
      const records: Record<string, unknown> = {};
      const owners = legacyMainAlias ? ["ops"] : ["main", "ops"];
      const key = (agentId: string) => `agent:${legacyMainAlias ? "main" : agentId}:main`;
      for (const agentId of owners) {
        await state.writeText(`agents/${agentId}/sessions/shared.jsonl`, `${agentId} transcript`);
        records[key(agentId)] = {
          sessionId: "shared",
          sessionFile: state.path("old-root", "agents", agentId, "sessions", "shared.jsonl"),
          updatedAt: 1,
        };
      }
      await state.writeJson("shared/sessions.json", records);
      const inputs = await prepareUpdateCandidateSessions({
        config,
        stateDir: state.stateDir,
        env: state.env,
      });
      const target = state.path("private");
      await fs.mkdir(target);
      const projection = inputs.project(target, true);
      await inputs.copy(target, projection.path, new Set());
      const copied = JSON.parse(await fs.readFile(projection.sessionStore!, "utf8"));
      for (const agentId of owners) {
        const selected = copied[key(agentId)].sessionFile;
        expect(selected.startsWith(`${target}${path.sep}`)).toBe(true);
        expect(await fs.readFile(selected, "utf8")).toBe(`${agentId} transcript`);
      }
      expect(JSON.parse(await fs.readFile(storePath, "utf8"))).toEqual(records);
    });
  },
);

it("refuses a newly preferred transcript instead of publishing an unadmitted locator", async () => {
  await withOpenClawTestState({ label: "snapshot-session-selection" }, async (state) => {
    const foreign = state.path("old-root", "agents", "main", "sessions", "selected.jsonl");
    await fs.mkdir(path.dirname(foreign), { recursive: true });
    await fs.writeFile(foreign, "captured foreign transcript");
    await state.writeJson("agents/main/sessions/sessions.json", {
      "agent:main:main": { sessionId: "selected", sessionFile: foreign, updatedAt: 1 },
    });
    const inputs = await prepareUpdateCandidateSessions({
      config: { agents: { entries: { main: {} } } },
      stateDir: state.stateDir,
      env: state.env,
    });
    await state.writeText("agents/main/sessions/selected.jsonl", "new preferred transcript");
    const target = state.path("private");
    await fs.mkdir(target);
    await expect(inputs.copy(target, inputs.project(target, true).path, new Set())).rejects.toThrow(
      "transcript selection changed before snapshot",
    );
    expect(await fs.readFile(foreign, "utf8")).toBe("captured foreign transcript");
  });
});

it("refuses configured file-era input when the installed caller cannot project its selector", async () => {
  await withOpenClawTestState({ label: "snapshot-old-session-caller" }, async (state) => {
    const storePath = await state.writeJson("custom/sessions.json", {
      "agent:main:main": { sessionId: "old", updatedAt: 1 },
    });
    const input = {
      config: { agents: { entries: { main: {} } }, session: { store: storePath } },
      stateDir: state.stateDir,
      env: state.env,
      targetStateDir: state.path("private"),
      candidateRoot: fileURLToPath(new URL("../../", import.meta.url)),
    };
    const inventory = await readUpdateCandidateStateInventoryInProcess(input);
    await expect(
      snapshotUpdateCandidateState({
        ...input,
        pluginPlanPath: path.join(input.targetStateDir, inventory.pluginPlan),
        databaseInventory: [...inventory.databases.keys()],
      }),
    ).rejects.toThrow("same state and configuration before retrying");
    await expect(
      fs.access(path.join(input.targetStateDir, "state", "openclaw.sqlite")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(await fs.readFile(storePath, "utf8"))).toMatchObject({
      "agent:main:main": { sessionId: "old" },
    });
  });
});

it.each([false, true])(
  "warns about optional historical recovery (retained receipt: %s)",
  async (retained) => {
    await withOpenClawTestState({ label: "snapshot-session-archive" }, async (state) => {
      const storePath = state.statePath("agents", "main", "sessions", "sessions.json");
      const config: OpenClawConfig = { agents: { entries: { main: { default: true } } } };
      if (retained) {
        await state.writeJson("agents/main/sessions/sessions.json", {});
        await upsertSessionEntryCore(
          { agentId: "main", storePath, env: state.env, sessionKey: "agent:main:current" },
          { sessionId: "current", updatedAt: 1 },
        );
        await recordDeferredPluginMigrations({
          env: state.env,
          pending: [
            {
              pluginId: "fixture-plugin",
              reason: "Plugin unavailable",
              command: "openclaw doctor --fix",
            },
          ],
        });
        const imported = await runDoctorSessionSqlite({
          cfg: config,
          env: state.env,
          mode: "import",
          allAgents: true,
        });
        expect(imported.totals.importedEntries).toBe(0);
        expect(imported.targets.flatMap((target) => target.issues)).toContainEqual(
          expect.objectContaining({ code: "plugin_migration_source_retained" }),
        );
        await recordDeferredPluginMigrations({
          env: state.env,
          pending: [],
          resolvedPluginIds: ["fixture-plugin"],
        });
        await fs.unlink(storePath);
      }
      const source = await state.writeText(
        "agents/main/sessions/retained.jsonl",
        '{"type":"session","version":3,"id":"retained"}\n',
      );
      const target = {
        agentId: "main",
        storePath,
        sqlitePath: resolveTargetSqlitePath({ agentId: "main", storePath }, state.env),
      };
      const archive = state.statePath(
        "agents",
        "main",
        "session-sqlite-import-archive",
        "retained.jsonl.imported-1",
      );
      await fs.mkdir(path.dirname(archive), { recursive: true });
      // Model the existing pre-indexed-history archive contract through its real artifact owner.
      const run = createSessionSqliteMigrationRun(state.env, [target]);
      const move: SessionSqliteMigrationMove = {
        kind: "unreferenced-jsonl",
        sourcePath: source,
        archivePath: archive,
        artifact: {
          identity: readMigrationArtifactIdentity(source),
          classification: "protected",
          reason: "unreferenced-history",
          dependencies: [],
          disposal: { state: "retained" },
        },
      };
      recordPlannedMigrationMoves(run, target, [move]);
      await moveMigrationArtifact(source, archive, move.artifact!.identity);
      recordCompletedMigrationMoves(run, target, [move]);
      updateMigrationManifestTarget(run, target, [], { validationBeforeArchive: "passed" });
      run.manifest.completedAt = new Date().toISOString();
      writeSessionSqliteMigrationManifest(run);
      const bytes = await fs.readFile(archive);
      let captureIndex = 0;
      const capture = () =>
        readUpdateCandidateStateInventoryInProcess({
          config,
          stateDir: state.stateDir,
          env: state.env,
          targetStateDir: state.path("inventory", String(captureIndex++)),
          candidateRoot: fileURLToPath(new URL("../../", import.meta.url)),
        });
      const inputs = await capture();
      expect(inputs.warnings).toEqual([
        expect.stringContaining("Optional archived session recovery was not rehearsed"),
      ]);
      expect(inputs.legacySessionBytes).toBe(0);
      expect(await fs.readFile(archive)).toEqual(bytes);
      await expect(fs.access(source)).rejects.toMatchObject({ code: "ENOENT" });
      // An acknowledged historical import must not be offered again after user deletion.
      move.artifact!.reason = "indexed-historical-primary";
      recordPlannedMigrationMoves(run, target, [move]);
      recordCompletedMigrationMoves(run, target, [move]);
      writeSessionSqliteMigrationManifest(run);
      expect((await capture()).warnings).toEqual([]);
    });
  },
);

it("preserves Doctor's refusal of an aliased legacy index directory", async () => {
  await withOpenClawTestState({ label: "snapshot-session-alias" }, async (state) => {
    const original = await state.writeJson("owned-sessions/sessions.json", {
      "agent:main:main": { sessionId: "original", updatedAt: 1 },
    });
    const alias = state.statePath("linked-sessions");
    await fs.symlink(path.dirname(original), alias, "junction");
    const bytes = await fs.readFile(original);
    await expect(
      prepareUpdateCandidateSessions({
        config: {
          agents: { entries: { main: {} } },
          session: { store: path.join(alias, "sessions.json") },
        },
        stateDir: state.stateDir,
        env: state.env,
      }),
    ).rejects.toThrow("Refusing session SQLite migration through symbolic link");
    expect(await fs.readFile(original)).toEqual(bytes);
  });
});
