import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupCanaryArtifactsForExtensions,
  installCanaryArtifactCleanup,
  resolveCanaryArtifactPaths,
} from "../../scripts/check-extension-package-tsc-boundary.mjs";

const tempRoots = new Set<string>();

function createTempExtensionRoot(extensionId = "demo") {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-boundary-canary-"));
  tempRoots.add(rootDir);
  const extensionRoot = path.join(rootDir, "extensions", extensionId);
  fs.mkdirSync(extensionRoot, { recursive: true });
  return { rootDir, extensionRoot };
}

function writeCanaryArtifacts(rootDir: string, extensionId = "demo") {
  const { canaryPath, tsconfigPath } = resolveCanaryArtifactPaths(extensionId, rootDir);
  fs.writeFileSync(canaryPath, "export {};\n", "utf8");
  fs.writeFileSync(tsconfigPath, '{ "extends": "./tsconfig.json" }\n', "utf8");
  return { canaryPath, tsconfigPath };
}

afterEach(() => {
  for (const rootDir of tempRoots) {
    fs.rmSync(rootDir, { force: true, recursive: true });
  }
  tempRoots.clear();
});

describe("check-extension-package-tsc-boundary", () => {
  it("removes stale canary artifacts across extensions", () => {
    const { rootDir } = createTempExtensionRoot();
    const { canaryPath, tsconfigPath } = writeCanaryArtifacts(rootDir);

    cleanupCanaryArtifactsForExtensions(["demo"], rootDir);

    expect(fs.existsSync(canaryPath)).toBe(false);
    expect(fs.existsSync(tsconfigPath)).toBe(false);
  });

  it("cleans canary artifacts again on process exit", () => {
    const { rootDir } = createTempExtensionRoot();
    const { canaryPath, tsconfigPath } = writeCanaryArtifacts(rootDir);
    const processObject = new EventEmitter();
    const teardown = installCanaryArtifactCleanup(["demo"], { processObject, rootDir });

    processObject.emit("exit");
    teardown();

    expect(fs.existsSync(canaryPath)).toBe(false);
    expect(fs.existsSync(tsconfigPath)).toBe(false);
  });

  it("cleans stale artifacts for every extension id passed to the cleanup hook", () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-boundary-canary-"));
    tempRoots.add(rootDir);
    fs.mkdirSync(path.join(rootDir, "extensions", "demo-a"), { recursive: true });
    fs.mkdirSync(path.join(rootDir, "extensions", "demo-b"), { recursive: true });
    const demoA = writeCanaryArtifacts(rootDir, "demo-a");
    const demoB = writeCanaryArtifacts(rootDir, "demo-b");
    const processObject = new EventEmitter();
    const teardown = installCanaryArtifactCleanup(["demo-a", "demo-b"], {
      processObject,
      rootDir,
    });

    processObject.emit("exit");
    teardown();

    expect(fs.existsSync(demoA.canaryPath)).toBe(false);
    expect(fs.existsSync(demoA.tsconfigPath)).toBe(false);
    expect(fs.existsSync(demoB.canaryPath)).toBe(false);
    expect(fs.existsSync(demoB.tsconfigPath)).toBe(false);
  });
});
