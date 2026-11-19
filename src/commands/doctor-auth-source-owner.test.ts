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

function writeCredential(agentDir: string, name: (typeof sourceNames)[number], key = "fake-held") {
  return writeSource(agentDir, name, sourceValue(name, key, key === "fake-ambient" ? 10 : 20));
}

function migrate(state: OpenClawTestState, cfg: OpenClawConfig = {}, approved = true) {
  return maybeMigrateAuthProfileJsonStoresToSqlite({
    cfg,
    env: state.env,
    prompter: { confirmAutoFix: async () => approved },
  });
}

function expectPreserved(source: ReturnType<typeof writeSource>) {
  expect(fs.readFileSync(source.sourcePath, "utf8")).toBe(source.bytes);
  expect(archivesFor(source.sourcePath)).toEqual([]);
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
    const source = writeCredential(selected.agentDir(), "auth-profiles.json");
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
      cfg.agents = {
        defaults: { authInheritance: { agentId: "main" } },
        entries: { main: {}, other: { agentDir: external } },
      };
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

    const result = await migrate(selected, cfg);

    expect(result.detected).toEqual([]);
    expect(result.changes).toEqual([]);
    expectPreserved(source);
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
    const selectedSources = sourceNames.map((name) => writeCredential(selected.agentDir(), name));
    const ambientSources = sourceNames.map((name) =>
      writeCredential(ambient.agentDir(), name, "fake-ambient"),
    );

    const result = await migrate(selected, {}, false);

    expect.soft(result).toEqual({
      detected: selectedSources.map(({ sourcePath }) => sourcePath),
      changes: [],
      migratedProfileIds: new Set<string>(),
      blockedProfileIds: new Set<string>(),
      findings: [],
      aliasFindings: [],
      warnings: [],
    });
    for (const source of [...selectedSources, ...ambientSources]) {
      expectPreserved(source);
    }
    expect(loadPersistedAuthProfileStore(selected.agentDir())).toBeNull();
    expect(loadPersistedAuthProfileStore(ambient.agentDir())).toBeNull();
  });

  it.each([
    ...sourceNames.map((sourceName) => ({ sourceName, agentDirVariable: "" })),
    ...["OPENCLAW_AGENT_DIR", "PI_CODING_AGENT_DIR"].map((agentDirVariable) => ({
      sourceName: "auth-profiles.json" as const,
      agentDirVariable,
    })),
  ])(
    "imports only selected $sourceName ($agentDirVariable)",
    async ({ sourceName, agentDirVariable }) => {
      const { selected, ambient } = await createOwners(
        agentDirVariable ? { [agentDirVariable]: "~/relocated-auth" } : {},
      );
      const dir = (state: OpenClawTestState) =>
        agentDirVariable ? path.join(state.home, "relocated-auth") : state.agentDir();
      const selectedKey = "fake-selected";
      const selectedSource = writeCredential(dir(selected), sourceName, selectedKey);
      const ambientSource = writeCredential(dir(ambient), sourceName, "fake-ambient");
      const result = await migrate(selected);

      expect
        .soft(loadPersistedAuthProfileStore(dir(selected)))
        .toMatchObject(
          sourceName === "auth-state.json"
            ? { usageStats: { [profileId]: { lastUsed: 20 } } }
            : { profiles: { [profileId]: { key: selectedKey } } },
        );
      expect.soft(result.detected).toEqual([selectedSource.sourcePath]);
      expect.soft(result.warnings).toEqual([]);
      expectPreserved(ambientSource);
      expect.soft(loadPersistedAuthProfileStore(dir(ambient))).toBeNull();
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
    },
  );
});
