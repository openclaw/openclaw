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
  it("retains explicit absent config and database inventory in every v2 generation", () => {
    for (const generation of [
      { kind: "baseline" },
      { kind: "candidate", baselineSha256: "a".repeat(64) },
      { kind: "prepared", baselineSha256: "a".repeat(64), candidateSha256: "b".repeat(64) },
    ]) {
      const value = { ...fixture(), generation };
      expect(parse(value)).toEqual(value);
    }
  });

  it("keeps legacy v1 captures readable without inventing generation or owner metadata", () => {
    const { generation: _generation, databases: _databases, ...value } = fixture();
    expect(parse({ ...value, schemaVersion: 1 })).toEqual({ ...value, schemaVersion: 1 });
    expect(() => parse({ ...fixture(), schemaVersion: 1 })).toThrow(/format version/);
    expect(() => parse(value)).toThrow(/format version/);
    expect(() => parse({ ...value, generation: { kind: "baseline" } })).toThrow(/format version/);
  });

  it("rejects missing config entries and missing include inventory without weakening absence", () => {
    const value = fixture();
    expect(() => parse({ ...value, entries: [value.entries[0], value.entries[2]] })).toThrow(
      /configuration inventory/,
    );
    expect(() =>
      parse({
        ...value,
        configPaths: [value.configPath, path.join(value.stateDir, "included.json")],
      }),
    ).toThrow(/configuration inventory/);
    expect(() => parse({ ...value, configPaths: [value.configPath, value.configPath] })).toThrow(
      /configuration inventory/,
    );
    expect(parse(value).configPaths).toEqual([value.configPath]);
  });

  it("requires symlink configs to retain their captured target inventory", () => {
    const value = fixture();
    const target = path.join(value.stateDir, "included.json");
    const linked = {
      ...value,
      configPaths: [value.configPath, target],
      entries: [
        value.entries[0],
        value.entries[2],
        {
          kind: "symlink",
          sourcePath: value.configPath,
          target: "included.json",
          contentPath: target,
        },
        { kind: "missing", sourcePath: target, sqlite: false, directory: false },
      ],
    };
    expect(parse(linked)).toEqual(linked);
    expect(() => parse({ ...linked, configPaths: [value.configPath] })).toThrow(
      /configuration inventory/,
    );
    expect(() => parse({ ...linked, entries: linked.entries.slice(0, -1) })).toThrow(
      /configuration inventory/,
    );
  });

  it("rejects duplicate or noncanonical database identities and uncaptured SQLite owners", () => {
    const value = fixture();
    expect(() => parse({ ...value, databases: [...value.databases, ...value.databases] })).toThrow(
      /database identity/,
    );
    expect(() =>
      parse({
        ...value,
        databases: [{ ...value.databases[0], role: "agent", agentId: "Not Canonical" }],
      }),
    ).toThrow(/database identity/);
    expect(() =>
      parse({
        ...value,
        databases: [
          { path: path.join(value.stateDir, "other.sqlite"), role: "agent", agentId: "main" },
        ],
      }),
    ).toThrow(/SQLite inventory/);
    expect(() =>
      parse({
        ...value,
        entries: [value.entries[0], value.entries[1], { ...value.entries[2], sqlite: false }],
      }),
    ).toThrow();
  });

  it("rejects ambiguous database owners and directory-shaped missing databases", () => {
    const value = fixture();
    const second = path.join(value.stateDir, "second.sqlite");
    const entries = [
      ...value.entries,
      { kind: "missing", sourcePath: second, sqlite: true, directory: false },
    ];
    expect(() =>
      parse({
        ...value,
        entries,
        databases: [...value.databases, { path: second, role: "global" }],
      }),
    ).toThrow(/database identity/);
    // Recovery inventories retain old and new physical locations for one agent.
    const retainedAgentPaths = {
      ...value,
      entries,
      databases: [
        { path: value.databases[0]?.path, role: "agent", agentId: "main" },
        { path: second, role: "agent", agentId: "main" },
      ],
    };
    expect(parse(retainedAgentPaths)).toEqual(retainedAgentPaths);
    expect(() =>
      parse({
        ...value,
        entries: [value.entries[0], value.entries[1], { ...value.entries[2], directory: true }],
      }),
    ).toThrow(/SQLite inventory/);
  });

  it.each([1, 2])("rejects contradictory unowned SQLite absence in format v%s", (schemaVersion) => {
    const { generation, databases, ...legacy } = fixture();
    const value = {
      ...legacy,
      schemaVersion,
      ...(schemaVersion === 2 ? { generation, databases } : {}),
      entries: [
        ...legacy.entries,
        {
          kind: "missing",
          sourcePath: path.join(legacy.stateDir, "plugin.sqlite"),
          sqlite: true,
          directory: true,
        },
      ],
    };
    expect(() => parse(value)).toThrow(/SQLite inventory/);
    value.entries[value.entries.length - 1] = {
      kind: "missing",
      sourcePath: path.join(legacy.stateDir, "plugin.sqlite"),
      sqlite: true,
      directory: false,
    };
    expect(parse(value).entries.at(-1)).toMatchObject({ sqlite: true, directory: false });
  });

  it("rejects config symlinks whose resolved content is another link instead of captured data", () => {
    const value = fixture();
    const linked = {
      ...value,
      entries: [
        value.entries[0],
        value.entries[2],
        {
          kind: "symlink",
          sourcePath: value.configPath,
          target: "included.json",
          contentPath: value.configPath,
        },
      ],
    };
    expect(() => parse(linked)).toThrow(/configuration inventory/);
    const second = path.join(value.stateDir, "second.json");
    expect(() =>
      parse({
        ...linked,
        configPaths: [value.configPath, second],
        entries: [
          value.entries[0],
          value.entries[2],
          {
            kind: "symlink",
            sourcePath: value.configPath,
            target: "second.json",
            contentPath: second,
          },
          {
            kind: "symlink",
            sourcePath: second,
            target: "openclaw.json",
            contentPath: value.configPath,
          },
        ],
      }),
    ).toThrow(/configuration inventory/);
  });

  it("retains producer-resolved config content through a symlinked parent directory", () => {
    const value = fixture();
    const canonical = path.join(value.stateDir, "physical", "included.json");
    const captured = {
      ...value,
      configPaths: [value.configPath, canonical],
      entries: [
        value.entries[0],
        value.entries[2],
        {
          kind: "symlink",
          sourcePath: value.configPath,
          target: "alias/included.json",
          contentPath: canonical,
        },
        {
          kind: "file",
          sourcePath: canonical,
          archivePath: "payload/0",
          size: 2,
          sha256: "a".repeat(64),
          sqlite: false,
          mode: 0o600,
        },
      ],
    };
    expect(parse(captured)).toEqual(captured);
  });

  it("rejects duplicate sources, absent root entries, and sibling-prefix path escapes", () => {
    const value = fixture();
    expect(() => parse({ ...value, entries: [...value.entries, value.entries[1]] })).toThrow(
      /source/,
    );
    expect(() => parse({ ...value, entries: value.entries.slice(1) })).toThrow(/root entry/);
    expect(() =>
      parse({
        ...value,
        entries: [
          ...value.entries,
          {
            kind: "missing",
            sourcePath: value.stateDir + "-other/file",
            sqlite: false,
            directory: false,
          },
        ],
      }),
    ).toThrow(/source/);
  });

  it("binds each file to a unique constrained payload with digest and byte count", () => {
    const value = fixture();
    const file = {
      kind: "file",
      sourcePath: value.configPath,
      archivePath: "payload/0",
      size: 7,
      sha256: "c".repeat(64),
      sqlite: false,
      mode: 0o600,
    };
    const captured = { ...value, entries: [value.entries[0], file, value.entries[2]] };
    expect(parse(captured)).toEqual(captured);
    expect(() =>
      parse({
        ...captured,
        entries: [
          ...captured.entries,
          { ...file, sourcePath: path.join(value.stateDir, "second.json") },
        ],
      }),
    ).toThrow(/Duplicate.*payload/);
    for (const patch of [{ archivePath: "../payload/0" }, { size: -1 }, { sha256: "invalid" }]) {
      expect(() =>
        parse({
          ...captured,
          entries: [value.entries[0], { ...file, ...patch }, value.entries[2]],
        }),
      ).toThrow();
    }
  });

  it("preserves typed migration warnings and refuses malformed warning declarations", () => {
    const value = {
      ...fixture(),
      warnings: [
        {
          kind: "undeclared-migration-resources",
          pluginId: "legacy",
          message: "Resources are not declared",
        },
      ],
    };
    expect(parse(value)).toEqual(value);
    expect(() =>
      parse({ ...value, warnings: [{ ...value.warnings[0], kind: "ignore-capture" }] }),
    ).toThrow();
    expect(() => parse({ ...value, warnings: [{ ...value.warnings[0], pluginId: "" }] })).toThrow();
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
