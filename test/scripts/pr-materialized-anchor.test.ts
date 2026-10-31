import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  realpathSync,
  rmSync,
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

describePosix("materialized PR anchor retirement", () => {
  it("retires the Git snapshot when supervisor startup fails before any operation child", () => {
    const root = realpathSync(tempDirs.make("pr-startup-retirement-"));
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
    const root = realpathSync(tempDirs.make("pr-anchor-retirement-"));
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
    const root = realpathSync(tempDirs.make("pr-anchor-legacy-"));
    const path = join(root, name);
    mkdirSync(path, { mode: 0o700 });
    const result = retire(path);
    expect(existsSync(path)).toBe(true);
    expect(result.stderr).toContain("creation evidence differs");
  });
});
