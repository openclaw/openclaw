import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readdirSync, readFileSync, symlinkSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { requireNodeTool } from "../helpers/node-toolchain.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const describePosix = process.platform === "win32" ? describe.skip : describe;

// Exercise the embedded bootstrap without installing packages or adding a test-only entrypoint.
function sweep(cache: string, current = "") {
  const wrapper = readFileSync("scripts/pr", "utf8");
  const source = wrapper.split("<<'EOF_TOOLING'\n")[1]?.split("\nEOF_TOOLING")[0];
  if (!source?.includes("materializeDependencies(...process.argv.slice(2));")) {
    throw new Error("Missing dependency bootstrap entrypoint");
  }
  const result = spawnSync(requireNodeTool("node"), ["--input-type=module", "-", cache, current], {
    input: source.replace(
      "materializeDependencies(...process.argv.slice(2));",
      "sweep(...process.argv.slice(2));",
    ),
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
}

function entry(cache: string, name: string, ageHours: number, complete = true) {
  const path = join(cache, name);
  mkdirSync(path, { mode: 0o700 });
  if (complete) {
    mkdirSync(join(path, ".pr-complete"));
  }
  const modified = new Date(Date.now() - ageHours * 3_600_000);
  utimesSync(path, modified, modified);
  return path;
}

describePosix("frozen PR dependency cache sweep", () => {
  it("keeps the four newest unused installations, live consumers, and the current entry", () => {
    const cache = tempDirs.make("pr-dependency-cache-");
    // Deliberately reverse name/recency order; unused entries are younger than the old TTL.
    const names = Array.from({ length: 12 }, (_, index) => index.toString(16).padStart(64, "0"));
    for (const [index, name] of names.entries()) {
      entry(cache, name, (12 - index) / 4);
    }
    const current = join(cache, names[0]!);
    const live = join(cache, names[1]!);
    mkdirSync(join(live, ".pr-users", String(process.pid)), { recursive: true });
    mkdirSync(join(cache, names[2]!, ".pr-users", "2147483647"), { recursive: true });
    // Consumer bookkeeping must not accidentally change the fixture's recency.
    for (const name of names.slice(0, 3)) {
      utimesSync(join(cache, name), new Date(0), new Date(0));
    }

    sweep(cache, current);

    expect(readdirSync(cache).toSorted((a, b) => a.localeCompare(b))).toEqual(
      [...names.slice(0, 2), ...names.slice(-4)].toSorted((a, b) => a.localeCompare(b)),
    );
  });

  it("retires stale dead stages while preserving recent, live, and unsafe entries", () => {
    const cache = tempDirs.make("pr-dependency-stages-");
    entry(cache, "install-2147483647-dead", 25, false);
    entry(cache, "install-2147483647-recent", 1, false);
    entry(cache, `install-${process.pid}-live`, 25, false);
    const unsafe = entry(cache, "a".repeat(64), 25);
    chmodSync(unsafe, 0o755);
    entry(cache, "not-a-cache-entry", 25);
    const target = tempDirs.make("pr-dependency-symlink-");
    symlinkSync(target, join(cache, "b".repeat(64)));

    sweep(cache);

    expect(readdirSync(cache).toSorted((a, b) => a.localeCompare(b))).toEqual(
      [
        "a".repeat(64),
        "b".repeat(64),
        `install-${process.pid}-live`,
        "install-2147483647-recent",
        "not-a-cache-entry",
      ].toSorted((a, b) => a.localeCompare(b)),
    );
    expect(readdirSync(target)).toEqual([]);
  });
});
