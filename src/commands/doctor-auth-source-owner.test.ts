// Doctor must discover, import, verify, and archive auth sources from one selected owner.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearAuthProfileMigrationDiagnostics } from "../agents/auth-profiles/legacy-source-diagnostic.js";
import { loadPersistedAuthProfileStore } from "../agents/auth-profiles/persisted.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "../agents/auth-profiles/runtime-snapshots.js";
import { closeAuthProfileReadPool } from "../agents/auth-profiles/sqlite.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { maybeMigrateAuthProfileJsonStoresToSqlite } from "./doctor-auth-flat-profiles.js";

const states: OpenClawTestState[] = [];
const sourceNames = ["auth-profiles.json", "auth-state.json", "auth.json"] as const;
const profileId = "owner-test:default";

async function createOwners(env: Record<string, string | undefined> = {}) {
  const create = async () => {
    const state = await createOpenClawTestState({
      prefix: "openclaw-doctor-auth-source-owner-",
      layout: "split",
      applyEnv: false,
      env: {
        OPENCLAW_AGENT_DIR: undefined,
        PI_CODING_AGENT_DIR: undefined,
        OPENCLAW_OAUTH_DIR: undefined,
        ...env,
      },
    });
    states.push(state);
    return state;
  };
  const selected = await create();
  const ambient = await create();
  ambient.applyEnv();
  return { selected, ambient };
}

function sourceValue(sourceName: (typeof sourceNames)[number], key: string, lastUsed: number) {
  const credential = { type: "api_key", provider: "owner-test", key };
  if (sourceName === "auth-state.json") {
    return { version: 1, usageStats: { [profileId]: { lastUsed } } };
  }
  return sourceName === "auth.json"
    ? { "owner-test": credential }
    : { version: 1, profiles: { [profileId]: credential } };
}

function writeSource(agentDir: string, sourceName: string, value: unknown) {
  fs.mkdirSync(agentDir, { recursive: true });
  const sourcePath = path.join(agentDir, sourceName);
  const bytes = `${JSON.stringify(value)}\n`;
  fs.writeFileSync(sourcePath, bytes);
  return { sourcePath, bytes };
}

function archivesFor(sourcePath: string) {
  return fs
    .readdirSync(path.dirname(sourcePath))
    .filter((name) => name.startsWith(`${path.basename(sourcePath)}.migrated-`))
    .map((name) => path.join(path.dirname(sourcePath), name));
}

afterEach(async () => {
  clearRuntimeAuthProfileStoreSnapshots();
  clearAuthProfileMigrationDiagnostics();
  closeAuthProfileReadPool();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  for (const state of states.splice(0).toReversed()) {
    await state.cleanup();
    expect(fs.existsSync(state.root)).toBe(false);
  }
});

describe("Doctor auth migration source ownership", () => {
  it.each([
    "shared-wal",
    "shared-shm",
    "shared-journal",
    "dangling-shared",
    "adjacent-database",
    "adjacent-sidecar",
    "configured-database",
    "configured-partition-sidecar",
    "configured-agent-directory",
    "missing-journal",
  ])("preserves credentials with unknown SQLite history: %s", async (kind) => {
    const { selected } = await createOwners();
    const source = writeSource(
      selected.agentDir(),
      "auth-profiles.json",
      sourceValue("auth-profiles.json", `fake-held-${randomUUID()}`, 20),
    );
    const cfg: OpenClawConfig = {};
    const sharedPath = resolveOpenClawStateSqlitePath(selected.env);
    const sharedDatabase =
      kind === "missing-journal" ? openOpenClawStateDatabase({ env: selected.env }) : undefined;
    let artifact: string | undefined;
    if (kind.startsWith("shared-")) {
      artifact = `${sharedPath}-${kind.slice("shared-".length)}`;
    } else if (kind === "dangling-shared") {
      const target = path.join(selected.root, "missing-shared-target");
      fs.mkdirSync(path.dirname(sharedPath), { recursive: true });
      fs.mkdirSync(target);
      fs.symlinkSync(target, sharedPath, "junction");
      fs.rmdirSync(target);
    } else if (kind.startsWith("adjacent-")) {
      artifact = path.join(
        selected.agentDir(),
        kind === "adjacent-database" ? "history.db" : "history.sqlite-wal",
      );
    } else if (kind === "configured-agent-directory") {
      const external = path.join(selected.root, "external-agent");
      cfg.agents = { entries: { main: { default: true }, other: { agentDir: external } } };
      artifact = path.join(external, "openclaw-agent.sqlite");
    } else if (kind.startsWith("configured-")) {
      const external = path.join(selected.root, "external");
      cfg.session = { store: path.join(external, "history.json") };
      artifact = path.join(
        external,
        kind === "configured-database" ? "history.sqlite" : "history.main.sqlite-wal",
      );
    } else if (sharedDatabase) {
      sharedDatabase.db.exec("DROP TABLE agent_deletion_journal");
    }
    const artifactBytes = "unverified SQLite family bytes\n";
    if (artifact) {
      fs.mkdirSync(path.dirname(artifact), { recursive: true });
      fs.writeFileSync(artifact, artifactBytes);
    }

    const result = await maybeMigrateAuthProfileJsonStoresToSqlite({
      cfg,
      env: selected.env,
      prompter: { confirmAutoFix: async () => true },
    });

    expect(result.detected).toEqual([]);
    expect(result.changes).toEqual([]);
    expect(fs.readFileSync(source.sourcePath, "utf8")).toBe(source.bytes);
    expect(archivesFor(source.sourcePath)).toEqual([]);
    expect(fs.existsSync(path.join(selected.agentDir(), "openclaw-agent.sqlite"))).toBe(false);
    if (artifact) {
      expect(fs.readFileSync(artifact, "utf8")).toBe(artifactBytes);
    }
    if (sharedDatabase) {
      expect(
        sharedDatabase.db
          .prepare("SELECT name FROM sqlite_schema WHERE name = 'agent_deletion_journal'")
          .get(),
      ).toBeUndefined();
    } else {
      expect(fs.existsSync(sharedPath)).toBe(false);
      if (kind === "dangling-shared") {
        expect(fs.lstatSync(sharedPath).isSymbolicLink()).toBe(true);
      }
    }
  });

  it("detects all three legacy siblings only in the explicitly selected state root", async () => {
    const { selected, ambient } = await createOwners();
    const selectedSources = sourceNames.map((name) =>
      writeSource(selected.agentDir(), name, sourceValue(name, `fake-${randomUUID()}`, 20)),
    );
    const ambientSources = sourceNames.map((name) =>
      writeSource(ambient.agentDir(), name, sourceValue(name, `fake-${randomUUID()}`, 10)),
    );

    const result = await maybeMigrateAuthProfileJsonStoresToSqlite({
      cfg: {},
      env: selected.env,
      prompter: { confirmAutoFix: async () => false },
    });

    expect.soft(result).toEqual({
      detected: selectedSources.map(({ sourcePath }) => sourcePath),
      changes: [],
      migratedProfileIds: new Set<string>(),
      blockedProfileIds: new Set<string>(),
      warnings: [],
    });
    for (const source of [...selectedSources, ...ambientSources]) {
      expect(fs.readFileSync(source.sourcePath, "utf8")).toBe(source.bytes);
      expect(archivesFor(source.sourcePath)).toEqual([]);
    }
    expect(loadPersistedAuthProfileStore(selected.agentDir())).toBeNull();
    expect(loadPersistedAuthProfileStore(ambient.agentDir())).toBeNull();
  });

  it.each(sourceNames)("imports and archives only the selected %s source", async (sourceName) => {
    const { selected, ambient } = await createOwners();
    const selectedKey = `fake-selected-${randomUUID()}`;
    const selectedSource = writeSource(
      selected.agentDir(),
      sourceName,
      sourceValue(sourceName, selectedKey, 20),
    );
    const ambientSource = writeSource(
      ambient.agentDir(),
      sourceName,
      sourceValue(sourceName, `fake-ambient-${randomUUID()}`, 10),
    );

    const result = await maybeMigrateAuthProfileJsonStoresToSqlite({
      cfg: {},
      env: selected.env,
      prompter: { confirmAutoFix: async () => true },
    });

    expect
      .soft(loadPersistedAuthProfileStore(selected.agentDir()))
      .toMatchObject(
        sourceName === "auth-state.json"
          ? { usageStats: { [profileId]: { lastUsed: 20 } } }
          : { profiles: { [profileId]: { key: selectedKey } } },
      );
    expect.soft(result.detected).toEqual([selectedSource.sourcePath]);
    expect.soft(result.warnings).toEqual([]);
    expect.soft(fs.existsSync(ambientSource.sourcePath)).toBe(true);
    if (fs.existsSync(ambientSource.sourcePath)) {
      expect.soft(fs.readFileSync(ambientSource.sourcePath, "utf8")).toBe(ambientSource.bytes);
    }
    expect.soft(archivesFor(ambientSource.sourcePath)).toEqual([]);
    expect.soft(loadPersistedAuthProfileStore(ambient.agentDir())).toBeNull();
    expect.soft(fs.existsSync(selectedSource.sourcePath)).toBe(false);
    const selectedArchives = archivesFor(selectedSource.sourcePath);
    expect.soft(selectedArchives).toHaveLength(1);
    const [selectedArchive] = selectedArchives;
    if (selectedArchive) {
      expect.soft(fs.readFileSync(selectedArchive, "utf8")).toBe(selectedSource.bytes);
    }
    const receipts = openOpenClawStateDatabase({ env: selected.env })
      .db.prepare("SELECT source_path, status, removed_source FROM migration_sources")
      .all();
    expect
      .soft(receipts)
      .toEqual([
        { source_path: selectedSource.sourcePath, status: "completed", removed_source: 1 },
      ]);
  });

  it.each(["OPENCLAW_AGENT_DIR", "PI_CODING_AGENT_DIR"] as const)(
    "resolves a tilde %s relocation against the selected home before importing",
    async (agentDirVariable) => {
      const { selected, ambient } = await createOwners({ [agentDirVariable]: "~/relocated-auth" });
      const selectedDir = path.join(selected.home, "relocated-auth");
      const ambientDir = path.join(ambient.home, "relocated-auth");
      const selectedKey = `fake-selected-${randomUUID()}`;
      const selectedSource = writeSource(
        selectedDir,
        "auth-profiles.json",
        sourceValue("auth-profiles.json", selectedKey, 20),
      );
      const ambientSource = writeSource(
        ambientDir,
        "auth-profiles.json",
        sourceValue("auth-profiles.json", `fake-ambient-${randomUUID()}`, 10),
      );

      const result = await maybeMigrateAuthProfileJsonStoresToSqlite({
        cfg: {},
        env: selected.env,
        prompter: { confirmAutoFix: async () => true },
      });

      expect.soft(loadPersistedAuthProfileStore(selectedDir)?.profiles[profileId]).toMatchObject({
        key: selectedKey,
      });
      expect.soft(result.detected).toEqual([selectedSource.sourcePath]);
      expect.soft(result.warnings).toEqual([]);
      expect.soft(fs.existsSync(selectedSource.sourcePath)).toBe(false);
      expect.soft(fs.existsSync(ambientSource.sourcePath)).toBe(true);
      expect.soft(archivesFor(ambientSource.sourcePath)).toEqual([]);
      expect.soft(loadPersistedAuthProfileStore(ambientDir)).toBeNull();
    },
  );
});
