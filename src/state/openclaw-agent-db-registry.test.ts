import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { isSameOpenClawAgentDatabasePath } from "./openclaw-agent-db-registry.js";

describe("agent database alias observation", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it("compares missing suffixes deeper than the default probe depth", () => {
    const stateDir = fs.realpathSync(tempDirs.make("openclaw-alias-deep-"));
    const probePath = path.join(stateDir, "CaseProbe");
    fs.writeFileSync(probePath, "probe");
    let aliases = false;
    try {
      const original = fs.lstatSync(probePath, { bigint: true });
      const alternate = fs.lstatSync(path.join(stateDir, "caseProbe"), { bigint: true });
      aliases = original.dev === alternate.dev && original.ino === alternate.ino;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    } finally {
      fs.unlinkSync(probePath);
    }

    const parents = Array.from({ length: 64 }, () => "a");
    expect(
      isSameOpenClawAgentDatabasePath(
        path.join(stateDir, ...parents, "Worker.sqlite"),
        path.join(stateDir, ...parents, "worker.sqlite"),
      ),
    ).toBe(aliases);
    expect(fs.readdirSync(stateDir)).toEqual([]);
  });

  it("does not cache a missing-path comparison when its probe cannot be cleaned", () => {
    const stateDir = fs.realpathSync(tempDirs.make("openclaw-alias-cleanup-"));
    const compare = () =>
      isSameOpenClawAgentDatabasePath(
        path.join(stateDir, "a", "alpha.sqlite"),
        path.join(stateDir, "a", "bravo.sqlite"),
      );
    const removeDirectory = fs.rmdirSync;
    let preservedProbe = "";
    const removal = vi.spyOn(fs, "rmdirSync").mockImplementationOnce((directory) => {
      preservedProbe = String(directory);
      fs.writeFileSync(path.join(preservedProbe, "sentinel"), "preserve");
      removeDirectory(directory);
    });
    syncBuiltinESMExports();
    try {
      expect(compare).toThrow("Cannot determine whether database paths alias");
    } finally {
      removal.mockRestore();
      syncBuiltinESMExports();
    }
    const occupiedNames = Array.from("bcdefghijklmnopqrstuvwxyz0123456789");
    for (const name of occupiedNames) {
      const entry = path.join(stateDir, name);
      if (entry !== preservedProbe) {
        fs.writeFileSync(entry, "occupied");
      }
    }
    expect(compare).toThrow("Cannot determine whether database paths alias");
    expect(fs.readFileSync(path.join(preservedProbe, "sentinel"), "utf8")).toBe("preserve");
    fs.unlinkSync(path.join(preservedProbe, "sentinel"));
    for (const name of occupiedNames) {
      const entry = path.join(stateDir, name);
      if (entry === preservedProbe) {
        fs.rmdirSync(entry);
      } else {
        fs.unlinkSync(entry);
      }
    }
    expect(compare()).toBe(false);
    expect(fs.readdirSync(stateDir)).toEqual([]);
  });
});
