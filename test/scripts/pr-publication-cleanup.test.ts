import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createMainRefreshFixture } from "./pr-main-refresh.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const describePosix = process.platform === "win32" ? describe.skip : describe;
describePosix("native publication verification cleanup", () => {
  it("only removes the merged verification branch without force", () => {
    const f = createMainRefreshFixture(tempDirs.make("pr-publication-cleanup-"));
    const shim = join(f.root, "bin", "git");
    const record = join(f.root, "verification-deletes.log");
    // Block force even on the regression side; the test must never force-delete a ref.
    writeFileSync(
      shim,
      `#!/bin/sh
if [ "$1" = branch ] && [ "$3" = pr-42-verify ]; then
  printf '%s\\n' "$2" >> "${record}"
  if [ "$2" != -d ]; then exit 86; fi
fi
${readFileSync(shim, "utf8")}`,
    );
    const prepared = f.run("prepare-run");
    expect(prepared.status, prepared.stdout + prepared.stderr).toBe(0);
    const synced = f.run("prepare-sync-head");
    expect(synced.status, synced.stdout + synced.stderr).toBe(0);
    const modes = readFileSync(record, "utf8").trim().split("\n");
    expect(modes.length).toBeGreaterThan(0);
    expect(
      modes.every((mode) => mode === "-d"),
      modes.join(","),
    ).toBe(true);
    expect(
      f.git(f.worktree, "for-each-ref", "--format=%(refname)", "refs/heads/pr-42-verify"),
    ).toBe("");
    expect(f.git(f.origin, "rev-parse", "refs/heads/topic")).toBe(f.head);
    expect(f.git(f.worktree, "rev-parse", "HEAD")).toBe(f.head);
    expect(f.events().filter((event) => event.kind === "unexpected-push")).toEqual([]);
  });
});
