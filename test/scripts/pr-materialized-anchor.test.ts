import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { requireNodeTool } from "../helpers/node-toolchain.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { copyPrRoutingWrapperSources } from "./pr-wrapper.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const describePosix = process.platform === "win32" ? describe.skip : describe;
const helper = resolve("scripts/pr-lib/materialized-anchor.mjs");

function retire(path: string) {
  const fd = openSync(path, "r");
  try {
    return spawnSync(process.execPath, [helper, "retire-created", path], {
      encoding: "utf8",
      env: { ...process.env, HOME: path },
      stdio: [
        "ignore",
        "pipe",
        "pipe",
        "ignore",
        "ignore",
        "ignore",
        "ignore",
        "ignore",
        "ignore",
        fd,
      ],
    });
  } finally {
    closeSync(fd);
  }
}

function anchorFixture() {
  const root = realpathSync(tempDirs.make("pr-anchor-owner-"));
  const anchor = join(root, "openclaw-pr-anchor-v3.owned");
  const unrelated = join(root, "openclaw-pr-anchor.unrelated");
  mkdirSync(anchor, { mode: 0o700 });
  mkdirSync(unrelated, { mode: 0o700 });
  copyPrRoutingWrapperSources(anchor);
  writeFileSync(join(unrelated, "sentinel"), "retained\n");
  mkdirSync(join(anchor, "node_modules"), { mode: 0o700 });
  symlinkSync(unrelated, join(anchor, "node_modules/unrelated"), "dir");
  return { root, anchor, unrelated };
}

function retireClaimedAnchor(fixture: ReturnType<typeof anchorFixture>, fault = "none") {
  const descriptor = openSync(
    fault === "different held directory" ? fixture.unrelated : fixture.anchor,
    "r",
  );
  try {
    const alias = join(fixture.root, "openclaw-pr-anchor-v3.alias");
    if (fault === "symlinked path") {
      symlinkSync(fixture.anchor, alias, "dir");
    }
    // Give only this child a real FD9; the test worker's descriptor table stays intact.
    return spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        String.raw`
import { chmodSync, closeSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const [anchor, scriptRoot, fault] = process.argv.slice(1);
const { claimMaterializedAnchor, retireMaterializedAnchor } =
  await import(pathToFileURL(join(anchor, "scripts/pr-lib/materialized-anchor.mjs")).href);
process.env.OPENCLAW_PR_ANCHOR_CREATOR_PID =
  String(fault === "wrong creator" ? process.pid + 1 : process.pid);
process.env.OPENCLAW_PR_ANCHOR_FD = fault === "wrong descriptor declaration" ? "8" : "9";
if (fault === "missing descriptor") closeSync(9);
const claimed = claimMaterializedAnchor(join(scriptRoot, "scripts/pr"));
if (fault === "closed descriptor after claim") closeSync(9);
if (fault === "changed mode") chmodSync(anchor, 0o755);
if (fault === "replaced path") {
  renameSync(anchor, anchor + ".retained");
  mkdirSync(anchor, { mode: 0o700 });
  writeFileSync(join(anchor, "replacement"), "retained replacement\n");
}
retireMaterializedAnchor(claimed);
console.log(JSON.stringify({ claimed: Boolean(claimed) }));
`,
        fixture.anchor,
        fault === "symlinked path" ? alias : fixture.anchor,
        fault,
      ],
      {
        encoding: "utf8",
        env: { ...process.env, HOME: fixture.root, TMPDIR: fixture.root },
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
        stdio: [
          "ignore",
          "pipe",
          "pipe",
          "ignore",
          "ignore",
          "ignore",
          "ignore",
          "ignore",
          "ignore",
          descriptor,
        ],
      },
    );
  } finally {
    closeSync(descriptor);
  }
}

describePosix("materialized PR anchor retirement", () => {
  it("retires the Git snapshot when supervisor startup fails before any operation child", () => {
    const root = tempDirs.make("pr-startup-retirement-");
    const anchor = join(root, "openclaw-pr-anchor-v3.startup");
    mkdirSync(anchor, { mode: 0o700 });
    copyPrRoutingWrapperSources(anchor);
    expect(existsSync(join(anchor, "src"))).toBe(false);
    const childStarted = join(root, "child-started");
    writeFileSync(join(anchor, "scripts/pr"), `#!/bin/sh\ntouch '${childStarted}'\n`);
    // Fail after the snapshot is created but before spawning the operation.
    rmSync(join(anchor, "scripts/pr-lib/github.sh"));
    const result = spawnSync(
      "/bin/bash",
      [
        "-c",
        'exec 9< "$1"; export OPENCLAW_PR_ANCHOR_CREATOR_PID=$$ OPENCLAW_PR_ANCHOR_FD=9; exec "$2" "$1/scripts/pr-lib/process-group-runner.mjs" "$3" "$1/scripts/pr"',
        "startup-fixture",
        anchor,
        requireNodeTool("node"),
        root,
      ],
      { encoding: "utf8", env: { ...process.env, HOME: root, TMPDIR: root } },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("github.sh");
    expect(existsSync(childStarted)).toBe(false);
    expect(existsSync(anchor)).toBe(false);
    expect(
      readdirSync(root).filter((name) => name.startsWith("openclaw-pr-lock-release-")),
    ).toEqual([]);
  });

  it("retires a newly created anchor before helper extraction or child startup", () => {
    const root = tempDirs.make("pr-anchor-retirement-");
    const anchor = join(root, `openclaw-pr-anchor-v3.${process.pid}.created`);
    mkdirSync(anchor, { mode: 0o700 });
    const result = retire(anchor);
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(anchor)).toBe(false);
  });

  it.each([
    "openclaw-pr-anchor.legacy",
    "openclaw-pr-anchor.2147483647.dead",
    "openclaw-pr-anchor-v3.2147483647.foreign",
  ])("does not adopt or sweep %s", (name) => {
    const root = tempDirs.make("pr-anchor-legacy-");
    const path = join(root, name);
    mkdirSync(path, { mode: 0o700 });
    const result = retire(path);
    expect(existsSync(path)).toBe(true);
    expect(result.stderr).toContain("creation evidence differs");
  });
});

describePosix("materialized PR anchor ownership", () => {
  it("retires only the claimed anchor without following external dependency symlinks", () => {
    const fixture = anchorFixture();
    const unrelated = lstatSync(fixture.unrelated);
    const result = retireClaimedAnchor(fixture);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ claimed: true });
    expect(existsSync(fixture.anchor)).toBe(false);
    expect(lstatSync(fixture.unrelated).ino).toBe(unrelated.ino);
    expect(readFileSync(join(fixture.unrelated, "sentinel"), "utf8")).toBe("retained\n");
  });

  it.each([
    { fault: "missing descriptor", claimed: false },
    { fault: "wrong creator", claimed: false },
    { fault: "wrong descriptor declaration", claimed: false },
    { fault: "different held directory", claimed: false },
    { fault: "symlinked path", claimed: false },
    { fault: "closed descriptor after claim", claimed: true },
    { fault: "changed mode", claimed: true },
    { fault: "replaced path", claimed: true },
  ])("retains anchor custody after $fault", ({ fault, claimed }) => {
    const fixture = anchorFixture();
    const before = lstatSync(fixture.anchor);
    const unrelated = lstatSync(fixture.unrelated);
    const result = retireClaimedAnchor(fixture, fault);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ claimed });
    expect(existsSync(fixture.anchor)).toBe(true);
    if (fault === "replaced path") {
      expect(lstatSync(fixture.anchor + ".retained").ino).toBe(before.ino);
      expect(readFileSync(join(fixture.anchor, "replacement"), "utf8")).toBe(
        "retained replacement\n",
      );
    } else {
      expect(lstatSync(fixture.anchor).ino).toBe(before.ino);
    }
    expect(lstatSync(fixture.unrelated).ino).toBe(unrelated.ino);
    expect(readFileSync(join(fixture.unrelated, "sentinel"), "utf8")).toBe("retained\n");
  });
});
