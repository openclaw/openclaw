import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  runCliProcessChild,
  waitForCliProcessStderrMarker,
} from "../../src/cli/cli-process-child.test-helpers.js";
import { readPackageReleaseLeases } from "../../src/infra/package-release-lease.js";
import { collectPackageReleases } from "../../src/infra/package-release-retention.js";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { stageLauncherFixture } from "../helpers/openclaw-launcher-fixture.js";
import { createTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = createTempDirTracker();
const prefix = tempDirs.make("openclaw-cli-lease-");
const oldId = "git-old-00000001";
const root = path.join(prefix, "releases", oldId, "openclaw");
const next = path.join(prefix, "releases", "new", "openclaw");
const slot = path.join(prefix, "openclaw");
const config = path.join(prefix, "openclaw.json");
const run = (nodeArgs: string[], interact?: Parameters<typeof runCliProcessChild>[0]["interact"]) =>
  runCliProcessChild({
    nodeExecutable: resolveTestNodeExecPath(),
    nodeArgs,
    interact,
    cwd: prefix,
    env: {
      PATH: process.env.PATH,
      HOME: prefix,
      USERPROFILE: prefix,
      OPENCLAW_HOME: prefix,
      OPENCLAW_STATE_DIR: path.join(prefix, "state"),
      OPENCLAW_CONFIG_PATH: config,
      OPENCLAW_NO_RESPAWN: "1",
      NODE_DISABLE_COMPILE_CACHE: "1",
    },
  });

beforeAll(async () => {
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(next, { recursive: true });
  await fs.symlink(root, slot, "junction");
  await fs.writeFile(config, "{}", { mode: 0o600 });
  await stageLauncherFixture(root);
  await fs.copyFile("package.json", path.join(root, "package.json"));
  await fs.cp("dist", path.join(root, "dist"), {
    recursive: true,
    mode: constants.COPYFILE_FICLONE,
    verbatimSymlinks: true,
  });
  for (const name of ["node_modules", "dist-runtime", "extensions", "packages"]) {
    await fs.symlink(path.resolve(name), path.join(root, name), "junction");
  }
});
afterAll(() => tempDirs.cleanup());

it("keeps commands using either CLI entry or the native host alive across deselection", async () => {
  const origin = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/";
  const marker = "reading fixture input";
  const probe =
    'process.stdin.on("newListener", event => { if (event === "readable" || event === "data") console.error("reading fixture input"); });';
  const configArgs = ["config", "patch", "--stdin", "--dry-run", "--json"];
  for (const [entry, args] of [
    ["dist/entry.js", configArgs],
    ["dist/index.js", configArgs],
    [
      "openclaw.mjs",
      [
        "browser",
        "extension",
        "native-host",
        "--manifest",
        "manifest",
        "--launcher",
        "launcher",
        "--expected-origin",
        origin,
        origin,
      ],
    ],
  ] as const) {
    const result = await run(
      [
        "--import",
        "data:text/javascript," + encodeURIComponent(probe),
        path.join(slot, entry),
        ...args,
      ],
      async (child) => {
        await waitForCliProcessStderrMarker(child, marker);
        await fs.unlink(slot);
        await fs.symlink(next, slot, "junction");
        expect(readPackageReleaseLeases(prefix, oldId).live).toBe(1);
        // A fresh trial no longer supplies a blanket age grace. Only a live holder protects old.
        const unused = path.join(prefix, "releases", "git-unused-00000002");
        await fs.mkdir(path.join(unused, "openclaw"), { recursive: true });
        await fs.copyFile(
          path.join(root, "package.json"),
          path.join(unused, "openclaw/package.json"),
        );
        expect(
          await collectPackageReleases({
            prefix,
            slot,
            resident: { knownTrial: true },
            readOpenRuns: async () => [],
          }),
        ).toEqual({ removed: [unused], warnings: [] });
        if (entry === "dist/index.js") {
          child.kill("SIGKILL");
        } else {
          child.stdin.end(entry === "openclaw.mjs" ? undefined : '{"gateway":{"mode":"local"}}');
        }
      },
    );
    const leases = readPackageReleaseLeases(prefix, oldId);
    expect(leases.live).toBe(0);
    if (entry === "dist/index.js") {
      expect(leases.stale).toHaveLength(1);
      await fs.unlink(leases.stale[0]!);
    } else {
      expect(result.code, result.stderr).toBe(0);
      expect(leases.stale).toEqual([]);
      if (entry === "openclaw.mjs") {
        expect(JSON.parse(result.stdout.slice(4))).toMatchObject({ ok: false });
      } else {
        expect(JSON.parse(result.stdout)).toMatchObject({ ok: true });
      }
    }
    await fs.unlink(slot);
    await fs.symlink(root, slot, "junction");
  }
});

it("prints the local version without write access but refuses an unprotected command before dispatch", async () => {
  const entry = path.join(slot, "dist", "entry.js");
  const readOnly = ["--permission", "--allow-fs-read=*", "--allow-addons", "--allow-worker"];
  const version = await run([...readOnly, entry, "--version"]);
  expect(version.code, version.stderr).toBe(0);
  expect(version.stdout).toMatch(/^OpenClaw /u);
  const denied = await run([...readOnly, entry, "config", "patch", "--stdin"]);
  expect(denied.code).not.toBe(0);
  expect(denied.stderr).toContain("Run this command as the installation owner");
  expect(await fs.readFile(config, "utf8")).toBe("{}");
});
