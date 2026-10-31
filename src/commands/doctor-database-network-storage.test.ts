import childProcess from "node:child_process";
import syncFs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as notes from "../../packages/terminal-core/src/note.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as sqliteLibrary from "../infra/bun-sqlite-library.js";
import { createDatabaseStoreDiagnostic } from "../infra/database-engine/diagnostic-record.js";
import * as engineInspection from "./doctor-database-engine-inspection.js";
import { noteDatabaseEngines } from "./doctor-database-engine.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it("warns without blocking for confirmed network SQLite storage, not unknown or cross-VM mounts", async () => {
  const note = vi.spyOn(notes, "note").mockImplementation(() => {});
  vi.spyOn(sqliteLibrary, "ensureSqliteLibrarySelected").mockReturnValue({ source: "runtime" });
  const root = syncFs.realpathSync(tempDirs.make("doctor-network-storage-"));
  const env = { HOME: root, OPENCLAW_STATE_DIR: root };
  const file = path.join(root, "state.sqlite");
  const store = createDatabaseStoreDiagnostic({
    family: "state",
    path: file,
    configured: { default: "sqlite", override: null, effective: "sqlite", fixedLocal: false },
  });
  store.observed = "sqlite";
  store.legacyMigrations.state = "none";
  const inspect = vi.spyOn(engineInspection, "inspectDoctorDatabaseEngines").mockResolvedValue({
    observed: { state: ["sqlite"] },
    stateRoots: [],
    discoveryFailed: false,
    stores: [
      store,
      { ...store, observed: "unknown", family: "agent", path: path.join(root, "agent.sqlite") },
      { ...store, observed: "postgres", path: path.join(root, "postgres-anchor.sqlite") },
    ],
  });
  const networkFindings = async (options: Parameters<typeof noteDatabaseEngines>[1] = { env }) =>
    (await noteDatabaseEngines({}, options)).filter((finding) =>
      finding.message.includes("network filesystem"),
    );
  const nativeStatfs = syncFs.statfsSync(root);
  const statfs = vi.spyOn(syncFs, "statfsSync");
  const readFile = syncFs.readFileSync;
  const mountInfo = vi.spyOn(syncFs, "readFileSync");
  const mount = vi.spyOn(childProcess, "execFileSync");
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  for (const [type, magic, warning] of [
    ["nfs4", 0x6969, true],
    ["nfs", 0, true],
    ["smbfs", 0, true],
    ["fuse.sshfs", 0, true],
    ["virtiofs", 0, false],
    ["9p", 0x01021997, false],
    ["unknown", 0, false],
  ] as const) {
    statfs.mockReturnValue(Object.assign(nativeStatfs, { type: magic }));
    if (type === "unknown") {
      statfs.mockImplementation(() => {
        throw new Error("statfs unavailable");
      });
    }
    mountInfo.mockImplementation((...args) => {
      if (args[0] === "/proc/self/mountinfo") {
        if (type === "unknown") {
          throw new Error("mount metadata unavailable");
        }
        return `1 0 0:1 / / rw - ${type} fixture rw\n`;
      }
      return readFile(...args);
    });
    mount.mockImplementation(() => {
      throw Object.assign(new Error("mount timed out"), { code: "ETIMEDOUT" });
    });
    mount.mockClear();
    vi.mocked(note).mockClear();
    const network = await networkFindings();
    expect(network, type).toHaveLength(warning ? 2 : 0);
    if (type === "unknown") {
      expect(mount).toHaveBeenCalledTimes(1);
    }
    if (warning) {
      expect(network[0]).toMatchObject({
        severity: "warning",
        path: file,
        message: expect.stringContaining("WAL can cause corruption"),
        fixHint: expect.stringContaining("local disk"),
      });
      expect(String(vi.mocked(note).mock.calls[0]?.[0])).toContain("rollback journaling");
    }
  }
  const realpath = vi.spyOn(syncFs, "realpathSync").mockImplementation(() => {
    throw new Error("path permission denied");
  });
  expect(await networkFindings()).toEqual([]);
  realpath.mockRestore();
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  const nativeRealpath = vi.spyOn(syncFs.realpathSync, "native");
  for (const [target, resolved, warning] of [
    [String.raw`\\nas\state\openclaw.sqlite`, undefined, true],
    [String.raw`Z:\state\openclaw.sqlite`, String.raw`\\nas\state\openclaw.sqlite`, true],
    [String.raw`C:\state\openclaw.sqlite`, String.raw`C:\state`, false],
    [String.raw`Z:\denied\openclaw.sqlite`, undefined, false],
  ] as const) {
    inspect.mockResolvedValue({
      observed: {},
      stateRoots: [],
      discoveryFailed: false,
      stores: [{ ...store, path: target }],
    });
    nativeRealpath.mockImplementation(() => {
      if (!resolved) {
        throw new Error("path permission denied");
      }
      return resolved;
    });
    expect(await networkFindings({}), target).toHaveLength(warning ? 1 : 0);
  }
});
