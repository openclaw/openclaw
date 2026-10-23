import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { addIgnoreRules, type IgnoreMatcher } from "./ignore-rules.js";

const oversizedIgnoreFileContent = () => `#${"x".repeat(4 * 1024 * 1024)}`;

function expectPaths(ig: IgnoreMatcher, ignored: string[], visible: string[] = []) {
  expect(ignored.map((pathname) => ig.ignores(pathname))).toEqual(ignored.map(() => true));
  expect(visible.map((pathname) => ig.ignores(pathname))).toEqual(visible.map(() => false));
}

describe("addIgnoreRules", () => {
  const dirs = useAutoCleanupTempDirTracker(afterEach);
  let tempDir: string;
  const write = (content: string, name = ".gitignore", dir = tempDir) =>
    fs.writeFileSync(path.join(dir, name), content, "utf-8");
  const scan = (dir = tempDir) => addIgnoreRules(dir, tempDir);
  const mkdir = (...parts: string[]) => {
    const dir = path.join(tempDir, ...parts);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };

  beforeEach(() => {
    tempDir = dirs.make("openclaw-ignore-rules-");
  });

  it("keeps root-anchored patterns and negations at the top level", () => {
    write("/build\nkeep\n!/keep\n");
    expectPaths(scan(), ["build/", "skills/keep"], ["skills/build/", "keep"]);
  });

  it("parses a large ignore file under the byte cap", () => {
    write(`#${"x".repeat(2 * 1024 * 1024)}\nignored-file\n`);
    expectPaths(scan(), ["ignored-file"], ["unrelated-file"]);
  });

  it.each([
    ["rule count across files", "a\n".repeat(10_000), "b\n".repeat(10_001)],
    ["individual pattern length", "a".repeat(16 * 1024 + 1), ""],
  ])("fails closed on excessive %s", (_name, gitignore, ignore) => {
    write(gitignore);
    if (ignore) {
      write(ignore, ".ignore");
    }
    expect(scan().ignores("unrelated-file")).toBe(true);
  });

  it("counts directory prefixes toward the compiled-pattern budget", () => {
    const first = "a".repeat(150);
    const second = "b".repeat(150);
    const nestedDir = mkdir(first, second);
    write("x\n".repeat(20_000), ".gitignore", nestedDir);
    expectPaths(scan(nestedDir), [`${first}/${second}`, `${first}/${second}/secret.txt`]);
  });

  it("keeps the subtree excluded when a later ignore file negates it", () => {
    write(oversizedIgnoreFileContent());
    write("!ignored-file\n!secret.txt\n", ".ignore");
    expectPaths(scan(), ["ignored-file", "secret.txt"]);
  });

  it("treats fail-closed subtree paths literally", () => {
    const oversized = oversizedIgnoreFileContent();
    const unusualNames = [
      "Private",
      "#private",
      "!private",
      "[private]",
      ...(process.platform === "win32" ? [] : ["private?docs", "private*docs"]),
    ];
    let ig = scan();

    for (const name of unusualNames) {
      const nestedDir = mkdir(name);
      write(oversized, ".gitignore", nestedDir);
      ig = addIgnoreRules(nestedDir, tempDir, ig);

      expectPaths(ig, [name, `${name}/secret.txt`, [name, "nested", "secret.txt"].join(path.sep)]);
    }

    expectPaths(ig, ["private/secret.txt"], ["public/secret.txt"]);
    if (process.platform !== "win32") {
      expect(ig.ignores("#private\\secret.txt")).toBe(false);
    }
  });

  it("keeps fail-closed metadata when the matcher is extended", () => {
    const nestedDir = mkdir("locked");
    write(oversizedIgnoreFileContent(), ".gitignore", nestedDir);
    const ig = scan(nestedDir);

    write("!locked/\n!locked/secret.txt\n");
    expect(addIgnoreRules(tempDir, tempDir, ig)).toBe(ig);

    expectPaths(ig, ["locked", "locked/secret.txt"]);
  });

  it("follows a chain of symlinks to the final regular .gitignore", () => {
    const realDir = dirs.make("openclaw-ignore-rules-real-");
    write("node_modules/\n", "real.gitignore", realDir);
    const linkA = path.join(realDir, "link-a");
    const linkB = path.join(realDir, "link-b");
    fs.symlinkSync(path.join(realDir, "real.gitignore"), linkA);
    fs.symlinkSync(linkA, linkB);
    fs.symlinkSync(linkB, path.join(tempDir, ".gitignore"));
    expect(scan().ignores("node_modules/foo")).toBe(true);
  });
});
