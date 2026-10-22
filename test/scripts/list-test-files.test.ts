import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { spawnNodeEvalSync } from "../../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("keeps large tracked test inventories instead of scanning generated files", () => {
  const cwd = tempDirs.make("tracked-test-inventory-");
  const git = (args: string[], input?: string) =>
    execFileSync("git", args, { cwd, encoding: "utf8", input });
  git(["init", "--quiet"]);
  const blob = git(["hash-object", "-w", "--stdin"], "").trim();
  // Index-only entries cross the subprocess buffer boundary without creating thousands of files.
  const tracked = Array.from(
    { length: 6_000 },
    (_, index) => `src/${String(index).padStart(4, "0")}-${"a".repeat(210)}.test.ts`,
  );
  git(
    ["update-index", "--index-info"],
    tracked.map((file) => `100644 ${blob}\t${file}\n`).join(""),
  );
  writeFileSync(path.join(cwd, "untracked-generated.test.ts"), "");
  const owner = new URL("../../scripts/lib/list-test-files.mts", import.meta.url).href;
  const result = spawnNodeEvalSync(
    `import { createHash } from 'node:crypto';
     import { listTrackedTestFiles } from ${JSON.stringify(owner)};
     const files = listTrackedTestFiles('.');
     console.log(JSON.stringify({
       count: files.length,
       digest: createHash('sha256').update(files.join('\\n')).digest('hex'),
     }));`,
    { cwd },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    count: tracked.length,
    digest: createHash("sha256").update(tracked.join("\n")).digest("hex"),
  });
});
