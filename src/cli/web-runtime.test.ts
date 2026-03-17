import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  classifyWebPortListener,
  cleanupManagedWebRuntimeBackup,
  evaluateMajorVersionTransition,
  evaluateWebProfilesPayload,
  installManagedWebRuntime,
  readLastLogLines,
  rollbackManagedWebRuntime,
} from "./web-runtime.js";

describe("evaluateWebProfilesPayload", () => {
  it("accepts nullable active profile when profiles payload shape is valid (prevents first-run false negatives)", () => {
    const result = evaluateWebProfilesPayload({
      profiles: [],
      activeProfile: null,
    });
    expect(result.ok).toBe(true);
  });

  it("accepts workspace compatibility fields when profile aliases are missing (preserves API compatibility)", () => {
    const result = evaluateWebProfilesPayload({
      workspaces: [{ name: "default" }],
      activeWorkspace: "default",
    });
    expect(result.ok).toBe(true);
  });

  it("rejects payloads that omit active profile/workspace state (guards readiness contract)", () => {
    const result = evaluateWebProfilesPayload({
      profiles: [],
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("active profile/workspace");
  });
});

describe("classifyWebPortListener", () => {
  it("classifies listeners under managed runtime dir as managed ownership (prevents cross-process kills)", () => {
    const managedRuntimeAppDir = "/Users/test/.openclaw-dench/web-runtime/app";
    const ownership = classifyWebPortListener({
      cwd: "/Users/test/.openclaw-dench/web-runtime/app",
      managedRuntimeAppDir,
    });
    expect(ownership).toBe("managed");
  });

  it("classifies legacy standalone cwd as dench-owned legacy runtime (supports old bootstrap cleanup)", () => {
    const ownership = classifyWebPortListener({
      cwd: "/Users/test/projects/ironclaw/apps/web/.next/standalone/apps/web",
      managedRuntimeAppDir: "/Users/test/.openclaw-dench/web-runtime/app",
    });
    expect(ownership).toBe("legacy-standalone");
  });

  it("classifies unknown cwd as foreign ownership (enforces process boundary safety)", () => {
    const ownership = classifyWebPortListener({
      cwd: "/Applications/OtherApp/runtime",
      managedRuntimeAppDir: "/Users/test/.openclaw-dench/web-runtime/app",
    });
    expect(ownership).toBe("foreign");
  });
});

describe("evaluateMajorVersionTransition", () => {
  it("detects major changes across semver values (enforces mandatory upgrade gate)", () => {
    const result = evaluateMajorVersionTransition({
      previousVersion: "2.9.0",
      currentVersion: "3.0.1",
    });
    expect(result.isMajorTransition).toBe(true);
    expect(result.previousMajor).toBe(2);
    expect(result.currentMajor).toBe(3);
  });

  it("treats prerelease-to-minor within same major as non-major transition (avoids unnecessary blocking)", () => {
    const result = evaluateMajorVersionTransition({
      previousVersion: "2.0.0-1",
      currentVersion: "2.1.0",
    });
    expect(result.isMajorTransition).toBe(false);
    expect(result.previousMajor).toBe(2);
    expect(result.currentMajor).toBe(2);
  });
});

describe("installManagedWebRuntime backup", () => {
  let tmpDir: string;
  let stateDir: string;
  let packageRoot: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "web-runtime-test-"));
    stateDir = path.join(tmpDir, "state");
    packageRoot = path.join(tmpDir, "pkg");

    const standaloneAppDir = path.join(packageRoot, "apps", "web", ".next", "standalone", "apps", "web");
    mkdirSync(standaloneAppDir, { recursive: true });
    writeFileSync(path.join(standaloneAppDir, "server.js"), "module.exports = {};", "utf-8");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("backs up existing app dir before replacing (enables rollback on crash)", () => {
    const runtimeAppDir = path.join(stateDir, "web-runtime", "app");
    mkdirSync(runtimeAppDir, { recursive: true });
    writeFileSync(path.join(runtimeAppDir, "old-marker.txt"), "old", "utf-8");

    installManagedWebRuntime({
      stateDir,
      packageRoot,
      denchVersion: "2.0.0",
    });

    const backupDir = path.join(stateDir, "web-runtime", "app.prev");
    expect(existsSync(backupDir)).toBe(true);
    expect(existsSync(path.join(backupDir, "old-marker.txt"))).toBe(true);
    expect(existsSync(path.join(runtimeAppDir, "server.js"))).toBe(true);
  });

  it("installs without error when no previous app dir exists", () => {
    const result = installManagedWebRuntime({
      stateDir,
      packageRoot,
      denchVersion: "2.0.0",
    });

    expect(result.installed).toBe(true);
    const backupDir = path.join(stateDir, "web-runtime", "app.prev");
    expect(existsSync(backupDir)).toBe(false);
  });
});

describe("rollbackManagedWebRuntime", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "web-runtime-rollback-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("restores backup dir to app dir (recovers from broken update)", () => {
    const runtimeDir = path.join(tmpDir, "web-runtime");
    const appDir = path.join(runtimeDir, "app");
    const backupDir = path.join(runtimeDir, "app.prev");

    mkdirSync(appDir, { recursive: true });
    writeFileSync(path.join(appDir, "broken.js"), "crash", "utf-8");
    mkdirSync(backupDir, { recursive: true });
    writeFileSync(path.join(backupDir, "server.js"), "working", "utf-8");

    const result = rollbackManagedWebRuntime(tmpDir);

    expect(result).toBe(true);
    expect(existsSync(path.join(appDir, "server.js"))).toBe(true);
    expect(existsSync(backupDir)).toBe(false);
  });

  it("returns false when no backup exists", () => {
    expect(rollbackManagedWebRuntime(tmpDir)).toBe(false);
  });
});

describe("cleanupManagedWebRuntimeBackup", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "web-runtime-cleanup-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("removes backup dir after successful probe", () => {
    const backupDir = path.join(tmpDir, "web-runtime", "app.prev");
    mkdirSync(backupDir, { recursive: true });
    writeFileSync(path.join(backupDir, "old.js"), "old", "utf-8");

    cleanupManagedWebRuntimeBackup(tmpDir);
    expect(existsSync(backupDir)).toBe(false);
  });

  it("does not throw when backup dir is absent", () => {
    expect(() => cleanupManagedWebRuntimeBackup(tmpDir)).not.toThrow();
  });
});

describe("readLastLogLines", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "web-runtime-logs-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reads the last N lines from a log file (provides crash diagnostics)", () => {
    const logsDir = path.join(tmpDir, "logs");
    mkdirSync(logsDir, { recursive: true });
    writeFileSync(
      path.join(logsDir, "web-app.err.log"),
      "line1\nline2\nline3\nline4\nline5\n",
      "utf-8",
    );

    const result = readLastLogLines(tmpDir, "web-app.err.log", 3);
    expect(result).toBe("line3\nline4\nline5");
  });

  it("returns undefined when log file is missing", () => {
    expect(readLastLogLines(tmpDir, "web-app.err.log")).toBeUndefined();
  });

  it("returns undefined when log file is empty", () => {
    const logsDir = path.join(tmpDir, "logs");
    mkdirSync(logsDir, { recursive: true });
    writeFileSync(path.join(logsDir, "web-app.err.log"), "", "utf-8");

    expect(readLastLogLines(tmpDir, "web-app.err.log")).toBeUndefined();
  });
});
