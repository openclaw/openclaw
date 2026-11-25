import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { probeTreeClone } from "@openclaw/fs-safe/copy";
import { expect, it, vi } from "vitest";
import { sqliteMaintenanceFixture } from "./sqlite-maintenance-fixture.test-support.js";

const resources = sqliteMaintenanceFixture();

vi.mock("@openclaw/fs-safe/copy", { spy: true });

function mockDarwinMountMetadata(mount: () => string): void {
  vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  vi.spyOn(fs, "statfsSync").mockImplementation(() => {
    throw new Error("statfs unavailable");
  });
  vi.spyOn(fs, "readFileSync").mockImplementation(() => {
    throw new Error("no proc mountinfo");
  });
  vi.spyOn(childProcess, "execFileSync").mockImplementation(mount);
}

function journalMode(databasePath: string): unknown {
  return resources.wal({ databasePath }).writer.prepare("PRAGMA journal_mode;").get();
}

it.runIf(process.platform !== "win32").each(["canonical", "aliased"])(
  "classifies %s APFS paths on macOS, forking mount only for aliases",
  (pathKind) => {
    const root = fs.realpathSync(resources.dir("openclaw-sqlite-apfs-"));
    const directory = path.join(root, "database");
    fs.mkdirSync(directory);
    const alias = path.join(root, "alias");
    fs.symlinkSync(directory, alias);
    mockDarwinMountMetadata(() => `/dev/disk3s5 on ${root} (apfs, local)\n`);
    vi.mocked(probeTreeClone).mockReturnValue("apfs");

    const mode = journalMode(
      path.join(pathKind === "canonical" ? directory : alias, "state.sqlite"),
    );

    expect(childProcess.execFileSync).toHaveBeenCalledTimes(pathKind === "canonical" ? 0 : 1);
    expect(mode).toEqual({ journal_mode: "wal" });
  },
);

it("preserves WAL policy when mount classification fails without timing out", () => {
  mockDarwinMountMetadata(() => {
    throw Object.assign(new Error("spawnSync mount ENOENT"), { code: "ENOENT" });
  });
  vi.mocked(probeTreeClone).mockReturnValue(undefined);

  expect(journalMode(resources.file())).toEqual({ journal_mode: "wal" });
  expect(childProcess.execFileSync).toHaveBeenCalledTimes(1);
});
