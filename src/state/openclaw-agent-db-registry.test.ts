import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { isSameOpenClawAgentDatabasePath } from "./openclaw-agent-db-registry.js";

describe("agent database alias observation", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
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
