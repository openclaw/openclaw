import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  createOpenClawAgentDatabasePathMatcher,
  isSameOpenClawAgentDatabasePath,
} from "./openclaw-agent-db.paths.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    cleanup();
  }),
);
let stateDir: string;
beforeEach(() => {
  stateDir = fs.realpathSync(tempDirs.make("openclaw-alias-"));
});
const at = (...parts: string[]) => path.join(stateDir, ...parts);

it.runIf(process.platform !== "win32")("retries ELOOP resolution within one matcher", () => {
  const loopPath = at("loop.sqlite");
  fs.symlinkSync("loop.sqlite", loopPath);
  expect(() => isSameOpenClawAgentDatabasePath(loopPath, loopPath)).toThrow(
    expect.objectContaining({ code: "ELOOP" }),
  );
  const matchesPath = createOpenClawAgentDatabasePathMatcher();
  const key = matchesPath.createIndex();
  expect(() => matchesPath(loopPath, loopPath)).toThrow(expect.objectContaining({ code: "ELOOP" }));
  expect(() => key(loopPath)).toThrow(expect.objectContaining({ code: "ELOOP" }));

  fs.unlinkSync(loopPath);
  fs.writeFileSync(loopPath, "recovered");
  expect(matchesPath(loopPath, loopPath)).toBe(true);
  expect(key(loopPath)).toBe(loopPath);
});

it("indexes each existing or missing database locator once per operation", () => {
  const paths = Array.from({ length: 64 }, (_, index) => {
    const directory = at(`agent-${index}`);
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
  const matcher = createOpenClawAgentDatabasePathMatcher();
  const key = matcher.createIndex();
  const reverseKey = matcher.createIndex();
  expect(paths.map(key)).toEqual(paths);
  expect(paths.toReversed().map(reverseKey)).toEqual(paths.toReversed());
  expect(paths.map(key)).toEqual(paths);
  expect([
    realpath.mock.calls.filter(([pathname]) => pathSet.has(String(pathname))).length,
    stat.mock.calls.filter(([pathname]) => statPaths.has(String(pathname))).length,
  ]).toEqual([paths.length, paths.length]);
  expect(matcher.isCurrent()).toBe(true);
});

it.runIf(process.platform !== "win32")(
  "indexes physical aliases and refreshes replacements",
  () => {
    const first = at("first.sqlite");
    const second = at("second.sqlite");
    const alias = at("alias.sqlite");
    const hardlink = at("hardlink.sqlite");
    fs.writeFileSync(first, "first");
    fs.writeFileSync(second, "second");
    fs.symlinkSync(first, alias);
    fs.linkSync(first, hardlink);
    const matcher = createOpenClawAgentDatabasePathMatcher();
    const key = matcher.createIndex();
    expect([first, second, alias, hardlink].map(key)).toEqual([first, second, first, first]);
    const independentKey = matcher.createIndex();
    expect([hardlink, first].map(independentKey)).toEqual([hardlink, hardlink]);
    expect(matcher.isCurrent()).toBe(true);

    fs.unlinkSync(first);
    fs.linkSync(second, first);
    const bridge = at("bridge.sqlite");
    const secondHardlink = at("second-hardlink.sqlite");
    fs.symlinkSync(first, bridge);
    fs.linkSync(second, secondHardlink);
    expect([bridge, secondHardlink].map(key)).toEqual([first, second]);
    expect(matcher.isCurrent()).toBe(false);
    const refreshed = createOpenClawAgentDatabasePathMatcher().createIndex();
    expect([first, alias, second].map(refreshed)).toEqual([first, first, first]);
    expect(refreshed(hardlink)).toBe(hardlink);
  },
);

it("compares missing suffixes deeper than the default probe depth", () => {
  const probePath = at("CaseProbe");
  fs.writeFileSync(probePath, "probe");
  const aliases = fs.existsSync(at("caseProbe"));
  fs.unlinkSync(probePath);

  const parents = Array.from({ length: 64 }, () => "a");
  const upper = at(...parents, "Worker.sqlite");
  const lower = at(...parents, "worker.sqlite");
  expect(isSameOpenClawAgentDatabasePath(upper, lower)).toBe(aliases);
  const matcher = createOpenClawAgentDatabasePathMatcher();
  const key = matcher.createIndex();
  expect(key(upper) === key(lower)).toBe(aliases);
  expect(fs.readdirSync(stateDir)).toEqual([]);
});

it("does not cache a missing-path comparison when its probe cannot be cleaned", () => {
  const compare = () =>
    isSameOpenClawAgentDatabasePath(at("a", "alpha.sqlite"), at("a", "bravo.sqlite"));
  const removeDirectory = fs.rmdirSync;
  let preservedProbe = "";
  vi.spyOn(fs, "rmdirSync").mockImplementationOnce((directory) => {
    preservedProbe = String(directory);
    fs.writeFileSync(path.join(preservedProbe, "sentinel"), "preserve");
    removeDirectory(directory);
  });
  syncBuiltinESMExports();
  expect(compare).toThrow("Cannot determine whether database paths alias");
  const occupiedPaths = Array.from("bcdefghijklmnopqrstuvwxyz0123456789", (name) => at(name));
  for (const entry of occupiedPaths) {
    if (entry !== preservedProbe) {
      fs.writeFileSync(entry, "occupied");
    }
  }
  expect(compare).toThrow("Cannot determine whether database paths alias");
  expect(fs.readFileSync(path.join(preservedProbe, "sentinel"), "utf8")).toBe("preserve");
  fs.unlinkSync(path.join(preservedProbe, "sentinel"));
  for (const entry of occupiedPaths) {
    const remove = entry === preservedProbe ? fs.rmdirSync : fs.unlinkSync;
    remove(entry);
  }
  expect(compare()).toBe(false);
  expect(fs.readdirSync(stateDir)).toEqual([]);
});
