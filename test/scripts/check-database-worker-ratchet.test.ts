import childProcess, { execFileSync } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { main } from "../../scripts/check-database-worker-ratchet.mts";
import { inventory } from "../../scripts/database-worker-inventory.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
});

it("checks working and staged T1 growth without ripgrep", () => {
  const spawnSync = childProcess.spawnSync;
  vi.spyOn(childProcess, "spawnSync").mockImplementation((...args) => {
    if (args[0] === "rg") {
      throw Object.assign(new Error("spawnSync rg ENOENT"), { code: "ENOENT" });
    }
    return spawnSync(...args);
  });
  // The inventory imports the named builtin export rather than the default object.
  syncBuiltinESMExports();
  const root = tempDirs.make("openclaw-sqlite-ratchet-");
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
      cwd: root,
      stdio: "pipe",
    });
  fs.mkdirSync(path.join(root, "src"));
  const file = path.join(root, "src/runtime.ts");
  const source = "executeSqliteQuerySync(query);\n";
  fs.writeFileSync(file, source.repeat(2));
  git("init");
  git("add", ".");
  git("commit", "-m", "base");
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  expect(main(root, ["--base", "HEAD"])).toBe(0);
  expect(main(root, ["--base", "HEAD", "--staged"])).toBe(0);
  fs.writeFileSync(file, source.repeat(3));
  expect(main(root, ["--base", "HEAD"])).toBe(1);
  expect(errors).toHaveBeenCalledWith(expect.stringContaining("src/runtime.ts: 2 -> 3"));
  expect(errors).toHaveBeenCalledWith(
    expect.stringContaining("src/runtime.ts:3:1 executeSqliteQuerySync"),
  );
  git("add", ".");
  fs.writeFileSync(file, source);
  errors.mockClear();
  expect(main(root, ["--base", "HEAD", "--staged"])).toBe(1);
  expect(errors).toHaveBeenCalledWith(expect.stringContaining("src/runtime.ts: 2 -> 3"));
  fs.writeFileSync(path.join(root, "src/runtime.worker.ts"), source.repeat(3));
  errors.mockClear();
  expect(main(root, ["--base", "HEAD"])).toBe(0);
  fs.writeFileSync(file, "export {};\n");
  expect(main(root, ["--base", "HEAD"])).toBe(0);
  expect(errors).not.toHaveBeenCalled();
  fs.writeFileSync(file, source);
  fs.writeFileSync(path.join(root, "src/split.ts"), source);
  expect(main(root, ["--base", "HEAD"])).toBe(0);
  fs.writeFileSync(path.join(root, "src/split.ts"), source.repeat(2));
  expect(main(root, ["--base", "HEAD"])).toBe(1);
  expect(errors).toHaveBeenCalledWith(
    expect.stringContaining("src/split.ts:2:1 executeSqliteQuerySync"),
  );
});

it("scans working-tree source and untracked files with Git ignores and literal paths", () => {
  const root = tempDirs.make("openclaw-sqlite-inventory-");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init");
  git("config", "color.grep", "always");
  git("config", "grep.recurseSubmodules", "true");
  const source = "executeSqliteQuerySync(query);\n";
  const included = [
    "src/runtime.ts",
    "src/tracked-ignored.ts",
    "src/untracked.ts",
    "src/.hidden.ts",
    "src/space name.ts",
    ...(process.platform === "win32" ? [] : ["src/new\nline.ts"]),
    "src/view.tsx",
    "src/common.cts",
    "extensions/plugin/runtime.js",
    "packages/lib/runtime.cjs",
    "scripts/probe.mts",
    "scripts/probe.mjs",
  ];
  const excluded = [
    "src/ignored.ts",
    "src/local-only.ts",
    "src/generated/runtime.ts",
    "src/runtime.test.ts",
    "src/test-support.ts",
    "src/notes.md",
    "docs/outside.ts",
  ];
  for (const file of [...included, ...excluded]) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), source);
  }
  fs.writeFileSync(
    path.join(root, ".gitignore"),
    "src/ignored.ts\nsrc/tracked-ignored.ts\nsrc/generated/\n",
  );
  fs.writeFileSync(path.join(root, ".git/info/exclude"), "src/local-only.ts\n");
  fs.writeFileSync(path.join(root, "src/binary.ts"), Buffer.from(source + "\0"));
  fs.writeFileSync(path.join(root, "src/runtime.ts"), "export {};\n");
  git("add", "src/runtime.ts");
  git("add", "-f", "src/tracked-ignored.ts");
  fs.writeFileSync(path.join(root, "src/runtime.ts"), source);

  expect(
    inventory(root)
      .map((row) => row.file)
      .toSorted(),
  ).toEqual(included.toSorted());
  expect(inventory(root, "", true).map((row) => row.file)).toEqual(["src/tracked-ignored.ts"]);
});

it("keeps an empty scan bounded to its roots and reports Git failures", () => {
  const root = tempDirs.make("openclaw-sqlite-empty-");
  execFileSync("git", ["init"], { cwd: root, stdio: "pipe" });
  fs.writeFileSync(path.join(root, "outside.ts"), "executeSqliteQuerySync(query);\n");
  expect(inventory(root)).toEqual([]);
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src/clean.ts"), "export {};\n");
  expect(inventory(root)).toEqual([]);
  expect(() => inventory(tempDirs.make("openclaw-sqlite-not-a-repo-"))).toThrow(
    /not a git repository/i,
  );
});
