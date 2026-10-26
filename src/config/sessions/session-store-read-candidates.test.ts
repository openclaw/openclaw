import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as targetPaths from "./session-sqlite-target-paths.js";
import {
  assertSessionStoreReadCandidate as assertCandidate,
  isSessionStoreReadCandidateCurrent as isCurrent,
} from "./session-store-read-candidates.js";
import { captureSessionStoreWriteCandidates as captureWrites } from "./session-store-target-inventory.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const capturedAlias = "/tmp/RUNNER~1/openclaw-agent.sqlite";
const canonicalAlias = "/tmp/runneradmin/openclaw-agent.sqlite";
const redirectedAlias = "/tmp/replacement/openclaw-agent.sqlite";

afterEach(() => vi.restoreAllMocks());

function mockRealpath(from: string, to: string) {
  vi.spyOn(fs.realpathSync, "native").mockImplementation((pathname) =>
    String(pathname) === from ? to : String(pathname),
  );
}

function expectCustody(pathname: string, physicalPath: string, selected = pathname) {
  const candidate = { path: pathname, physicalPath };
  expect(isCurrent(candidate)).toBe(true);
  expect(assertCandidate(selected, [candidate])).toBe(physicalPath);
}

function directory(root: string, name: string) {
  const pathname = path.join(root, name);
  fs.mkdirSync(pathname);
  return pathname;
}

function mockWindowsSymlinks(isSymbolicLink: boolean) {
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  vi.spyOn(fs, "lstatSync").mockReturnValue({ isSymbolicLink: () => isSymbolicLink } as fs.Stats);
}

test.each([
  ["converged alias", capturedAlias, canonicalAlias, false, true],
  ["symlink redirect", capturedAlias, redirectedAlias, true, false],
  ["lexical redirect", redirectedAlias, canonicalAlias, undefined, false],
] as const)("checks exact candidate custody: %s", (_name, selected, resolved, symlink, current) => {
  if (symlink !== undefined) {
    mockWindowsSymlinks(symlink);
  }
  mockRealpath(capturedAlias, resolved);
  const candidate = { path: selected, physicalPath: capturedAlias };
  expect(isCurrent(candidate)).toBe(current);
  if (current) {
    expect(assertCandidate(selected, [candidate])).toBe(resolved);
  }
});

test.each([true, false])("limits Windows alias custody to its parent (same=%s)", (sameParent) => {
  const root = tempDirs.make("session-store-windows-alias-");
  const shortPath = sameParent
    ? path.join(root, "OPENCL~1")
    : path.join(directory(root, "RUNNER~1"), "openclaw-agent.sqlite");
  const longPath = path.join(sameParent ? root : directory(root, "other"), "openclaw-agent.sqlite");
  fs.writeFileSync(shortPath, "");
  fs.linkSync(shortPath, longPath);
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  if (sameParent) {
    expectCustody(shortPath, longPath, longPath);
  } else {
    expect(() => assertCandidate(longPath, [{ path: shortPath, physicalPath: shortPath }])).toThrow(
      /outside captured discovery custody/,
    );
  }
});

test.each([
  ["file", "/tmp/custom/openclaw-agent.sqlite", "/tmp/database-target/openclaw-agent.sqlite", true],
  ["directory", "/tmp/custom", "/tmp/replacement", false],
] as const)("tracks family directory identity (%s retargeted)", (_kind, from, to, current) => {
  const family = "/tmp/custom/openclaw-agent.sqlite";
  mockRealpath(from, to);
  expect(isCurrent({ path: family, physicalPath: family, scope: "sibling-family" })).toBe(current);
});

test.each([false, true])("keeps sibling absence until creation (%s)", async (appeared) => {
  const root = tempDirs.make("session-store-absent-family-");
  const captured = captureWrites(path.join(root, "custom.json"));
  const selected = path.join(root, "custom.main.4.sqlite");
  await Promise.resolve();
  if (appeared) {
    fs.writeFileSync(selected, "later database");
    expect(() => captured.resolveIdentity(selected)).toThrow(
      "appeared after its initial inventory",
    );
  } else {
    const canonicalPath = path.join(fs.realpathSync(root), "custom.main.4.sqlite");
    expect(captured.resolveIdentity(selected)).toEqual({
      key: `path:${canonicalPath}`,
      canonicalPath,
    });
  }
});

test("does not certify sibling absence when the initial directory listing failed", async () => {
  const root = tempDirs.make("session-store-incomplete-family-");
  const known = path.join(root, "custom.sqlite");
  fs.writeFileSync(known, "existing database");
  vi.spyOn(targetPaths, "listSqliteTargetCandidatePathsForSessionStorePath").mockImplementation(
    () => {
      throw Object.assign(new Error("directory listing denied"), { code: "EACCES" });
    },
  );
  const captured = captureWrites(path.join(root, "custom.json"));
  await Promise.resolve();
  expect(captured.resolveIdentity(known).key).toMatch(/^file:/);
  expect(() => captured.resolveIdentity(path.join(root, "custom.main.sqlite"))).toThrow(
    "absence was not captured",
  );
});

test.runIf(process.platform !== "win32")(
  "rejects an absent sibling after its directory alias is retargeted",
  async () => {
    const root = tempDirs.make("session-store-absent-alias-");
    const original = directory(root, "original");
    const replacement = directory(root, "replacement");
    const alias = path.join(root, "alias");
    fs.symlinkSync(original, alias, "junction");
    const captured = captureWrites(path.join(alias, "custom.json"));
    await Promise.resolve();
    fs.unlinkSync(alias);
    fs.symlinkSync(replacement, alias, "junction");
    expect(() => captured.resolveIdentity(path.join(alias, "custom.main.sqlite"))).toThrow(
      "selector changed during discovery",
    );
    expect(fs.readdirSync(replacement)).toEqual([]);
  },
);

test.each(process.platform === "win32" ? ["file"] : ["file", "symlink"])(
  "never converts a removed positive %s into creation authority",
  async (kind) => {
    const root = tempDirs.make("session-store-positive-removal-");
    const selected = path.join(root, "custom.main.sqlite");
    const physical = kind === "symlink" ? path.join(root, "physical.db") : selected;
    fs.writeFileSync(physical, "original database");
    if (kind === "symlink") {
      fs.symlinkSync(physical, selected);
    }
    const captured = captureWrites(path.join(root, "custom.json"));
    await Promise.resolve();
    fs.unlinkSync(selected);
    expect(() => captured.resolveIdentity(selected)).toThrow();
    expect(fs.existsSync(selected)).toBe(false);
  },
);
