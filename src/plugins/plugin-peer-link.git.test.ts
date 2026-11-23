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

const layouts = [
  "owned",
  "shared prefix named profile",
  "legacy release slot",
  "unselected host",
  "different record",
  "local package copy",
  "other host link",
  "replaced during preparation",
] as const;

function gitPeerFixture(layout: (typeof layouts)[number] = "owned") {
  const home = fs.realpathSync(makeTempDir());
  const namedProfile = layout === "shared prefix named profile";
  const stateDir = path.join(home, namedProfile ? ".openclaw-work" : ".openclaw");
  const prefix = path.join(home, ".openclaw", "git-install");
  const packagePath =
    layout === "legacy release slot" ? path.join("lib", "node_modules", "openclaw") : "openclaw";
  const hostA = path.join(prefix, "releases", "host-a", packagePath);
  const hostB = path.join(prefix, "releases", "host-b", packagePath);
  for (const host of [hostA, hostB]) {
    writePackage(host, { name: "openclaw" });
  }
  const slot = path.join(prefix, packagePath);
  fs.mkdirSync(path.dirname(slot), { recursive: true });
  fs.symlinkSync(layout === "unselected host" ? hostA : hostB, slot, "junction");
  const gitUrl = "https://github.com/acme/peer-plugin.git";
  const gitCommit = "a".repeat(40);
  const spec = `git:${gitUrl}@${gitCommit}`;
  const digest = createHash("sha256").update(spec).digest("hex").slice(0, 16);
  const packageDir = path.join(stateDir, "git", `git-${digest}`, "repo");
  writePackage(packageDir, { name: "peer-plugin", peerDependencies: { openclaw: "*" } });
  fs.mkdirSync(path.join(packageDir, ".git"));
  fs.writeFileSync(path.join(packageDir, ".git", "HEAD"), `${gitCommit}\n`);
  const link = path.join(packageDir, "node_modules", "openclaw");
  let previous = hostA;
  if (layout === "other host link") {
    const otherPrefix = path.join(home, ".openclaw-other", "git-install");
    previous = path.join(otherPrefix, "releases", "host-a", "openclaw");
    writePackage(previous, { name: "openclaw" });
    fs.symlinkSync(previous, path.join(otherPrefix, "openclaw"), "junction");
  }
  if (layout === "local package copy") {
    writePackage(link, { name: "openclaw", version: "1.0.0" });
  } else {
    fs.mkdirSync(path.dirname(link));
    fs.symlinkSync(previous, link, "junction");
  }

  vi.stubGlobal("__openclawStandaloneRootUrl", new URL(`file://${hostB}/`).href);
  const options = {
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
      ...(namedProfile ? { OPENCLAW_PROFILE: "work" } : {}),
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
    },
    logger: {},
  } satisfies Parameters<typeof repairInstalledOpenClawHostLinks>[0];
  return { options, link, hostB, previous };
}

describe("registered Git plugin host links", () => {
  it.each(layouts)("rebinds only the recorded checkout's old release link (%s)", async (layout) => {
    const { options, link, hostB, previous } = gitPeerFixture(layout);
    const shouldRepair =
      layout === "owned" ||
      layout === "shared prefix named profile" ||
      layout === "legacy release slot";
    const result = await repairInstalledOpenClawHostLinks({
      ...options,
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
      registeredRepaired: shouldRepair ? 1 : 0,
    });
    if (layout === "local package copy" || layout === "replaced during preparation") {
      expect(fs.lstatSync(link).isDirectory()).toBe(true);
      expect(fs.readFileSync(path.join(link, "package.json"), "utf8")).toContain(
        '"version":"1.0.0"',
      );
    } else {
      expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
      expect(fs.realpathSync(link)).toBe(shouldRepair ? hostB : previous);
    }
  });

  it.each([false, true])(
    "recovers after interrupted publication while preserving an intervening package (intervening=%s)",
    async (intervening) => {
      const { options, link, hostB } = gitPeerFixture();
      const refusal = new Error("host link publication authority revoked");
      const logger = { info: vi.fn(), warn: vi.fn() };

      let effects = 0;
      await expect(
        repairInstalledOpenClawHostLinks({
          ...options,
          logger,
          beforePersistentEffect: async () => {
            if (++effects === 2) {
              await expect(fs.promises.lstat(link)).rejects.toMatchObject({ code: "ENOENT" });
              throw refusal;
            }
          },
        }),
      ).rejects.toBe(refusal);
      expect(effects).toBe(2);
      expect(logger.info).not.toHaveBeenCalled();
      expect(logger.warn).not.toHaveBeenCalled();

      const result = await repairInstalledOpenClawHostLinks({
        ...options,
        logger,
        beforePersistentEffect: intervening
          ? () => writePackage(link, { name: "openclaw", version: "2.0.0" })
          : undefined,
      });

      expect(result.registeredRepaired).toBe(intervening ? 0 : 1);
      if (intervening) {
        expect(fs.lstatSync(link).isDirectory()).toBe(true);
        expect(JSON.parse(fs.readFileSync(path.join(link, "package.json"), "utf8"))).toEqual({
          name: "openclaw",
          version: "2.0.0",
        });
        expect(logger.info).not.toHaveBeenCalled();
      } else {
        expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
        expect(fs.realpathSync(link)).toBe(hostB);
        expect(logger.info).toHaveBeenCalledOnce();
      }
    },
  );
});
