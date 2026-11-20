import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { findUniqueWorkspaceFileNames, listSessionWorkspaceFiles } from "./workspace-files.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);

function write(root: string, relative: string) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "");
}

/** The reader fallback this search replaces: one complete search, exactly one same-name file. */
async function searchFallback(root: string, name: string) {
  const { browser } = await listSessionWorkspaceFiles({ root, files: [], path: "", search: name });
  const matches =
    browser && !browser.truncated
      ? browser.entries.filter((entry) => entry.kind === "file" && entry.name === name)
      : [];
  return matches.length === 1 ? matches[0]!.path : undefined;
}

async function expectParity(root: string, names: string[]) {
  const shared = await findUniqueWorkspaceFileNames({ root, files: [], names });
  const expected = new Map<string, string>();
  for (const name of names) {
    const match = await searchFallback(root, name);
    if (match) {
      expected.set(name, match);
    }
  }
  expect(shared).toEqual(expected);
  return new Set(shared.keys());
}

it("matches each name's own search for unique, duplicate, and absent names", async () => {
  const root = dirs.make("name-search-basic-");
  for (const file of ["a/unique.ts", "a/twin.ts", "b/twin.ts", "b/c/deep.md", "README.md"]) {
    write(root, file);
  }
  fs.mkdirSync(path.join(root, "dir.ts"));
  fs.mkdirSync(path.join(root, ".git"));
  write(root, ".git/hidden.ts");
  const found = await expectParity(root, [
    "unique.ts",
    "twin.ts",
    "deep.md",
    "README.md",
    "readme.md",
    "absent.ts",
    "dir.ts",
    "hidden.ts",
    " unique.ts",
    "unique.ts",
  ]);
  expect(found).toEqual(new Set(["unique.ts", "deep.md", "README.md"]));
});

it("stops each name where its own search would stop", async () => {
  const root = dirs.make("name-search-limits-");
  // 600 entries contain "x.md": a search for it is truncated after 500 matches,
  // while a narrower name that sorts first finishes before any limit.
  write(root, "aa/first.md");
  for (let index = 0; index < 600; index++) {
    write(root, `m/f${String(index).padStart(4, "0")}x.md`);
  }
  write(root, "z/x.md");
  write(root, "z/late.md");
  const found = await expectParity(root, ["first.md", "x.md", "late.md", "f0001x.md"]);
  expect(found.has("first.md")).toBe(true);
  expect(found.has("x.md")).toBe(false);
});

it("stops every search at the visited-entry limit and at skipped directories", async () => {
  const visitedRoot = dirs.make("name-search-visited-");
  write(visitedRoot, "a/early.ts");
  for (let index = 0; index < 5_100; index++) {
    write(visitedRoot, `b/file-${String(index).padStart(5, "0")}.txt`);
  }
  write(visitedRoot, "c/late.ts");
  expect(await expectParity(visitedRoot, ["early.ts", "late.ts", "file-00010.txt"])).toEqual(
    new Set(),
  );

  const skippedRoot = dirs.make("name-search-skipped-");
  write(skippedRoot, "a/before.ts");
  write(skippedRoot, "node_modules/pkg/index.js");
  write(skippedRoot, "z/after.ts");
  const found = await expectParity(skippedRoot, ["before.ts", "after.ts"]);
  expect(found).toEqual(new Set());
});
