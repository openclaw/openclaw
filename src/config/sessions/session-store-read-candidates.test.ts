import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  assertSessionStoreReadCandidate,
  isSessionStoreReadCandidateCurrent,
} from "./session-store-read-candidates.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  vi.restoreAllMocks();
});

test("keeps custody when a captured alias later resolves to the same file", () => {
  const capturedAlias = "/tmp/RUNNER~1/home/.openclaw/agents/main/agent/openclaw-agent.sqlite";
  const canonicalPath = "/tmp/runneradmin/home/.openclaw/agents/main/agent/openclaw-agent.sqlite";
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  vi.spyOn(fs, "lstatSync").mockReturnValue({
    isSymbolicLink: () => false,
  } as fs.Stats);
  vi.spyOn(fs.realpathSync, "native").mockImplementation((pathname) => {
    const value = String(pathname);
    if (value === capturedAlias) {
      return canonicalPath;
    }
    return value;
  });

  const candidate = { path: capturedAlias, physicalPath: capturedAlias };
  expect(isSessionStoreReadCandidateCurrent(candidate)).toBe(true);
  expect(assertSessionStoreReadCandidate(capturedAlias, [candidate])).toBe(canonicalPath);
});

test.runIf(process.platform !== "win32")(
  "keeps exact custody across POSIX lexical and physical directory spellings",
  () => {
    const root = tempDirs.make("session-store-posix-alias-");
    const physicalDir = path.join(root, "physical");
    const aliasDir = path.join(root, "alias");
    fs.mkdirSync(physicalDir);
    fs.symlinkSync(physicalDir, aliasDir, "junction");
    const physicalPath = path.join(physicalDir, "openclaw-agent.sqlite");
    const aliasPath = path.join(aliasDir, "openclaw-agent.sqlite");
    fs.writeFileSync(physicalPath, "");

    const candidate = { path: aliasPath, physicalPath };
    expect(isSessionStoreReadCandidateCurrent(candidate)).toBe(true);
    expect(assertSessionStoreReadCandidate(physicalPath, [candidate])).toBe(physicalPath);
  },
);

test("keeps custody when Windows preserves distinct short and long spellings for one file", () => {
  const root = tempDirs.make("session-store-windows-alias-");
  const shortPath = path.join(root, "OPENCL~1");
  const longPath = path.join(root, "openclaw-agent.sqlite");
  fs.writeFileSync(shortPath, "");
  fs.linkSync(shortPath, longPath);
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");

  const candidate = { path: shortPath, physicalPath: longPath };
  expect(isSessionStoreReadCandidateCurrent(candidate)).toBe(true);
  expect(assertSessionStoreReadCandidate(longPath, [candidate])).toBe(longPath);
});

test("rejects a same-file Windows short path outside the captured parent", () => {
  const root = tempDirs.make("session-store-windows-hardlink-");
  const shortDir = path.join(root, "RUNNER~1");
  const otherDir = path.join(root, "other");
  fs.mkdirSync(shortDir);
  fs.mkdirSync(otherDir);
  const shortPath = path.join(shortDir, "openclaw-agent.sqlite");
  const otherPath = path.join(otherDir, "openclaw-agent.sqlite");
  fs.writeFileSync(shortPath, "");
  fs.linkSync(shortPath, otherPath);
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");

  expect(() =>
    assertSessionStoreReadCandidate(otherPath, [{ path: shortPath, physicalPath: shortPath }]),
  ).toThrow(/outside captured discovery custody/);
});

test("rejects a Windows short-path candidate redirected through a symlink", () => {
  const capturedAlias = "/tmp/RUNNER~1/openclaw-agent.sqlite";
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  vi.spyOn(fs, "lstatSync").mockReturnValue({
    isSymbolicLink: () => true,
  } as fs.Stats);
  vi.spyOn(fs.realpathSync, "native").mockReturnValue("/tmp/replacement/openclaw-agent.sqlite");

  expect(
    isSessionStoreReadCandidateCurrent({
      path: capturedAlias,
      physicalPath: capturedAlias,
    }),
  ).toBe(false);
});

test("keeps sibling-family custody scoped to the captured directory", () => {
  const familyPath = "/tmp/custom/openclaw-agent.sqlite";
  vi.spyOn(fs.realpathSync, "native").mockImplementation((pathname) => {
    const value = String(pathname);
    if (value === familyPath) {
      return "/tmp/database-target/openclaw-agent.sqlite";
    }
    return value;
  });

  expect(
    isSessionStoreReadCandidateCurrent({
      path: familyPath,
      physicalPath: familyPath,
      scope: "sibling-family",
    }),
  ).toBe(true);
});

test("rejects a sibling-family candidate whose directory target changed", () => {
  const familyPath = "/tmp/custom/openclaw-agent.sqlite";
  vi.spyOn(fs.realpathSync, "native").mockImplementation((pathname) => {
    const value = String(pathname);
    if (value === "/tmp/custom") {
      return "/tmp/replacement";
    }
    return value;
  });

  expect(
    isSessionStoreReadCandidateCurrent({
      path: familyPath,
      physicalPath: familyPath,
      scope: "sibling-family",
    }),
  ).toBe(false);
});

test("rejects a candidate whose lexical target changed", () => {
  const capturedAlias = "/tmp/RUNNER~1/openclaw-agent.sqlite";
  const replacement = "/tmp/replacement/openclaw-agent.sqlite";
  vi.spyOn(fs.realpathSync, "native").mockImplementation((pathname) => {
    const value = String(pathname);
    if (value === capturedAlias) {
      return "/tmp/runneradmin/openclaw-agent.sqlite";
    }
    return value;
  });

  expect(
    isSessionStoreReadCandidateCurrent({ path: replacement, physicalPath: capturedAlias }),
  ).toBe(false);
});
