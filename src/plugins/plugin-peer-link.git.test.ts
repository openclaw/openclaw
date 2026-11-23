import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { repairInstalledOpenClawHostLinks } from "./plugin-peer-link.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

const tempDirs: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  cleanupTrackedTempDirs(tempDirs);
});

function makeTempDir() {
  return makeTrackedTempDir("openclaw-plugin-peer-link-git", tempDirs);
}

function writePackage(packageDir: string, manifest: Record<string, unknown>) {
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify(manifest));
}

describe("registered Git plugin host links", () => {
  it.each([
    "owned",
    "different record",
    "local package copy",
    "other host link",
    "replaced during preparation",
  ] as const)("rebinds only the recorded checkout's old release link (%s)", async (layout) => {
    const home = fs.realpathSync(makeTempDir());
    const stateDir = path.join(home, ".openclaw");
    const prefix = path.join(stateDir, "git-install");
    const hostA = path.join(prefix, "releases", "host-a", "openclaw");
    const hostB = path.join(prefix, "releases", "host-b", "openclaw");
    const otherHost = path.join(home, "other-host");
    for (const host of [hostA, hostB, otherHost]) {
      writePackage(host, { name: "openclaw" });
    }
    const gitUrl = "https://github.com/acme/peer-plugin.git";
    const gitCommit = "a".repeat(40);
    const spec = `git:${gitUrl}@${gitCommit}`;
    const digest = createHash("sha256").update(spec).digest("hex").slice(0, 16);
    const packageDir = path.join(stateDir, "git", `git-${digest}`, "repo");
    writePackage(packageDir, { name: "peer-plugin", peerDependencies: { openclaw: "*" } });
    fs.mkdirSync(path.join(packageDir, ".git"));
    fs.writeFileSync(path.join(packageDir, ".git", "HEAD"), `${gitCommit}\n`);
    const link = path.join(packageDir, "node_modules", "openclaw");
    const previous = layout === "other host link" ? otherHost : hostA;
    if (layout === "local package copy") {
      writePackage(link, { name: "openclaw", version: "1.0.0" });
    } else {
      fs.mkdirSync(path.dirname(link));
      fs.symlinkSync(previous, link, "junction");
    }

    vi.stubGlobal("__openclawStandaloneRootUrl", new URL(`file://${hostB}/`).href);
    const result = await repairInstalledOpenClawHostLinks({
      extensionsDir: path.join(stateDir, "extensions"),
      managedNpmRoots: [],
      installRecords: {
        "peer-plugin": {
          source: "git",
          ...(layout === "different record"
            ? { gitUrl: `${gitUrl}-other`, spec: `git:${gitUrl}-other@${gitCommit}` }
            : { gitUrl, spec }),
          gitRef: gitCommit,
          gitCommit,
          installPath: packageDir,
        },
      },
      stateDir,
      env: {
        HOME: home,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
      },
      logger: {},
      beforePersistentEffect:
        layout === "replaced during preparation"
          ? () => {
              fs.unlinkSync(link);
              writePackage(link, { name: "openclaw", version: "1.0.0" });
            }
          : undefined,
    });

    expect(result).toEqual({
      managedRepaired: 0,
      registeredRepaired: layout === "owned" ? 1 : 0,
    });
    if (layout === "local package copy" || layout === "replaced during preparation") {
      expect(fs.lstatSync(link).isDirectory()).toBe(true);
      expect(fs.readFileSync(path.join(link, "package.json"), "utf8")).toContain(
        '"version":"1.0.0"',
      );
    } else {
      expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
      expect(fs.realpathSync(link)).toBe(layout === "owned" ? hostB : previous);
    }
  });
});
