import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseBackupManifest,
  parseUpdateRecoveryBackupManifest,
} from "./backup-verify-manifest.js";

function fixture() {
  const stateDir = path.resolve("fixture", "state");
  const configPath = path.join(stateDir, "openclaw.json");
  const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
  return {
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
      { kind: "missing", sourcePath: configPath, sqlite: false, directory: false },
      { kind: "missing", sourcePath: databasePath, sqlite: true, directory: false },
    ],
  };
}

function parse(value: unknown) {
  return parseUpdateRecoveryBackupManifest(JSON.stringify(value));
}

describe("update recovery manifest", () => {
  const value = fixture();
  const { generation, databases, ...legacy } = value;
  const [root, config, database] = value.entries;
  const second = path.join(value.stateDir, "second.sqlite");
  const missing = (sourcePath: string, sqlite = false) => ({
    kind: "missing",
    sourcePath,
    sqlite,
    directory: false,
  });
  const file = {
    kind: "file",
    sourcePath: value.configPath,
    archivePath: "payload/0",
    size: 7,
    sha256: "c".repeat(64),
    sqlite: false,
    mode: 0o600,
  };
  const captured = { ...value, entries: [root, file, database] };
  const target = path.join(value.stateDir, "included.json");
  const link = {
    kind: "symlink",
    sourcePath: value.configPath,
    target: "included.json",
    contentPath: target,
  };
  const linked = {
    ...value,
    configPaths: [value.configPath, target],
    entries: [root, database, link, missing(target)],
  };
  const canonical = path.join(value.stateDir, "physical", "included.json");
  const warning = {
    kind: "undeclared-migration-resources",
    pluginId: "legacy",
    message: "Resources are not declared",
  };

  it("retains valid capture inventories and version metadata", () => {
    const captures: unknown[] = [
      value,
      { ...value, generation: { kind: "candidate", baselineSha256: "a".repeat(64) } },
      {
        ...value,
        generation: {
          kind: "prepared",
          baselineSha256: "a".repeat(64),
          candidateSha256: "b".repeat(64),
        },
      },
      { ...legacy, schemaVersion: 1 },
      captured,
      linked,
      {
        ...value,
        configPaths: [value.configPath, canonical],
        entries: [
          root,
          database,
          { ...link, target: "alias/included.json", contentPath: canonical },
          { ...file, sourcePath: canonical, size: 2, sha256: "a".repeat(64) },
        ],
      },
      {
        ...value,
        entries: [...value.entries, missing(second, true)],
        databases: [
          { path: databases[0]?.path, role: "agent", agentId: "main" },
          { path: second, role: "agent", agentId: "main" },
        ],
      },
      { ...value, warnings: [warning] },
    ];
    for (const capture of captures) {
      expect(parse(capture)).toEqual(capture);
    }
  });

  it.each<{ name: string; error?: RegExp; captures: unknown[] }>([
    {
      name: "format version",
      error: /format version/,
      captures: [
        { ...value, schemaVersion: 1 },
        legacy,
        { ...legacy, generation: { kind: "baseline" } },
      ],
    },
    {
      name: "configuration inventory",
      error: /configuration inventory/,
      captures: [
        { ...value, entries: [root, database] },
        { ...value, configPaths: [value.configPath, target] },
        { ...value, configPaths: [value.configPath, value.configPath] },
        { ...linked, configPaths: [value.configPath] },
        { ...linked, entries: linked.entries.slice(0, -1) },
        {
          ...linked,
          entries: [
            root,
            database,
            link,
            {
              kind: "symlink",
              sourcePath: target,
              target: "openclaw.json",
              contentPath: value.configPath,
            },
          ],
        },
      ],
    },
    {
      name: "database identity",
      error: /database identity/,
      captures: [
        { ...value, databases: [...databases, ...databases] },
        { ...value, databases: [{ ...databases[0], role: "agent", agentId: "Not Canonical" }] },
        {
          ...value,
          entries: [...value.entries, missing(second, true)],
          databases: [...databases, { path: second, role: "global" }],
        },
      ],
    },
    {
      name: "SQLite inventory",
      error: /SQLite inventory/,
      captures: [
        { ...value, databases: [{ path: second, role: "agent", agentId: "main" }] },
        { ...value, entries: [root, config, { ...database, sqlite: false }] },
      ],
    },
    {
      name: "source",
      error: /source/,
      captures: [
        { ...value, entries: [...value.entries, config] },
        { ...value, entries: [...value.entries, missing(value.stateDir + "-other/file")] },
      ],
    },
    {
      name: "root entry",
      error: /root entry/,
      captures: [{ ...value, entries: value.entries.slice(1) }],
    },
    {
      name: "duplicate payload",
      error: /Duplicate.*payload/,
      captures: [
        {
          ...captured,
          entries: [
            ...captured.entries,
            { ...file, sourcePath: path.join(value.stateDir, "second.json") },
          ],
        },
      ],
    },
    {
      name: "payload metadata",
      captures: [
        { ...captured, entries: [root, { ...file, archivePath: "../payload/0" }, database] },
        { ...captured, entries: [root, { ...file, size: -1 }, database] },
        { ...captured, entries: [root, { ...file, sha256: "invalid" }, database] },
      ],
    },
    {
      name: "migration warnings",
      captures: [
        { ...value, warnings: [{ ...warning, kind: "ignore-capture" }] },
        { ...value, warnings: [{ ...warning, pluginId: "" }] },
      ],
    },
  ])("rejects invalid $name", ({ captures, error }) => {
    for (const capture of captures) {
      expect(() => parse(capture)).toThrow(error);
    }
  });

  it.each([1, 2])("rejects contradictory unowned SQLite absence in format v%s", (schemaVersion) => {
    const sourcePath = path.join(value.stateDir, "plugin.sqlite");
    const capture = {
      ...legacy,
      schemaVersion,
      ...(schemaVersion === 2 ? { generation, databases } : {}),
      entries: [...legacy.entries, { ...missing(sourcePath, true), directory: true }],
    };
    expect(() => parse(capture)).toThrow(/SQLite inventory/);
    capture.entries[capture.entries.length - 1] = missing(sourcePath, true);
    expect(parse(capture).entries.at(-1)).toMatchObject({ sqlite: true, directory: false });
  });

  it("records an omitted database only as excluded, never retained or missing", () => {
    const databasePath = value.databases[0]!.path;
    const omitted = {
      ...value,
      databases: [],
      excludedRoots: [databasePath],
      entries: value.entries.slice(0, 2),
    };
    expect(parse(omitted)).toEqual(omitted);
    expect(() => parse({ ...omitted, entries: value.entries })).toThrow(/Excluded.*retained/);
    expect(() => parse({ ...omitted, databases: value.databases })).toThrow(/SQLite inventory/);
    expect(() => parse({ ...omitted, excludedRoots: [databasePath, databasePath] })).toThrow(
      /exclusions/,
    );
    for (const field of ["roots", "protectedPaths", "configPaths"] as const) {
      expect(() => parse({ ...omitted, [field]: [...omitted[field], databasePath] })).toThrow(
        /exclusions/,
      );
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
    expect(() => parse(archive)).toThrow();
    expect(() => parseBackupManifest(JSON.stringify(fixture()))).toThrow();
    expect(() => parseUpdateRecoveryBackupManifest("not json")).toThrow();
  });
});
