import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const chmodFailHook = vi.hoisted(() => ({
  error: undefined as Error | undefined,
  silent: false,
  calls: 0,
}));

const statModeHook = vi.hoisted(() => ({
  nonPrivatePaths: new Set<string>(),
}));

const sqliteHook = vi.hoisted(() => ({
  instances: [] as Array<{ isOpen: boolean }>,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const chmodSync: typeof actual.chmodSync = ((target: unknown, mode: unknown) => {
    chmodFailHook.calls += 1;
    if (chmodFailHook.error) {
      throw chmodFailHook.error;
    }
    if (chmodFailHook.silent) {
      return undefined;
    }
    return (actual.chmodSync as (...args: unknown[]) => unknown)(target, mode);
  }) as typeof actual.chmodSync;
  const statSync: typeof actual.statSync = ((target: unknown, options: unknown) => {
    const stats = (actual.statSync as (...args: unknown[]) => { mode: number })(target, options);
    if (statModeHook.nonPrivatePaths.has(String(target))) {
      stats.mode = (stats.mode & ~0o777) | 0o644;
    }
    return stats;
  }) as typeof actual.statSync;
  return { ...actual, chmodSync, statSync, default: { ...actual, chmodSync, statSync } };
});

vi.mock("../infra/node-sqlite.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/node-sqlite.js")>();
  return {
    ...actual,
    requireNodeSqlite: () => {
      const real = actual.requireNodeSqlite();
      class TrackedDatabaseSync extends real.DatabaseSync {
        constructor(...args: ConstructorParameters<typeof real.DatabaseSync>) {
          super(...args);
          sqliteHook.instances.push(this);
        }
      }
      return { ...real, DatabaseSync: TrackedDatabaseSync };
    },
  };
});

const fs = await import("node:fs");
const {
  closeOpenClawAgentDatabasesForTest,
  enforcePrivateAgentDbFilePermissions,
  isDefaultProfileAgentDatabaseLocation,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
} = await import("./openclaw-agent-db.js");
const { closeOpenClawStateDatabaseForTest } = await import("./openclaw-state-db.js");
const { readPersistedAuthProfileStoreRaw, writePersistedAuthProfileStoreRaw } = await import(
  "../agents/auth-profiles/sqlite.js"
);

function chmodError(code: string): Error {
  const err = new Error(`${code}: chmod failed`) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

function openAgentDb(stateDir: string) {
  return openOpenClawAgentDatabase({ agentId: "main", env: { OPENCLAW_STATE_DIR: stateDir } });
}

describe("agent database permission hardening on chmod-less volumes", () => {
  let stateDir: string | undefined;
  const originalPlatform = process.platform;

  afterEach(() => {
    chmodFailHook.error = undefined;
    chmodFailHook.silent = false;
    chmodFailHook.calls = 0;
    statModeHook.nonPrivatePaths.clear();
    sqliteHook.instances.length = 0;
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    if (stateDir) {
      fs.rmSync(stateDir, { recursive: true, force: true });
      stateDir = undefined;
    }
  });

  it("hardens the agent database to private modes when chmod succeeds", () => {
    stateDir = fs.mkdtempSync(join(tmpdir(), "openclaw-agent-chmod-"));

    const database = openAgentDb(stateDir);

    expect(database.db.isOpen).toBe(true);
    expect(fs.statSync(dirname(database.path)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(database.path).mode & 0o777).toBe(0o600);
  });

  it("opens when chmod fails but the credential store is already private", () => {
    stateDir = fs.mkdtempSync(join(tmpdir(), "openclaw-agent-chmod-"));
    openAgentDb(stateDir);
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    chmodFailHook.error = chmodError("ENOTSUP");

    const database = openAgentDb(stateDir);

    expect(database.db.isOpen).toBe(true);
    expect(chmodFailHook.calls).toBeGreaterThan(0);
  });

  it("refuses when chmod reports success but the store stays world-readable", () => {
    stateDir = fs.mkdtempSync(join(tmpdir(), "openclaw-agent-chmod-"));
    const seed = openAgentDb(stateDir);
    const agentDir = dirname(seed.path);
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    fs.chmodSync(agentDir, 0o755);
    chmodFailHook.silent = true;

    expect(() => openAgentDb(stateDir as string)).toThrow(/cannot be made private/);
    expect(chmodFailHook.calls).toBeGreaterThan(0);
  });

  const refusalCases = [
    {
      name: "refuses when chmod fails and the agent directory is not private",
      code: "EPERM",
      win32: false,
      makeNonPrivate: true,
      expected: /cannot be made private/,
    },
    {
      name: "refuses with EACCES on a non-private agent directory",
      code: "EACCES",
      win32: false,
      makeNonPrivate: true,
      expected: /cannot be made private/,
    },
    {
      name: "refuses a relocated agent database on Windows because mode bits cannot prove ACL privacy",
      code: "ENOTSUP",
      win32: true,
      makeNonPrivate: false,
      expected: /relocated Windows/,
    },
  ];

  for (const testCase of refusalCases) {
    it(testCase.name, () => {
      stateDir = fs.mkdtempSync(join(tmpdir(), "openclaw-agent-chmod-"));
      const seed = openAgentDb(stateDir);
      const agentDir = dirname(seed.path);
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      if (testCase.makeNonPrivate) {
        fs.chmodSync(agentDir, 0o755);
      }
      if (testCase.win32) {
        Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      }
      chmodFailHook.error = chmodError(testCase.code);

      expect(() => openAgentDb(stateDir as string)).toThrow(testCase.expected);
    });
  }

  it("closes the freshly opened handle when the post-open privacy check refuses", () => {
    stateDir = fs.mkdtempSync(join(tmpdir(), "openclaw-agent-chmod-"));
    const dbPath = resolveOpenClawAgentSqlitePath({
      agentId: "main",
      env: { OPENCLAW_STATE_DIR: stateDir },
    });
    statModeHook.nonPrivatePaths.add(dbPath);

    expect(() => openAgentDb(stateDir as string)).toThrow(/cannot be made private/);

    expect(sqliteHook.instances.length).toBeGreaterThan(0);
    expect(sqliteHook.instances.every((db) => !db.isOpen)).toBe(true);
  });

  it("reads auth profiles from a private store opened read-only", () => {
    stateDir = fs.mkdtempSync(join(tmpdir(), "openclaw-agent-chmod-"));
    const seed = openAgentDb(stateDir);
    const agentDir = dirname(seed.path);
    writePersistedAuthProfileStoreRaw({ profiles: { main: { type: "api_key" } } }, agentDir, seed);
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();

    expect(readPersistedAuthProfileStoreRaw(agentDir)).toEqual({
      profiles: { main: { type: "api_key" } },
    });
  });

  it("refuses read-only auth-profile loads when the credential store stays world-readable", () => {
    stateDir = fs.mkdtempSync(join(tmpdir(), "openclaw-agent-chmod-"));
    const seed = openAgentDb(stateDir);
    const agentDir = dirname(seed.path);
    writePersistedAuthProfileStoreRaw({ profiles: {} }, agentDir, seed);
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    fs.chmodSync(seed.path, 0o644);
    chmodFailHook.silent = true;

    expect(() => readPersistedAuthProfileStoreRaw(agentDir)).toThrow(/cannot be made private/);
    expect(chmodFailHook.calls).toBeGreaterThan(0);
  });

  it("trusts the default per-user agent database location on Windows even when chmod cannot harden it", () => {
    stateDir = fs.mkdtempSync(join(tmpdir(), "openclaw-agent-chmod-"));
    const filePath = join(stateDir, "openclaw-agent.sqlite");
    fs.writeFileSync(filePath, "");
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    chmodFailHook.error = chmodError("ENOTSUP");

    expect(() => enforcePrivateAgentDbFilePermissions(filePath, true)).not.toThrow();
    expect(chmodFailHook.calls).toBeGreaterThan(0);
  });

  it("refuses a relocated agent database location on Windows", () => {
    stateDir = fs.mkdtempSync(join(tmpdir(), "openclaw-agent-chmod-"));
    const filePath = join(stateDir, "openclaw-agent.sqlite");
    fs.writeFileSync(filePath, "");
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });

    expect(() => enforcePrivateAgentDbFilePermissions(filePath, false)).toThrow(/relocated Windows/);
  });
});

describe("default profile agent database location detection", () => {
  it("treats the default per-user agent database path as the trusted profile location", () => {
    const env = { NODE_ENV: "test" } as NodeJS.ProcessEnv;
    const dbPath = resolveOpenClawAgentSqlitePath({ agentId: "main", env });

    expect(isDefaultProfileAgentDatabaseLocation(dbPath, env)).toBe(true);
  });

  it("treats a relocated OPENCLAW_STATE_DIR agent database as untrusted", () => {
    const env = { OPENCLAW_STATE_DIR: join(tmpdir(), "relocated-state") } as NodeJS.ProcessEnv;
    const dbPath = resolveOpenClawAgentSqlitePath({ agentId: "main", env });

    expect(isDefaultProfileAgentDatabaseLocation(dbPath, env)).toBe(false);
  });

  it("treats a path outside the default agents root as untrusted", () => {
    const env = { NODE_ENV: "test" } as NodeJS.ProcessEnv;
    const outside = join(tmpdir(), "elsewhere", "openclaw-agent.sqlite");

    expect(isDefaultProfileAgentDatabaseLocation(outside, env)).toBe(false);
  });
});
