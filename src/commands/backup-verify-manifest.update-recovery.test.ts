import path from "node:path";
import { expect, it } from "vitest";
import {
  parseBackupManifest,
  parseUpdateRecoveryBackupManifest,
} from "./backup-verify-manifest.js";

const stateDir = path.resolve("fixture", "state");
const configPath = path.join(stateDir, "openclaw.json");
const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
function missing(sourcePath: string, sqlite = false) {
  return { kind: "missing", sourcePath, sqlite, directory: false };
}
const value = {
  schemaVersion: 2,
  kind: "update-recovery",
  generation: { kind: "baseline" },
  databases: [{ path: databasePath, role: "global" }],
  runId: "fixture-run",
  installRoot: path.resolve("fixture", "install"),
  stateDir,
  configPath,
  configPaths: [configPath],
  creator: { host: "fixture", pid: 1, startIdentity: "1" },
  drivers: [],
  createdAt: "2026-09-10T00:00:00.000Z",
  roots: [stateDir],
  excludedRoots: [],
  protectedPaths: [configPath],
  entries: [
    { kind: "directory", sourcePath: stateDir, mode: 0o700 },
    missing(configPath),
    missing(databasePath, true),
  ],
};

function invalid(label: RegExp | string, ...captures: unknown[]) {
  return { label: String(label), error: label instanceof RegExp ? label : undefined, captures };
}

function parse(capture: unknown) {
  return parseUpdateRecoveryBackupManifest(JSON.stringify(capture));
}
const rejects = (capture: unknown, error?: RegExp) => expect(() => parse(capture)).toThrow(error);

const capture = (overrides: Record<string, unknown>) => ({ ...value, ...overrides });
const withEntries = (...entries: unknown[]) => capture({ entries });
const inventory = (configPaths: string[], ...entries: unknown[]) =>
  capture({ configPaths, entries });
const { generation, databases, ...legacy } = value;
const [root, config, database] = value.entries;
const second = path.join(value.stateDir, "second.sqlite");
const file = {
  kind: "file",
  sourcePath: value.configPath,
  archivePath: "payload/0",
  size: 7,
  sha256: "c".repeat(64),
  sqlite: false,
  mode: 0o600,
};
const captured = withEntries(root, file, database);
const withFile = (overrides: Partial<typeof file>) =>
  withEntries(root, { ...file, ...overrides }, database);
const target = path.join(value.stateDir, "included.json");
function symlink(sourcePath: string, contentPath: string, name = path.basename(contentPath)) {
  return { kind: "symlink", sourcePath, contentPath, target: name };
}
const link = symlink(configPath, target);
const linked = inventory([configPath, target], root, database, link, missing(target));
const canonical = path.join(value.stateDir, "physical", "included.json");
const agentDatabase = (pathname: string) => ({ path: pathname, role: "agent", agentId: "main" });
const warning = {
  kind: "undeclared-migration-resources",
  pluginId: "legacy",
  message: "Resources are not declared",
};
const candidate = { kind: "candidate", baselineSha256: "a".repeat(64) };

it("retains valid capture inventories and version metadata", () => {
  const captures: unknown[] = [
    value,
    capture({ generation: candidate }),
    capture({ generation: { ...candidate, kind: "prepared", candidateSha256: "b".repeat(64) } }),
    { ...legacy, schemaVersion: 1 },
    captured,
    linked,
    inventory(
      [configPath, canonical],
      root,
      database,
      symlink(configPath, canonical, "alias/included.json"),
      { ...file, sourcePath: canonical, size: 2, sha256: "a".repeat(64) },
    ),
    capture({
      entries: [...value.entries, missing(second, true)],
      databases: [agentDatabase(databasePath), agentDatabase(second)],
    }),
    capture({ warnings: [warning] }),
  ];
  for (const manifest of captures) {
    expect(parse(manifest)).toEqual(manifest);
  }
});

it.each([
  invalid(/format version/, capture({ schemaVersion: 1 }), legacy, {
    ...legacy,
    generation: { kind: "baseline" },
  }),
  invalid(
    /configuration inventory/,
    withEntries(root, database),
    capture({ configPaths: [configPath, target] }),
    capture({ configPaths: [configPath, configPath] }),
    { ...linked, configPaths: [configPath] },
    { ...linked, entries: linked.entries.slice(0, -1) },
    inventory([configPath, target], root, database, link, symlink(target, configPath)),
  ),
  invalid(
    /database identity/,
    capture({ databases: [...databases, ...databases] }),
    capture({ databases: [{ ...databases[0], role: "agent", agentId: "Not Canonical" }] }),
    capture({
      entries: [...value.entries, missing(second, true)],
      databases: [...databases, { path: second, role: "global" }],
    }),
  ),
  invalid(
    /SQLite inventory/,
    capture({ databases: [agentDatabase(second)] }),
    withEntries(root, config, { ...database, sqlite: false }),
  ),
  invalid(
    /source/,
    withEntries(...value.entries, config),
    withEntries(...value.entries, missing(stateDir + "-other/file")),
  ),
  invalid(/root entry/, withEntries(...value.entries.slice(1))),
  invalid(
    /Duplicate.*payload/,
    withEntries(root, file, database, { ...file, sourcePath: path.join(stateDir, "second.json") }),
  ),
  invalid(
    "payload metadata",
    withFile({ archivePath: "../payload/0" }),
    withFile({ size: -1 }),
    withFile({ sha256: "invalid" }),
  ),
  invalid(
    "migration warnings",
    capture({ warnings: [{ ...warning, kind: "ignore-capture" }] }),
    capture({ warnings: [{ ...warning, pluginId: "" }] }),
  ),
])("rejects invalid $label", ({ error, captures }) => {
  for (const manifest of captures) {
    rejects(manifest, error);
  }
});

it.each([1, 2])("rejects contradictory unowned SQLite absence in format v%s", (schemaVersion) => {
  const sourcePath = path.join(value.stateDir, "plugin.sqlite");
  const manifest = {
    ...legacy,
    schemaVersion,
    ...(schemaVersion === 2 ? { generation, databases } : {}),
    entries: [...legacy.entries, { ...missing(sourcePath, true), directory: true }],
  };
  rejects(manifest, /SQLite inventory/);
  manifest.entries[manifest.entries.length - 1] = missing(sourcePath, true);
  expect(parse(manifest).entries.at(-1)).toMatchObject({ sqlite: true, directory: false });
});

it("records an omitted database only as excluded, never retained or missing", () => {
  const omitted = {
    ...value,
    databases: [],
    excludedRoots: [databasePath],
    entries: value.entries.slice(0, 2),
  };
  expect(parse(omitted)).toEqual(omitted);
  rejects({ ...omitted, entries: value.entries }, /Excluded.*retained/);
  rejects({ ...omitted, databases: value.databases }, /SQLite inventory/);
  rejects({ ...omitted, excludedRoots: [databasePath, databasePath] }, /exclusions/);
  for (const field of ["roots", "protectedPaths", "configPaths"] as const) {
    rejects({ ...omitted, [field]: [...omitted[field], databasePath] }, /exclusions/);
  }
});

it("does not confuse ordinary archives and private recovery captures", () => {
  const archive = {
    schemaVersion: 1,
    archiveRoot: "archive",
    createdAt: "2026-09-10",
    assets: [],
  };
  expect(parseBackupManifest(JSON.stringify(archive)).archiveRoot).toBe("archive");
  rejects(archive);
  expect(() => parseBackupManifest(JSON.stringify(value))).toThrow();
  expect(() => parseUpdateRecoveryBackupManifest("not json")).toThrow();
});
