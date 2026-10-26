import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isPathInside } from "@openclaw/fs-safe/path";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runCommandBuffered } from "../process/exec.js";
import { getFileLockProcessStartTime } from "../shared/pid-alive.js";
import { withAgentDatabaseMaintenanceLease } from "../state/openclaw-agent-db-maintenance-lease.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db-cache.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  generateStoredDeviceIdentity,
  insertStoredDeviceIdentityIfAbsent,
  readStoredDeviceIdentityReadOnly,
} from "./device-identity-store.js";
import { listDirectoryTreeStrict } from "./directory-walk.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { hasNodeErrorCode } from "./path-guards.js";
import {
  copyUpdateCandidatePlugins,
  prepareUpdateCandidatePlugins,
} from "./update-candidate-plugins.js";
import { prepareUpdateCandidateRehearsal } from "./update-candidate-rehearsal.js";
import { readUpdateStateSchemaVersions } from "./update-candidate-state.js";
import {
  materializeUpdateCandidateStateWorker,
  runUpdateCandidateSnapshotWorker,
} from "./update-candidate-state.test-support.js";
import { updateStateSchemaVersionsMatch } from "./update-candidate-state.versions.js";

let root: string;
const rehearsals: Awaited<ReturnType<typeof prepareUpdateCandidateRehearsal>>[] = [];
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "candidate-state-")));
  await materializeUpdateCandidateStateWorker(root);
});
afterEach(async () => {
  try {
    for (const rehearsal of rehearsals.splice(0)) {
      await rehearsal.cleanup();
    }
  } finally {
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function expectRepositoryExcluded(stateDir: string, repository: string) {
  const entries = await listDirectoryTreeStrict(stateDir);
  expect(entries.some(({ relativePath }) => path.basename(relativePath) === "unrelated.txt")).toBe(
    false,
  );
  const repositoryRoot = await fs.realpath(repository);
  for (const { relativePath, dirent } of entries) {
    if (!dirent.isSymbolicLink()) {
      continue;
    }
    const target = await fs.realpath(path.join(stateDir, relativePath));
    // A nonfollowing inventory must still detect aliases into the repository or its ancestors.
    expect(
      isPathInside(repositoryRoot, target) || isPathInside(target, repositoryRoot),
      relativePath,
    ).toBe(false);
  }
}

async function createDatabase(file: string, sql = ""): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  using db = openNodeSqliteDatabase(file);
  db.exec(
    `PRAGMA user_version = 3; CREATE TABLE evidence(value TEXT); INSERT INTO evidence VALUES ('preserved'); ${sql}`,
  );
}

async function writePackage(directory: string, code: string, manifest: object = {}) {
  await writeText(directory, "package.json", JSON.stringify({ type: "module", ...manifest }));
  await writeText(directory, "index.js", code);
}

async function link(target: string, alias: string, type: "junction" | "file" | "dir" = "junction") {
  await fs.mkdir(path.dirname(alias), { recursive: true });
  await fs.symlink(target, alias, type);
}

async function hostPackages(live: string, candidate: string, alias: string) {
  for (const [directory, value] of [
    [live, "serving"],
    [candidate, "candidate"],
  ]) {
    await writePackage(directory!, `export default ${JSON.stringify(value)};`, {
      name: "openclaw",
      exports: "./index.js",
    });
  }
  if (alias !== live) {
    await link(live, alias);
  }
}

const readText = (directory: string, file: string) =>
  fs.readFile(path.join(directory, file), "utf8");
async function writeText(directory: string, file: string, text: string) {
  const target = path.join(directory, file);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, text);
}
const pluginConfig = (paths: string[]): OpenClawConfig => ({ plugins: { load: { paths } } });
const privateEntry = (rehearsal: Awaited<ReturnType<typeof rehearse>>, index = 0) =>
  rehearsal.copied.plugins!.load!.paths![index]!;

async function writePluginIndex(stateDir: string, index: object) {
  const registry = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: stateDir } }).db;
  registry
    .prepare(
      "INSERT INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES (?, ?, ?)",
    )
    .run("plugins.installedIndex", JSON.stringify({ revision: 1, index }), 1);
  await closeOpenClawStateDatabaseByPathAsync(path.join(stateDir, "state", "openclaw.sqlite"));
}

async function runNode(args: string[]) {
  const result = await runCommandBuffered([process.execPath, ...args], { timeoutMs: 10_000 });
  expect(result.code, result.stderr.toString()).toBe(0);
  return result.stdout.toString().trim();
}

async function rehearse(
  config: OpenClawConfig,
  stateDir = path.join(root, "source-state"),
  candidateRoot = root,
) {
  const rehearsal = await prepareUpdateCandidateRehearsal({ config, stateDir, candidateRoot });
  rehearsals.push(rehearsal);
  const copied: OpenClawConfig = JSON.parse(await fs.readFile(rehearsal.configPath, "utf8"));
  return { ...rehearsal, copied };
}

async function readDefault(entry: string) {
  return runNode([
    "--input-type=module",
    "-e",
    `console.log((await import(${JSON.stringify(pathToFileURL(entry).href)})).default)`,
  ]);
}

async function readEntry(directory: string) {
  return runNode([path.join(directory, "index.js")]);
}

function runSnapshotWorker(stateDir: string, targetStateDir: string) {
  return runUpdateCandidateSnapshotWorker({
    stateDir,
    targetStateDir,
    config: {},
    candidateRoot: path.join(root, "candidate-host"),
  });
}

function readEvidence(file: string) {
  using database = openNodeSqliteDatabase(file);
  return database.prepare("SELECT value FROM evidence").get();
}

it.each(["DELETE"])(
  "copies registered databases in %s mode without source process leases or source artifact changes",
  async (journalMode) => {
    const source = path.join(root, "source");
    const target = path.join(root, "copy");
    const shared = path.join(source, "state", "openclaw.sqlite");
    const canonical = path.join(source, "agents", "main", "agent", "openclaw-agent.sqlite");
    const external = path.join(root, "external", "openclaw-agent.sqlite");
    const credentialPath = path.join(source, "client", "credentials.sqlite");
    await createDatabase(canonical);
    await createDatabase(external);
    const registry = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: source } }).db;
    const identity = insertStoredDeviceIdentityIfAbsent(generateStoredDeviceIdentity(17), {
      env: { OPENCLAW_STATE_DIR: source },
    });
    const insert = registry.prepare(
      "INSERT INTO agent_databases (agent_id, path, schema_version, last_seen_at) VALUES (?, ?, 3, 0)",
    );
    insert.run("external", external);
    insert.run("main", canonical);
    insert.run("main", path.relative(source, canonical));
    const now = Date.now();
    const started = getFileLockProcessStartTime(process.pid);
    registry
      .prepare(
        "INSERT INTO agent_database_leases (lease_id, agent_id, path, owner_pid, owner_start_time, opened_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run("live-main", "main", canonical, process.pid, started, now);
    registry
      .prepare("INSERT INTO state_leases VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        "core:agent-database-maintenance",
        "global",
        "live-source-owner",
        now + 60_000,
        now,
        null,
        now,
        now,
      );
    await closeOpenClawStateDatabaseByPathAsync(shared);
    const sources = [shared, canonical, external, credentialPath];
    for (const file of sources) {
      const database = openNodeSqliteDatabase(file);
      database.exec(`PRAGMA journal_mode = ${journalMode};`);
      database.close();
    }
    const artifacts = async () =>
      Promise.all(
        sources.map(async (file) => ({
          bytes: await fs.readFile(file),
          entries: (await fs.readdir(path.dirname(file))).toSorted(),
        })),
      );
    const before = await artifacts();
    const expectArtifactsUnchanged = async () => {
      const after = await artifacts();
      expect(after.map(({ entries }) => entries)).toEqual(before.map(({ entries }) => entries));
      // Keep exact bytes without expanding whole databases through iterable equality.
      for (const [index, { bytes }] of after.entries()) {
        expect(bytes.equals(before[index]!.bytes)).toBe(true);
      }
    };
    const inspected = await readUpdateStateSchemaVersions({ stateDir: source, config: {} });
    expect(inspected.filter((entry) => entry.userVersion === 3)).toHaveLength(2);
    await expectArtifactsUnchanged();
    const versions = await runSnapshotWorker(source, target);
    expect(versions).toEqual(inspected);
    expect(readStoredDeviceIdentityReadOnly({ env: { OPENCLAW_STATE_DIR: target } })).toEqual(
      identity,
    );
    await expect(
      withAgentDatabaseMaintenanceLease(
        {
          env: {
            OPENCLAW_STATE_DIR: target,
            OPENCLAW_CONFIG_PATH: path.join(target, "openclaw.json"),
          },
        },
        async (maintenance) => maintenance.assertOwned(),
      ),
    ).resolves.toBeUndefined();
    await expectArtifactsUnchanged();
    const copiedRegistry = openNodeSqliteDatabase(path.join(target, "state", "openclaw.sqlite"));
    expect(copiedRegistry.prepare("SELECT * FROM agent_database_leases").all()).toEqual([]);
    expect(copiedRegistry.prepare("SELECT * FROM state_leases").all()).toEqual([]);
    expect(
      copiedRegistry
        .prepare("SELECT count(*) AS count FROM agent_databases WHERE agent_id = 'main'")
        .get(),
    ).toMatchObject({ count: 1 });
    const rebound = copiedRegistry
      .prepare("SELECT path FROM agent_databases WHERE agent_id = 'external'")
      .get() as {
      path: string;
    };
    copiedRegistry.close();
    expect(path.isAbsolute(rebound.path)).toBe(false);
    expect(rebound.path).toMatch(/^candidate-external/);
    for (const file of [
      path.join(target, rebound.path),
      path.join(target, "agents", "main", "agent", "openclaw-agent.sqlite"),
    ]) {
      expect(readEvidence(file)).toMatchObject({ value: "preserved" });
    }
  },
);

it("retains deferred content in both inspection and rehearsal snapshots", async () => {
  const stateDir = path.join(root, "deferred");
  const file = path.join(stateDir, "state", "openclaw.sqlite");
  await createDatabase(
    file,
    `
    PRAGMA user_version = 15;
    CREATE TABLE config_machine_state (state_key TEXT PRIMARY KEY, value_json TEXT, updated_at_ms INTEGER);
    INSERT INTO config_machine_state VALUES ('state.schema.contentVersion', '16', 0);
  `,
  );
  const inspected = await readUpdateStateSchemaVersions({ stateDir, config: {} });
  expect(inspected.find((entry) => entry.path === file)).toEqual({
    path: file,
    userVersion: 15,
    contentVersion: 16,
  });
  expect(await runSnapshotWorker(stateDir, path.join(root, "rehearsal"))).toEqual(inspected);
});

it("keeps absent stores explicit and observes newly created databases for rollback fencing", async () => {
  const stateDir = path.join(root, "state-owner");
  const before = await readUpdateStateSchemaVersions({ stateDir, config: {} });
  expect(before.every((entry) => entry.userVersion === null)).toBe(true);
  const daemon = path.join(stateDir, "control", "services.sqlite");
  const client = path.join(stateDir, "client", "credentials.sqlite");
  const legacy = before.filter((entry) => entry.path !== daemon && entry.path !== client);
  expect(
    updateStateSchemaVersionsMatch(legacy, before, {
      sharedPath: path.join(stateDir, "state", "openclaw.sqlite"),
    }),
  ).toBe(true);
  const main = path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
  await createDatabase(main);
  const after = await readUpdateStateSchemaVersions({ stateDir, config: {} });
  expect(after.find((entry) => entry.path === main)?.userVersion).toBe(3);
  const sharedPath = path.join(stateDir, "state", "openclaw.sqlite");
  expect(updateStateSchemaVersionsMatch(before, after, { sharedPath })).toBe(false);
  const candidate = { sharedPath, candidateSchemaVersions: { state: 7, agent: 3 } };
  expect(updateStateSchemaVersionsMatch(before, after, candidate)).toBe(true);
  expect(
    updateStateSchemaVersionsMatch(before, after, {
      sharedPath,
      candidateSchemaVersions: { state: 3, agent: 4 },
    }),
  ).toBe(false);
  expect(updateStateSchemaVersionsMatch(after, before, candidate)).toBe(false);
  expect(updateStateSchemaVersionsMatch(after, after.toReversed(), candidate)).toBe(true);
  await createDatabase(daemon, "PRAGMA user_version = 1;");
  const withDaemon = await readUpdateStateSchemaVersions({ stateDir, config: {} });
  expect(
    updateStateSchemaVersionsMatch(
      after.filter((entry) => entry.path !== daemon),
      withDaemon,
      { sharedPath },
    ),
  ).toBe(false);
  expect(updateStateSchemaVersionsMatch(after, withDaemon, candidate)).toBe(true);
  expect(updateStateSchemaVersionsMatch(withDaemon, after, candidate)).toBe(false);
  await createDatabase(client, "PRAGMA user_version = 1;");
  const withClient = await readUpdateStateSchemaVersions({ stateDir, config: {} });
  expect(updateStateSchemaVersionsMatch(withDaemon, withClient, { sharedPath })).toBe(false);
  expect(updateStateSchemaVersionsMatch(withDaemon, withClient, candidate)).toBe(true);
  expect(updateStateSchemaVersionsMatch(withClient, withDaemon, candidate)).toBe(false);
});

it.runIf(process.platform !== "win32")(
  "preserves distinct registered databases reached through symlink parent traversal",
  async () => {
    const source = path.join(root, "source");
    const target = path.join(root, "copy");
    const shared = path.join(source, "state", "openclaw.sqlite");
    const symlinkTarget = path.join(source, "external", "subdir");
    await fs.mkdir(symlinkTarget, { recursive: true });
    await fs.symlink(symlinkTarget, path.join(source, "link"), "dir");
    const filesystemPath = path.join(source, "external", "x", "openclaw-agent.sqlite");
    const lexicalPath = path.join(source, "x", "openclaw-agent.sqlite");
    await createDatabase(
      filesystemPath,
      "UPDATE evidence SET value = 'filesystem'; PRAGMA user_version = 4;",
    );
    await createDatabase(lexicalPath, "UPDATE evidence SET value = 'lexical';");
    await createDatabase(
      shared,
      "CREATE TABLE agent_databases(agent_id TEXT, path TEXT, PRIMARY KEY(agent_id,path));",
    );
    const registry = openNodeSqliteDatabase(shared);
    const insert = registry.prepare("INSERT INTO agent_databases VALUES (?, ?)");
    insert.run("filesystem", `link${path.sep}..${path.sep}x${path.sep}openclaw-agent.sqlite`);
    insert.run("lexical", lexicalPath);
    registry.close();

    const versions = await readUpdateStateSchemaVersions({ stateDir: source, config: {} });
    expect(versions).toContainEqual({
      path: `${source}${path.sep}link${path.sep}..${path.sep}x${path.sep}openclaw-agent.sqlite`,
      userVersion: 4,
    });
    expect(versions).toContainEqual({ path: lexicalPath, userVersion: 3 });
    await runSnapshotWorker(source, target);

    using copiedRegistry = openNodeSqliteDatabase(path.join(target, "state", "openclaw.sqlite"));
    for (const owner of ["filesystem", "lexical"]) {
      const row = copiedRegistry
        .prepare("SELECT path FROM agent_databases WHERE agent_id = ?")
        .get(owner) as { path: string };
      expect(readEvidence(path.join(target, row.path))).toEqual({ value: owner });
    }
  },
);

it.each([
  { source: "npm", relative: "npm/projects/demo/node_modules/demo" },
  { source: "npm", relative: "npm/node_modules/demo" },
])(
  "projects $source plugin at $relative without touching live files or host links",
  async ({ source: installSource, relative }) => {
    const source = path.join(root, "source");
    const target = path.join(root, "copy");
    const packageDir = path.join(source, relative);
    const liveHost = path.join(root, "live-host");
    const candidateHost = path.join(root, "candidate-host");
    const dependency = path.join(root, "external-dependency");
    await hostPackages(liveHost, candidateHost, path.join(packageDir, "node_modules/openclaw"));
    await writePackage(dependency, 'export default "preserved";', {
      name: "dependency",
      exports: "./index.js",
    });
    await link(dependency, path.join(path.dirname(packageDir), "dependency"));
    await writePackage(
      packageDir,
      'import host from "openclaw"; import dependency from "dependency"; export default {host, dependency};',
      {
        name: "demo",
        version: "1.0.0",
        peerDependencies: { openclaw: "*" },
      },
    );
    await writePluginIndex(source, {
      plugins: [{ source: packageDir }],
      installRecords: {
        demo: { source: installSource, installPath: packageDir, version: "1.0.0" },
      },
    });
    const shared = path.join(source, "state", "openclaw.sqlite");
    const before = await fs.readFile(shared);
    await runSnapshotWorker(source, target);
    expect((await fs.readFile(shared)).equals(before)).toBe(true);
    expect(await fs.realpath(path.join(packageDir, "node_modules", "openclaw"))).toBe(liveHost);
    using copied = openNodeSqliteDatabase(path.join(target, "state", "openclaw.sqlite"));
    const row = copied
      .prepare(
        "SELECT value_json FROM config_machine_state WHERE state_key = 'plugins.installedIndex'",
      )
      .get() as { value_json: string };
    const record = JSON.parse(row.value_json).index.installRecords.demo;
    expect(record.installPath).toBe(path.join(target, relative));
    expect(await fs.realpath(path.join(record.installPath, "node_modules", "openclaw"))).toBe(
      candidateHost,
    );
    const result = await runNode([
      "--input-type=module",
      "-e",
      `console.log(JSON.stringify((await import(${JSON.stringify(pathToFileURL(path.join(record.installPath, "index.js")).href)})).default))`,
    ]);
    expect(JSON.parse(result)).toEqual({
      host: "candidate",
      dependency: "preserved",
    });
  },
);

it.each([
  { extension: "ts", linked: false },
  { extension: "js", linked: true },
])(
  "preserves external .$extension entry imports and path identity (linked=$linked)",
  async ({ extension, linked }) => {
    const source = path.join(root, "source-state");
    const external = path.join(root, "external-plugin");
    const install = path.join(root, "installed-plugin");
    const sourcePackage = path.join(root, "source-plugin");
    await writeText(external, "package.json", '{"type":"module"}');
    await writeText(external, "adjacent.js", 'export default "adjacent survived";');
    const dependency = path.join(external, "node_modules", "dependency");
    await writePackage(dependency, 'export default "dependency survived";', {
      exports: "./index.js",
    });
    const realEntry = path.join(external, "dist", `plugin.${extension}`);
    let entry = realEntry;
    await writeText(
      path.dirname(realEntry),
      path.basename(realEntry),
      'import adjacent from "../adjacent.js"; import dependency from "dependency"; export default `${adjacent}:${dependency}`;',
    );
    await writeText(install, "marker", "installed payload");
    if (linked) {
      await link(install, sourcePackage);
      const aliasDirectory = path.join(root, "external-alias");
      if (process.platform === "win32") {
        await link(path.dirname(realEntry), aliasDirectory);
        entry = path.join(aliasDirectory, path.basename(realEntry));
      } else {
        entry = path.join(aliasDirectory, `public-name.${extension}`);
        await link(realEntry, entry, "file");
      }
    } else {
      await writeText(sourcePackage, "marker", "source payload");
    }
    await writePluginIndex(source, { installRecords: {} });
    const config: OpenClawConfig = {
      plugins: {
        load: { paths: [entry] },
        installs: { demo: { source: "path", installPath: install, sourcePath: sourcePackage } },
      },
    };
    const rehearsal = await rehearse(config, source);
    const copied = rehearsal.copied;
    const copiedEntry = copied.plugins!.load!.paths![0]!;
    expect(path.basename(copiedEntry)).toBe(path.basename(entry));
    expect(copiedEntry.startsWith(rehearsal.stateDir + path.sep)).toBe(true);
    expect(await readDefault(copiedEntry)).toBe("adjacent survived:dependency survived");
    const record = copied.plugins!.installs!.demo!;
    expect(await readText(record.installPath!, "marker")).toBe("installed payload");
    expect(await readText(record.sourcePath!, "marker")).toBe(
      linked ? "installed payload" : "source payload",
    );
    expect(
      (await fs.realpath(record.installPath!)) === (await fs.realpath(record.sourcePath!)),
    ).toBe(linked);
    expect(config.plugins!.load!.paths).toEqual([entry]);
    expect(config.plugins!.installs!.demo!.sourcePath).toBe(sourcePackage);
  },
);

it("preserves an existing copied file behind a case-equivalent entry name", async (context) => {
  const plugin = path.join(root, "case-plugin");
  const lower = path.join(plugin, "entry.js");
  const upper = path.join(plugin, "ENTRY.js");
  const payload = 'export default "case alias survived";';
  await writeText(plugin, "package.json", '{"type":"module"}');
  await fs.writeFile(lower, payload);
  const upperReal = await fs.realpath(upper).catch((error: unknown) => {
    if (hasNodeErrorCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  });
  if (upperReal !== (await fs.realpath(lower))) {
    context.skip("Requires a case-insensitive fixture volume with canonical filename casing");
  }
  const rehearsal = await rehearse(pluginConfig([upper]));
  const entry = privateEntry(rehearsal);
  expect(path.basename(entry)).toBe("ENTRY.js");
  expect(await readDefault(entry)).toBe("case alias survived");
  expect((await fs.lstat(entry)).isFile()).toBe(true);
  expect(await fs.readFile(lower, "utf8")).toBe(payload);
  expect(await fs.readFile(upper, "utf8")).toBe(payload);
});

it.each(["external-store", "cycle"] as const)(
  "preserves pnpm transitive dependency topology in a private rehearsal (%s)",
  async (layout) => {
    const plugin = path.join(root, "local-plugin");
    const modules = path.join(plugin, "node_modules");
    const store =
      layout === "external-store" ? path.join(root, "virtual-store") : path.join(modules, ".pnpm");
    const foo = path.join(store, "foo@1.0.0", "node_modules", "foo");
    const bar = path.join(store, "bar@1.0.0", "node_modules", "bar");
    for (const [directory, name, code] of [
      [plugin, "plugin", 'import value from "foo"; export default value;'],
      [foo, "foo", 'import value from "bar"; export default `foo:${value}`;'],
      [bar, "bar", 'export default "bar";'],
    ]) {
      await writePackage(directory!, code!, { name, exports: "./index.js" });
    }
    await fs.mkdir(modules, { recursive: true });
    if (layout === "external-store") {
      await fs.writeFile(
        path.join(modules, ".modules.yaml"),
        `virtualStoreDir: ${JSON.stringify(store)}\n`,
      );
    }
    const links = [
      [path.join(modules, "foo"), foo],
      [path.join(path.dirname(foo), "bar"), bar],
    ] as const;
    for (const [linkPath, target] of links) {
      await fs.symlink(
        process.platform === "win32" ? target : path.relative(path.dirname(linkPath), target),
        linkPath,
        "junction",
      );
    }
    if (layout === "cycle") {
      await fs.symlink(foo, path.join(path.dirname(bar), "foo"), "junction");
    }
    const readPlugin = (directory: string) => readDefault(path.join(directory, "index.js"));
    const rehearsal = await rehearse(pluginConfig([plugin]));
    const copiedPlugin = privateEntry(rehearsal);
    expect(await readPlugin(copiedPlugin)).toBe("foo:bar");
    const copiedFoo = await fs.realpath(path.join(copiedPlugin, "node_modules", "foo"));
    const copiedBar = await fs.realpath(path.join(path.dirname(copiedFoo), "bar"));
    expect(copiedBar.startsWith(rehearsal.stateDir + path.sep)).toBe(true);
  },
);

it("copies external directory and file links under an aliased state root without traversing unrelated siblings", async () => {
  const source = path.join(root, "source");
  const plugin = path.join(source, "extensions", "demo");
  const dependency = path.join(root, "dependency");
  const fileLinks = process.platform !== "win32";
  const file = fileLinks
    ? path.join(root, "assets", "config.txt")
    : path.join(dependency, "config.txt");
  const physical = path.join(root, "physical-state");
  const alias = path.join(root, "state-alias");
  await fs.mkdir(physical);
  await link(physical, alias);
  await writeText(plugin, "package.json", '{"name":"demo"}');
  await writeText(dependency, "package.json", '{"name":"dependency"}');
  await writeText(path.dirname(file), path.basename(file), "source");
  if (fileLinks) {
    await link(path.join(root, "missing-unrelated-target"), path.join(root, "assets", "unrelated"));
    await link(file, path.join(dependency, "config.txt"));
  }
  await link(dependency, path.join(plugin, "node_modules", "dependency"));
  const params = {
    config: pluginConfig([plugin]),
    stateDir: source,
    targetStateDir: path.join(alias, "candidate"),
    candidateRoot: root,
  } satisfies Parameters<typeof prepareUpdateCandidatePlugins>[0];
  const paths = await copyUpdateCandidatePlugins(
    await prepareUpdateCandidatePlugins(params),
    params,
  );
  const copied = path.join(paths[plugin]!, "node_modules", "dependency", "config.txt");
  expect((await fs.realpath(copied)).startsWith(physical + path.sep)).toBe(true);
  expect(await fs.readFile(copied, "utf8")).toBe("source");
  await fs.writeFile(copied, "private");
  expect(await fs.readFile(file, "utf8")).toBe("source");
  expect(await fs.realpath(path.join(plugin, "node_modules", "dependency"))).toBe(dependency);
  if (fileLinks) {
    expect(await fs.readlink(path.join(dependency, "config.txt"))).toBe(file);
  }
  const rehearsal = await rehearse(pluginConfig([plugin]));
  expect(await readText(privateEntry(rehearsal), "node_modules/dependency/config.txt")).toBe(
    "source",
  );
});

it.each([
  { alias: true, shadow: false, linkedModules: false, sharedOrder: "none" },
  { alias: false, shadow: true, linkedModules: false, sharedOrder: "none" },
  { alias: false, shadow: false, linkedModules: true, sharedOrder: "none" },
  { alias: false, shadow: false, linkedModules: false, sharedOrder: "owner-first" },
  { alias: false, shadow: false, linkedModules: false, sharedOrder: "owner-last" },
])(
  "preserves declared workspace hoists without copying repository files (alias=$alias, shadow=$shadow, linkedModules=$linkedModules, sharedOrder=$sharedOrder)",
  async ({ alias, shadow, linkedModules, sharedOrder }) => {
    const repo = path.join(root, "workspace");
    const plugin = path.join(repo, "packages", "demo");
    const shared = sharedOrder !== "none";
    const sharedOwner = path.join(repo, "packages", "owner");
    const modules = shared
      ? path.join(sharedOwner, "cache")
      : linkedModules
        ? path.join(root, "external-modules")
        : path.join(repo, "node_modules");
    const dependency = path.join(modules, "@demo", "dependency");
    const liveHost = shared ? path.join(modules, "openclaw") : path.join(root, "live-host");
    const sourceHostLink = path.join(shared ? plugin : repo, "node_modules", "openclaw");
    const candidateHost = path.join(root, "candidate-host");
    const expected = shadow ? "nearest" : "hoisted";
    await fs.mkdir(dependency, { recursive: true });
    if (shared) {
      await link(modules, path.join(plugin, "node_modules"));
      await writePackage(
        sharedOwner,
        'console.log(JSON.stringify({value:"owner",host:"owner",dependency:import.meta.url}));',
        { name: "owner" },
      );
    } else if (linkedModules) {
      await link(modules, path.join(repo, "node_modules"));
    }
    await hostPackages(liveHost, candidateHost, shared ? liveHost : sourceHostLink);
    await writeText(
      repo,
      "package.json",
      JSON.stringify({ private: true, workspaces: ["packages/*"] }),
    );
    await writeText(repo, "unrelated.txt", "do not copy repository files");
    await writePackage(
      plugin,
      'import value from "@demo/dependency"; import host from "openclaw"; console.log(JSON.stringify({value, host, dependency: import.meta.resolve("@demo/dependency")}));',
      {
        name: "demo",
        version: "1.0.0",
        dependencies: { "@demo/dependency": "1.0.0" },
        optionalDependencies: { absent: "1.0.0" },
        peerDependencies: { openclaw: "*" },
      },
    );
    await writePackage(dependency, 'export default "hoisted";', {
      name: "@demo/dependency",
      version: "1.0.0",
      exports: "./index.js",
    });
    if (shadow) {
      const nearest = path.join(plugin, "node_modules", "@demo", "dependency");
      await fs.cp(dependency, nearest, { recursive: true });
      await writeText(nearest, "index.js", 'export default "nearest";');
    }
    const locator = alias ? path.join(root, "linked-demo") : plugin;
    if (alias) {
      await link(plugin, locator);
    }
    const readPlugin = async (directory: string) =>
      JSON.parse(await readEntry(directory)) as {
        value: string;
        dependency: string;
        host: string;
      };
    const paths = !shared
      ? [locator]
      : sharedOrder === "owner-first"
        ? [sharedOwner, locator]
        : [locator, sharedOwner];
    await materializeUpdateCandidateStateWorker(candidateHost);
    const rehearsal = await rehearse(pluginConfig(paths), undefined, candidateHost);
    const config = rehearsal.copied;
    const copied = config.plugins!.load!.paths![paths.indexOf(locator)]!;
    if (shared) {
      expect(
        (await readPlugin(config.plugins!.load!.paths![paths.indexOf(sharedOwner)]!)).value,
      ).toBe("owner");
    }
    expect(path.basename(copied)).toBe(path.basename(locator));
    const result = await readPlugin(copied);
    expect(result).toMatchObject({ value: expected, host: "candidate" });
    const copiedDependency = await fs.realpath(fileURLToPath(result.dependency));
    expect(copiedDependency.startsWith(rehearsal.stateDir + path.sep)).toBe(true);
    await expectRepositoryExcluded(rehearsal.stateDir, repo);
  },
);

it("keeps an optional-only linked node_modules copy bounded to its module owner", async () => {
  const repo = path.join(root, "repository");
  const plugin = path.join(repo, "plugin");
  const modules = path.join(repo, "external-modules");
  await writeText(repo, "package.json", '{"private":true}');
  await writeText(repo, "unrelated.txt", "repository data");
  await writePackage(plugin, 'console.log("optional plugin ready");', {
    name: "demo",
    optionalDependencies: { missing: "1.0.0" },
  });
  await writeText(modules, "marker.txt", "source");
  await link(modules, path.join(plugin, "node_modules"));
  const rehearsal = await rehearse(pluginConfig([plugin]));
  const copied = privateEntry(rehearsal);
  expect(await readEntry(copied)).toBe("optional plugin ready");
  await expectRepositoryExcluded(rehearsal.stateDir, repo);
  const marker = path.join(copied, "node_modules", "marker.txt");
  expect((await fs.realpath(marker)).startsWith(rehearsal.stateDir + path.sep)).toBe(true);
  await fs.writeFile(marker, "private");
  expect(await readText(modules, "marker.txt")).toBe("source");
  expect(await fs.realpath(path.join(plugin, "node_modules"))).toBe(modules);
});

it("rejects an ordinary link that would repeatedly copy an immutable host package", async () => {
  const plugin = path.join(root, "plugin");
  const host = path.join(root, "live-host");
  const candidate = path.join(root, "candidate-host");
  await writePackage(plugin, 'import host from "openclaw"; console.log(host);', {
    name: "demo",
    peerDependencies: { openclaw: "*" },
  });
  await hostPackages(host, candidate, path.join(plugin, "node_modules", "openclaw"));
  await writeText(host, "docs/marker.txt", "source");
  await link(path.join(host, "docs"), path.join(plugin, "manual"));
  await materializeUpdateCandidateStateWorker(candidate);
  await expect(
    prepareUpdateCandidateRehearsal({
      config: pluginConfig([plugin]),
      stateDir: path.join(root, "source-state"),
      candidateRoot: candidate,
      timeoutMs: 10_000,
    }),
  ).rejects.toThrow("Cannot privately copy host-owned plugin link");
  expect(await fs.readFile(path.join(host, "docs", "marker.txt"), "utf8")).toBe("source");
  expect(await fs.realpath(path.join(plugin, "node_modules", "openclaw"))).toBe(host);
}, 20_000);
