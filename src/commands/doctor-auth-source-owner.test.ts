import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { clearAuthProfileMigrationDiagnostics } from "../agents/auth-profiles/legacy-source-diagnostic.js";
import { loadPersistedAuthProfileStore } from "../agents/auth-profiles/persisted.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "../agents/auth-profiles/runtime-snapshots.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
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
      env: { OPENCLAW_OAUTH_DIR: undefined, ...env },
    });
    states.push(state);
    return state;
  };
  const selected = await create();
  const ambient = await create();
  ambient.applyEnv();
  return { selected, ambient };
}

function writeSource(
  agentDir: string,
  sourceName: (typeof sourceNames)[number],
  key = `fake-${randomUUID()}`,
  lastUsed = 20,
) {
  fs.mkdirSync(agentDir, { recursive: true });
  const sourcePath = path.join(agentDir, sourceName);
  const credential = { type: "api_key", provider: "owner-test", key };
  const value =
    sourceName === "auth-state.json"
      ? { version: 1, usageStats: { [profileId]: { lastUsed } } }
      : sourceName === "auth.json"
        ? { "owner-test": credential }
        : { version: 1, profiles: { [profileId]: credential } };
  const bytes = `${JSON.stringify(value)}\n`;
  fs.writeFileSync(sourcePath, bytes);
  return { sourcePath, bytes, key };
}

function migrate(state: OpenClawTestState, approved = true, cfg: OpenClawConfig = {}) {
  return maybeMigrateAuthProfileJsonStoresToSqlite({
    cfg,
    env: state.env,
    prompter: { confirmAutoFix: async () => approved },
  });
}

function archivesFor(sourcePath: string) {
  return fs
    .readdirSync(path.dirname(sourcePath))
    .filter((name) => name.startsWith(`${path.basename(sourcePath)}.migrated-`))
    .map((name) => path.join(path.dirname(sourcePath), name));
}

function expectUnchanged(source: ReturnType<typeof writeSource>) {
  expect(fs.readFileSync(source.sourcePath, "utf8")).toBe(source.bytes);
  expect(archivesFor(source.sourcePath)).toEqual([]);
}

afterEach(async () => {
  clearRuntimeAuthProfileStoreSnapshots();
  clearAuthProfileMigrationDiagnostics();
  for (const state of states.splice(0).toReversed()) {
    await state.cleanup();
    expect(fs.existsSync(state.root)).toBe(false);
  }
});

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
  const source = writeSource(selected.agentDir(), "auth-profiles.json");
  const cfg: OpenClawConfig = {};
  const sharedPath = resolveOpenClawStateSqlitePath(selected.env);
  const sharedDatabase =
    kind === "missing-journal" ? openOpenClawStateDatabase({ env: selected.env }) : undefined;
  const external = path.join(selected.root, "external");
  const artifact = new Map([
    ...["wal", "shm", "journal"].map(
      (suffix) => [`shared-${suffix}`, `${sharedPath}-${suffix}`] as const,
    ),
    ["adjacent-database", path.join(selected.agentDir(), "history.db")],
    ["adjacent-sidecar", path.join(selected.agentDir(), "history.sqlite-wal")],
    ["configured-database", path.join(external, "history.sqlite")],
    ["configured-partition-sidecar", path.join(external, "history.main.sqlite-wal")],
    ["configured-agent-directory", path.join(external, "openclaw-agent.sqlite")],
  ]).get(kind);
  if (kind === "dangling-shared") {
    const target = path.join(selected.root, "missing-shared-target");
    fs.mkdirSync(path.dirname(sharedPath), { recursive: true });
    fs.mkdirSync(target);
    fs.symlinkSync(target, sharedPath, "junction");
    fs.rmdirSync(target);
  } else if (kind === "configured-agent-directory") {
    cfg.agents = {
      defaults: { authInheritance: { agentId: "main" } },
      entries: { main: {}, other: { agentDir: external } },
    };
  } else if (kind.startsWith("configured-")) {
    cfg.session = { store: path.join(external, "history.json") };
  } else if (sharedDatabase) {
    sharedDatabase.db.exec("DROP TABLE agent_deletion_journal");
  }
  const artifactBytes = "unverified SQLite family bytes\n";
  if (artifact) {
    fs.mkdirSync(path.dirname(artifact), { recursive: true });
    fs.writeFileSync(artifact, artifactBytes);
  }

  const result = await migrate(selected, true, cfg);

  expect(result).toMatchObject({ detected: [], changes: [] });
  expectUnchanged(source);
  expect(fs.existsSync(path.join(selected.agentDir(), "openclaw-agent.sqlite"))).toBe(false);
  if (artifact) {
    expect(fs.readFileSync(artifact, "utf8")).toBe(artifactBytes);
  }
  if (sharedDatabase) {
    const journal = sharedDatabase.db.prepare(
      "SELECT name FROM sqlite_schema WHERE name = 'agent_deletion_journal'",
    );
    expect(journal.get()).toBeUndefined();
  } else {
    expect(fs.existsSync(sharedPath)).toBe(false);
    if (kind === "dangling-shared") {
      expect(fs.lstatSync(sharedPath).isSymbolicLink()).toBe(true);
    }
  }
});

it("detects all three legacy siblings only in the explicitly selected state root", async () => {
  const { selected, ambient } = await createOwners();
  const selectedSources = sourceNames.map((name) => writeSource(selected.agentDir(), name));
  const ambientSources = sourceNames.map((name) =>
    writeSource(ambient.agentDir(), name, undefined, 10),
  );

  const result = await migrate(selected, false);

  expect.soft(result).toEqual({
    detected: selectedSources.map(({ sourcePath }) => sourcePath),
    changes: [],
    migratedProfileIds: new Set<string>(),
    blockedProfileIds: new Set<string>(),
    warnings: [],
  });
  for (const source of [...selectedSources, ...ambientSources]) {
    expectUnchanged(source);
  }
  expect(loadPersistedAuthProfileStore(selected.agentDir())).toBeNull();
  expect(loadPersistedAuthProfileStore(ambient.agentDir())).toBeNull();
});

it.each([...sourceNames, "OPENCLAW_AGENT_DIR", "PI_CODING_AGENT_DIR"] as const)(
  "imports and archives only the selected source: %s",
  async (kind) => {
    const relocation = kind.endsWith(".json") ? undefined : kind;
    const sourceName =
      kind === "auth-state.json" || kind === "auth.json" ? kind : "auth-profiles.json";
    const { selected, ambient } = await createOwners(
      relocation ? { [relocation]: "~/relocated-auth" } : {},
    );
    const agentDir = (state: OpenClawTestState) =>
      relocation ? path.join(state.home, "relocated-auth") : state.agentDir();
    const selectedDir = agentDir(selected);
    const ambientDir = agentDir(ambient);
    const { sourcePath, bytes, key } = writeSource(selectedDir, sourceName);
    const ambientSource = writeSource(ambientDir, sourceName, undefined, 10);

    const result = await migrate(selected);

    const expectedStore =
      sourceName === "auth-state.json"
        ? { usageStats: { [profileId]: { lastUsed: 20 } } }
        : { profiles: { [profileId]: { key } } };
    expect.soft(loadPersistedAuthProfileStore(selectedDir)).toMatchObject(expectedStore);
    expect.soft(result).toMatchObject({ detected: [sourcePath], warnings: [] });
    expectUnchanged(ambientSource);
    expect.soft(loadPersistedAuthProfileStore(ambientDir)).toBeNull();
    expect.soft(fs.existsSync(sourcePath)).toBe(false);
    expect(archivesFor(sourcePath).map((file) => fs.readFileSync(file, "utf8"))).toEqual([bytes]);
    const receipts = openOpenClawStateDatabase({ env: selected.env })
      .db.prepare("SELECT source_path, status, removed_source FROM migration_sources")
      .all();
    expect
      .soft(receipts)
      .toEqual([{ source_path: sourcePath, status: "completed", removed_source: 1 }]);
  },
);
