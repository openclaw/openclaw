import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as tar from "tar";
import { expect, it, vi } from "vitest";
import { createBackupResourcePlan } from "../commands/backup-resource-inventory.js";
import { backupRestoreCommand } from "../commands/backup-restore.js";
import { verifyBackupArchive } from "../commands/backup-verify.js";
import { createTestRuntime } from "../commands/test-runtime-config-helpers.js";
import { loadPluginManifest } from "../plugins/manifest.js";
import { buildBackupArchivePath } from "./backup-archive-path-policy.js";
import { createBackupArchive } from "./backup-create.js";
import { withIsolatedBackupState } from "./backup-create.test-support.js";
import { resolveDatabaseFamilyEngines } from "./database-engine/registry.js";

const mocks = vi.hoisted(() => ({ registry: vi.fn(), exportPostgres: vi.fn(), plan: vi.fn() }));
// PostgreSQL discovery is the external fixture; archive creation and recovery remain real.
vi.mock("../commands/backup-shared.js", async (original) => ({
  ...(await original<typeof import("../commands/backup-shared.js")>()),
  resolveBackupPlanFromDisk: mocks.plan,
}));
vi.mock("../state/openclaw-agent-db-registry-listing.js", async (original) => ({
  ...(await original<typeof import("../state/openclaw-agent-db-registry-listing.js")>()),
  inspectOpenClawRegisteredAgentDatabases: mocks.registry,
}));
vi.mock("../snapshot/database-backup.js", async (original) => ({
  ...(await original<typeof import("../snapshot/database-backup.js")>()),
  capturePostgresBackup: mocks.exportPostgres,
}));

it("combines companion and template exclusions without exporting PostgreSQL rows", async () => {
  await withIsolatedBackupState({ layout: "state-only", scenario: "empty" }, async (state) => {
    const shared = state.statePath("state/openclaw.sqlite");
    const agent = state.statePath("agents/retained/agent/openclaw-agent.sqlite");
    const client = state.statePath("client/credentials.sqlite");
    for (const { file, id } of [
      { file: shared, id: "shared-store" },
      { file: agent, id: "agent-store" },
    ]) {
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      using database = new DatabaseSync(file);
      database.exec(
        "CREATE TABLE openclaw_engine_anchor (store_id TEXT, engine TEXT, schema TEXT)",
      );
      database
        .prepare("INSERT INTO openclaw_engine_anchor VALUES (?, 'postgres', ?)")
        .run(id, `${id.replaceAll("-", "_")}_namespace`);
    }
    await fs.mkdir(path.dirname(client), { recursive: true, mode: 0o700 });
    {
      using database = new DatabaseSync(client);
      database.exec(
        "CREATE TABLE native_exec_socket_credentials (socket_token TEXT); CREATE TABLE client_credential_migration (version INTEGER, source_store TEXT, phase TEXT)",
      );
      database.exec("INSERT INTO native_exec_socket_credentials VALUES ('synthetic-retained-key')");
    }
    mocks.registry.mockResolvedValue([
      { agentId: "retained", path: agent, schemaVersion: 23, lastSeenAt: 1, sizeBytes: null },
    ]);
    mocks.exportPostgres.mockImplementation(() => {
      throw new Error("Companion capture must not export database rows");
    });
    const codexHome = path.join(path.dirname(agent), "codex-home");
    await fs.mkdir(path.join(codexHome, "sessions"), { recursive: true });
    const diagnostics = [
      "logs_2.sqlite",
      "logs_2.sqlite-wal",
      "logs_2.sqlite-shm",
      "logs_2.sqlite-journal",
    ];
    const durable = [
      "state_5.sqlite",
      "auth.json",
      "sessions/rollout.jsonl",
      "logs_2.sqlite.backup",
    ];
    for (const relative of [...diagnostics, ...durable]) {
      await fs.writeFile(path.join(codexHome, relative), `synthetic ${relative}`);
    }
    const template = state.statePath("worktrees/template-generation");
    const templateCache = path.join(template, "cache.bin");
    await fs.mkdir(template, { recursive: true });
    await fs.writeFile(templateCache, "regenerable template");
    const unrelatedLog = state.statePath("logs_2.sqlite");
    await fs.writeFile(unrelatedLog, "unrelated user database");
    const codex = loadPluginManifest(path.resolve("extensions/codex"));
    expect(codex.ok).toBe(true);
    if (!codex.ok) {
      throw new Error(codex.error);
    }
    const resourceInput = {
      stateDir: state.stateDir,
      configPaths: [],
      oauthDirs: [],
      workspaceDirs: [],
      excludedWorkspaceDirs: [],
      agentRoots: [{ agentId: "retained", sourcePath: path.dirname(agent), databasePath: agent }],
      pluginResources: (codex.manifest.backupResources ?? []).map((resource) =>
        Object.assign({}, resource, { pluginId: "codex" }),
      ),
      pluginRoots: [],
    };
    const fullResources = await createBackupResourcePlan(resourceInput);
    for (const relative of diagnostics) {
      expect(fullResources.isIncluded(path.join(codexHome, relative))).toBe(true);
    }
    const nowMs = Date.parse("2026-10-16T00:00:00Z");
    const { buildBackupArchiveRoot } = await import("../commands/backup-shared.js");
    const archiveRoot = buildBackupArchiveRoot(nowMs);
    mocks.plan.mockImplementation(
      async (
        options: Parameters<
          typeof import("../commands/backup-shared.js").resolveBackupPlanFromDisk
        >[0] = {},
      ) => ({
        resources: await createBackupResourcePlan({
          ...resourceInput,
          localCompanion: options.localCompanion,
          excludedWorktreeTemplateDirs: options.excludeWorktreeTemplates ? [template] : [],
        }),
        stateDir: state.stateDir,
        configPath: state.configPath,
        oauthDir: state.statePath("credentials"),
        workspaceDirs: [],
        skipped: [],
        included: [
          {
            kind: "state",
            sourcePath: state.stateDir,
            displayPath: state.stateDir,
            archivePath: buildBackupArchivePath(archiveRoot, state.stateDir),
          },
        ],
        databaseSelection: {
          effectiveEngines: resolveDatabaseFamilyEngines({ database: { engine: "postgres" } }),
          postgres: { connection: "postgresql://synthetic-unreachable", schemaPrefix: "synthetic" },
        },
      }),
    );
    const result = await createBackupArchive({
      output: state.path("companion.tar.gz"),
      localCompanion: true,
      excludeWorktreeTemplates: true,
      nowMs,
    });
    await expect(verifyBackupArchive(result.archivePath)).resolves.toMatchObject({
      ok: true,
      profile: "local-companion",
    });
    const target = state.path("restore");
    await backupRestoreCommand(createTestRuntime(), {
      archive: result.archivePath,
      target,
      localCompanion: true,
    });
    const manifest = JSON.parse(
      await fs.readFile(path.join(target, archiveRoot, "manifest.json"), "utf8"),
    );
    expect(manifest.postgresSnapshots).toEqual([]);
    expect(manifest.postgresAnchors).toEqual(
      expect.arrayContaining([
        { sourcePath: shared, storeId: "shared-store", namespace: "shared_store_namespace" },
        { sourcePath: agent, storeId: "agent-store", namespace: "agent_store_namespace" },
      ]),
    );
    expect(manifest.postgresAnchors).toHaveLength(2);
    expect(mocks.exportPostgres).not.toHaveBeenCalled();
    await expect(
      fs.stat(path.join(target, buildBackupArchivePath(archiveRoot, templateCache))),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(templateCache, "utf8")).toBe("regenerable template");
    for (const relative of diagnostics) {
      const source = path.join(codexHome, relative);
      await expect(
        fs.stat(path.join(target, buildBackupArchivePath(archiveRoot, source))),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(await fs.readFile(source, "utf8")).toBe(`synthetic ${relative}`);
    }
    for (const relative of durable) {
      expect(
        await fs.readFile(
          path.join(target, buildBackupArchivePath(archiveRoot, path.join(codexHome, relative))),
          "utf8",
        ),
      ).toBe(`synthetic ${relative}`);
    }
    expect(
      await fs.readFile(
        path.join(target, buildBackupArchivePath(archiveRoot, unrelatedLog)),
        "utf8",
      ),
    ).toBe("unrelated user database");
    const entries: string[] = [];
    await tar.t({
      file: result.archivePath,
      onentry: (entry) => {
        entries.push(entry.path);
        entry.resume();
      },
    });
    expect(entries.some((entry) => entry.includes(".postgres/"))).toBe(false);
    using copied = new DatabaseSync(
      path.join(target, buildBackupArchivePath(archiveRoot, client)),
      { readOnly: true },
    );
    expect(
      copied.prepare("SELECT socket_token FROM native_exec_socket_credentials").get(),
    ).toMatchObject({ socket_token: "synthetic-retained-key" });
  });
});
