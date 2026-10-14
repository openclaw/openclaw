import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  createOpenClawAgentDatabasePathMatcher,
  isSameOpenClawAgentDatabasePath,
} from "./openclaw-agent-db.paths.js";

describe("agent database alias observation", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it.runIf(process.platform !== "win32")(
    "retries path resolution failures within one matcher",
    () => {
      const stateDir = fs.realpathSync(tempDirs.make("openclaw-agent-db-"));
      const loopPath = path.join(stateDir, "loop.sqlite");
      fs.symlinkSync("loop.sqlite", loopPath);
      expect(() => isSameOpenClawAgentDatabasePath(loopPath, loopPath)).toThrow(
        expect.objectContaining({ code: "ELOOP" }),
      );
      const matchesPath = createOpenClawAgentDatabasePathMatcher();
      const key = matchesPath.createIndex();
      expect(() => matchesPath(loopPath, loopPath)).toThrow(
        expect.objectContaining({ code: "ELOOP" }),
      );
      expect(() => key(loopPath)).toThrow(expect.objectContaining({ code: "ELOOP" }));

      fs.unlinkSync(loopPath);
      fs.writeFileSync(loopPath, "recovered");
      expect(matchesPath(loopPath, loopPath)).toBe(true);
      expect(key(loopPath)).toBe(loopPath);
    },
  );

  it("indexes each existing or missing database locator once per operation", () => {
    const stateDir = fs.realpathSync(tempDirs.make("openclaw-agent-db-index-"));
    const paths = Array.from({ length: 64 }, (_, index) => {
      const directory = path.join(stateDir, `agent-${index}`);
      fs.mkdirSync(directory);
      const pathname = path.join(directory, "agent.sqlite");
      if (index % 2 === 0) {
        fs.writeFileSync(pathname, "database");
      }
      return pathname;
    });
    const pathSet = new Set(paths);
    const statPaths = new Set(
      paths.map((pathname, index) => (index % 2 === 0 ? pathname : path.dirname(pathname))),
    );
    const realpath = vi.spyOn(fs.realpathSync, "native");
    const stat = vi.spyOn(fs, "statSync");
    syncBuiltinESMExports();
    try {
      const matcher = createOpenClawAgentDatabasePathMatcher();
      const key = matcher.createIndex();
      const reverseKey = matcher.createIndex();
      expect(paths.map(key)).toEqual(paths);
      expect(paths.toReversed().map(reverseKey)).toEqual(paths.toReversed());
      expect(paths.map(key)).toEqual(paths);
      expect(
        realpath.mock.calls.filter(([pathname]) => pathSet.has(String(pathname))),
      ).toHaveLength(paths.length);
      expect(stat.mock.calls.filter(([pathname]) => statPaths.has(String(pathname)))).toHaveLength(
        paths.length,
      );
      expect(matcher.isCurrent()).toBe(true);
    } finally {
      realpath.mockRestore();
      stat.mockRestore();
      syncBuiltinESMExports();
    }
  });

  it.runIf(process.platform !== "win32")(
    "keeps the first physical representative and refreshes replaced aliases in a new operation",
    () => {
      const stateDir = fs.realpathSync(tempDirs.make("openclaw-agent-db-index-alias-"));
      const first = path.join(stateDir, "first.sqlite");
      const second = path.join(stateDir, "second.sqlite");
      const alias = path.join(stateDir, "alias.sqlite");
      const hardlink = path.join(stateDir, "hardlink.sqlite");
      fs.writeFileSync(first, "first");
      fs.writeFileSync(second, "second");
      fs.symlinkSync(first, alias);
      fs.linkSync(first, hardlink);
      const matcher = createOpenClawAgentDatabasePathMatcher();
      const key = matcher.createIndex();
      expect(key(first)).toBe(first);
      expect(key(second)).toBe(second);
      expect(key(alias)).toBe(first);
      expect(key(hardlink)).toBe(first);
      const independentKey = matcher.createIndex();
      expect(independentKey(hardlink)).toBe(hardlink);
      expect(independentKey(first)).toBe(hardlink);
      expect(matcher.isCurrent()).toBe(true);

      fs.unlinkSync(first);
      fs.linkSync(second, first);
      const bridge = path.join(stateDir, "bridge.sqlite");
      const secondHardlink = path.join(stateDir, "second-hardlink.sqlite");
      fs.symlinkSync(first, bridge);
      fs.linkSync(second, secondHardlink);
      expect(key(bridge)).toBe(first);
      expect(key(secondHardlink)).toBe(second);
      expect(matcher.isCurrent()).toBe(false);
      const refreshed = createOpenClawAgentDatabasePathMatcher().createIndex();
      expect(refreshed(first)).toBe(first);
      expect(refreshed(alias)).toBe(first);
      expect(refreshed(second)).toBe(first);
      expect(refreshed(hardlink)).toBe(hardlink);
    },
  );

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
    const matcher = createOpenClawAgentDatabasePathMatcher();
    const key = matcher.createIndex();
    expect(
      key(path.join(stateDir, ...parents, "Worker.sqlite")) ===
        key(path.join(stateDir, ...parents, "worker.sqlite")),
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
