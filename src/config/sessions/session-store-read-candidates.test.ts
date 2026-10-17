import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as targetPaths from "./session-sqlite-target-paths.js";
import {
  assertSessionStoreReadCandidate as assertCandidate,
  isSessionStoreReadCandidateCurrent as isCurrent,
  type SessionStoreReadCandidate,
} from "./session-store-read-candidates.js";
import { captureSessionStoreWriteCandidates as captureWrites } from "./session-store-target-inventory.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  vi.restoreAllMocks();
});

function mockRealpath(from: string, to: string) {
  vi.spyOn(fs.realpathSync, "native").mockImplementation((pathname) =>
    String(pathname) === from ? to : String(pathname),
  );
}

function expectCurrent(
  pathname: string,
  expected: boolean,
  scope?: SessionStoreReadCandidate["scope"],
  physicalPath = pathname,
) {
  expect(isCurrent({ path: pathname, physicalPath, scope })).toBe(expected);
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

test("keeps custody when a captured alias later resolves to the same file", () => {
  const capturedAlias = "/tmp/RUNNER~1/home/.openclaw/agents/main/agent/openclaw-agent.sqlite";
  const canonicalPath = "/tmp/runneradmin/home/.openclaw/agents/main/agent/openclaw-agent.sqlite";
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  vi.spyOn(fs, "lstatSync").mockReturnValue({
    isSymbolicLink: () => false,
  } as fs.Stats);
  mockRealpath(capturedAlias, canonicalPath);

  const candidate = { path: capturedAlias, physicalPath: capturedAlias };
  expect(isCurrent(candidate)).toBe(true);
  expect(assertCandidate(capturedAlias, [candidate])).toBe(canonicalPath);
});

test.runIf(process.platform !== "win32")(
  "keeps exact custody across POSIX lexical and physical directory spellings",
  () => {
    const root = tempDirs.make("session-store-posix-alias-");
    const physicalDir = directory(root, "physical");
    const aliasDir = path.join(root, "alias");
    fs.symlinkSync(physicalDir, aliasDir, "junction");
    const physicalPath = path.join(physicalDir, "openclaw-agent.sqlite");
    const aliasPath = path.join(aliasDir, "openclaw-agent.sqlite");
    fs.writeFileSync(physicalPath, "");

    expectCustody(aliasPath, physicalPath, physicalPath);
  },
);

test("keeps custody when Windows preserves distinct short and long spellings for one file", () => {
  const root = tempDirs.make("session-store-windows-alias-");
  const shortPath = path.join(root, "OPENCL~1");
  const longPath = path.join(root, "openclaw-agent.sqlite");
  fs.writeFileSync(shortPath, "");
  fs.linkSync(shortPath, longPath);
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");

  expectCustody(shortPath, longPath, longPath);
});

test("rejects a same-file Windows short path outside the captured parent", () => {
  const root = tempDirs.make("session-store-windows-hardlink-");
  const shortDir = directory(root, "RUNNER~1");
  const otherDir = directory(root, "other");
  const shortPath = path.join(shortDir, "openclaw-agent.sqlite");
  const otherPath = path.join(otherDir, "openclaw-agent.sqlite");
  fs.writeFileSync(shortPath, "");
  fs.linkSync(shortPath, otherPath);
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");

  expect(() => assertCandidate(otherPath, [{ path: shortPath, physicalPath: shortPath }])).toThrow(
    /outside captured discovery custody/,
  );
});

test("rejects a Windows short-path candidate redirected through a symlink", () => {
  const capturedAlias = "/tmp/RUNNER~1/openclaw-agent.sqlite";
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  vi.spyOn(fs, "lstatSync").mockReturnValue({
    isSymbolicLink: () => true,
  } as fs.Stats);
  vi.spyOn(fs.realpathSync, "native").mockReturnValue("/tmp/replacement/openclaw-agent.sqlite");

  expectCurrent(capturedAlias, false);
});

test("keeps sibling-family custody scoped to the captured directory", () => {
  const familyPath = "/tmp/custom/openclaw-agent.sqlite";
  mockRealpath(familyPath, "/tmp/database-target/openclaw-agent.sqlite");
  expectCurrent(familyPath, true, "sibling-family");
});

test("rejects a sibling-family candidate whose directory target changed", () => {
  const familyPath = "/tmp/custom/openclaw-agent.sqlite";
  mockRealpath("/tmp/custom", "/tmp/replacement");
  expectCurrent(familyPath, false, "sibling-family");
});

test("rejects a candidate whose lexical target changed", () => {
  const capturedAlias = "/tmp/RUNNER~1/openclaw-agent.sqlite";
  const replacement = "/tmp/replacement/openclaw-agent.sqlite";
  mockRealpath(capturedAlias, "/tmp/runneradmin/openclaw-agent.sqlite");
  expectCurrent(replacement, false, undefined, capturedAlias);
});

test.each([false, true])(
  "qualifies an initially absent sibling only while it remains absent (appeared=%s)",
  async (appeared) => {
    const root = tempDirs.make("session-store-absent-family-");
    const storePath = path.join(root, "custom.json");
    const captured = captureWrites(storePath);
    const selected = path.join(root, "custom.main.4.sqlite");
    await Promise.resolve();
    if (appeared) {
      fs.writeFileSync(selected, "later database");
      expect(() => captured.resolveIdentity(selected)).toThrow(
        "appeared after its initial inventory",
      );
    } else {
      expect(captured.resolveIdentity(selected)).toEqual({
        key: `path:${path.join(fs.realpathSync(root), "custom.main.4.sqlite")}`,
        canonicalPath: path.join(fs.realpathSync(root), "custom.main.4.sqlite"),
      });
    }
  },
);

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
    if (kind === "symlink") {
      const physical = path.join(root, "physical.db");
      fs.writeFileSync(physical, "original database");
      fs.symlinkSync(physical, selected);
    } else {
      fs.writeFileSync(selected, "original database");
    }
    const captured = captureWrites(path.join(root, "custom.json"));
    await Promise.resolve();
    fs.unlinkSync(selected);
    expect(() => captured.resolveIdentity(selected)).toThrow();
    expect(fs.existsSync(selected)).toBe(false);
  },
);
