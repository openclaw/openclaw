import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("keeps large tracked inventories on the Git path instead of scanning generated files", () => {
  const root = tempDirs.make("openclaw-tracked-test-inventory-");
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], {
    cwd: root,
    input: "inventory fixture\n",
    encoding: "utf8",
  }).trim();
  // An index-only fixture exercises real Git output without creating thousands of files.
  const files = Array.from(
    { length: 6_000 },
    (_, index) =>
      `fixtures/${"long-path-".repeat(18)}/case-${String(index).padStart(6, "0")}.test.ts`,
  );
  expect(Buffer.byteLength(files.join("\n"))).toBeGreaterThan(1024 * 1024);
  execFileSync("git", ["update-index", "--index-info"], {
    cwd: root,
    input: files.map((file) => `100644 ${blob}\t${file}\n`).join(""),
  });
  const moduleUrl = pathToFileURL(path.resolve("scripts/lib/list-test-files.mts")).href;
  // Native cwd belongs to this child; the Vitest worker's shared cwd stays unchanged.
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import { createHash } from "node:crypto";
import { listTrackedTestFiles } from ${JSON.stringify(moduleUrl)};
const files = listTrackedTestFiles(".");
console.log(JSON.stringify({count: files.length, digest: createHash("sha256").update(JSON.stringify(files)).digest("hex")}));`,
    ],
    { cwd: root, encoding: "utf8" },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    count: files.length,
    digest: createHash("sha256").update(JSON.stringify(files)).digest("hex"),
  });
});
