import childProcess from "node:child_process";
import syncFs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { note } from "../../packages/terminal-core/src/note.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createDatabaseStoreDiagnostic } from "../infra/database-engine/diagnostic-record.js";
import * as engineInspection from "./doctor-database-engine-inspection.js";
import { noteDatabaseEngines } from "./doctor-database-engine.js";

vi.mock("../../packages/terminal-core/src/note.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../packages/terminal-core/src/note.js")>()),
  note: vi.fn(),
}));
vi.mock("./doctor-database-engine-inspection.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./doctor-database-engine-inspection.js")>()),
  inspectDoctorDatabaseEngines: vi.fn(),
}));
vi.mock("../infra/bun-sqlite-library.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/bun-sqlite-library.js")>()),
  ensureSqliteLibrarySelected: () => ({ source: "runtime" }),
}));
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it("warns without blocking for confirmed network SQLite storage, not unknown or cross-VM mounts", async () => {
  const root = syncFs.realpathSync(tempDirs.make("doctor-network-storage-"));
  const state = {
    stateDir: root,
    statePath: (name: string) => path.join(root, name),
    env: { HOME: root, OPENCLAW_STATE_DIR: root },
  };
  const file = state.statePath("state.sqlite");
  const store = createDatabaseStoreDiagnostic({
    family: "state",
    path: file,
    configured: { default: "sqlite", override: null, effective: "sqlite", fixedLocal: false },
  });
  store.observed = "sqlite";
  store.legacyMigrations.state = "none";
  vi.mocked(engineInspection.inspectDoctorDatabaseEngines).mockResolvedValue({
    observed: { state: ["sqlite"] },
    stateRoots: [],
    discoveryFailed: false,
    stores: [
      store,
      { ...store, observed: "unknown", family: "agent", path: state.statePath("agent.sqlite") },
      { ...store, observed: "postgres", path: state.statePath("postgres-anchor.sqlite") },
    ],
  });
  const nativeStatfs = syncFs.statfsSync(state.stateDir);
  const statfs = vi.spyOn(syncFs, "statfsSync");
  const readFile = syncFs.readFileSync;
  const mountInfo = vi.spyOn(syncFs, "readFileSync");
  const mount = vi.spyOn(childProcess, "execFileSync");
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");

  for (const { type, magic, warning } of [
    { type: "nfs4", magic: 0x6969, warning: true },
    { type: "cifs", magic: 0xff534d42, warning: true },
    { type: "nfs", magic: 0, warning: true },
    { type: "smbfs", magic: 0, warning: true },
    { type: "fuse.sshfs", magic: 0, warning: true },
    { type: "virtiofs", magic: 0, warning: false },
    { type: "9p", magic: 0x01021997, warning: false },
    { type: "ext4", magic: 0, warning: false },
    { type: "unknown", magic: 0, warning: false },
  ]) {
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
    const findings = await noteDatabaseEngines({}, { env: state.env });
    const network = findings.filter((finding) => finding.message.includes("network filesystem"));
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
  expect(
    (await noteDatabaseEngines({}, { env: state.env })).filter((finding) =>
      finding.message.includes("network filesystem"),
    ),
  ).toEqual([]);
  realpath.mockRestore();

  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  const nativeRealpath = vi.spyOn(syncFs.realpathSync, "native");
  for (const { target, resolved, warning } of [
    { target: String.raw`\\nas\state\openclaw.sqlite`, resolved: undefined, warning: true },
    {
      target: String.raw`Z:\state\openclaw.sqlite`,
      resolved: String.raw`\\nas\state\openclaw.sqlite`,
      warning: true,
    },
    {
      target: String.raw`C:\state\openclaw.sqlite`,
      resolved: String.raw`C:\state`,
      warning: false,
    },
    { target: String.raw`Z:\denied\openclaw.sqlite`, resolved: undefined, warning: false },
  ]) {
    vi.mocked(engineInspection.inspectDoctorDatabaseEngines).mockResolvedValue({
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
    expect(
      (await noteDatabaseEngines({})).filter((finding) =>
        finding.message.includes("network filesystem"),
      ),
      target,
    ).toHaveLength(warning ? 1 : 0);
  }
});
