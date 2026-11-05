import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { spawnNodeEvalSync } from "../../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("prunes generated trees before non-Git discovery while retaining source and suffix rules", () => {
  const cwd = tempDirs.make("filesystem-test-inventory-");
  const sources = [
    "src/kept.test.ts",
    "fixtures/source.test.ts",
    "ui/src/view.test.tsx",
    "extensions/example/browser/view.test.tsx",
    "src/custom.spec.ts",
  ];
  const ignored = [
    ".git",
    "node_modules",
    "dist",
    "vendor",
    ".cache",
    ".tmp",
    ".artifacts",
    "coverage",
  ];
  const decoys = ignored.flatMap((directory) => [
    `${directory}/vitest/nested/decoy.test.ts`,
    `packages/example/${directory}/nested/decoy.test.ts`,
  ]);
  for (const file of [...sources, ...decoys]) {
    const target = path.join(cwd, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, "");
  }
  const owner = new URL("../../scripts/lib/list-test-files.mts", import.meta.url).href;
  const result = spawnNodeEvalSync(
    `import fs from 'node:fs';
     import path from 'node:path';
     import { syncBuiltinESMExports } from 'node:module';
     const excluded = new Set(${JSON.stringify(ignored)});
     const readDirectory = fs.readdirSync;
     fs.readdirSync = (directory, ...options) => {
       const segments = path.relative(process.cwd(), path.resolve(directory)).split(path.sep);
       if (segments.some((segment) => excluded.has(segment))) {
         throw new Error('discovery entered a generated tree');
       }
       return readDirectory(directory, ...options);
     };
     syncBuiltinESMExports();
     const { listTrackedTestFiles } = await import(${JSON.stringify(owner)});
     console.log(JSON.stringify({
       tests: listTrackedTestFiles('.'),
       custom: listTrackedTestFiles('.', '.spec.ts'),
     }));`,
    { cwd },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    tests: sources.filter((file) => !file.endsWith(".spec.ts")).toSorted(),
    custom: ["src/custom.spec.ts"],
  });
});

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
