import { renameSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { prepareSkillLibraryBundle, readSkillBundleTree, readSkillLibraryTree } from "./bundle.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const posix = process.platform !== "win32";
const file = (filePath: string, content = "x") => ({ path: filePath, content });
const markdown = file("SKILL.md", "---\nname: demo\ndescription: Test procedure\n---\n# Demo\n");
const missingDescription = file("SKILL.md", "---\nname: demo\n---\n");
const resource = { path: "scripts/test.sh", content: "#!/bin/sh\nprintf hello", executable: true };

async function makeTree(files: Record<string, string> = {}) {
  const directory = path.join(tempDirs.make("skill-tree-"), "skill");
  for (const [name, content] of Object.entries({ "SKILL.md": markdown.content, ...files })) {
    const filePath = path.join(directory, name);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content);
  }
  return directory;
}

it("hashes paths, exact bytes, and executability independently of order", () => {
  const original = prepareSkillLibraryBundle([markdown, resource]);
  expect(original.revision).toBe(
    "c4999fd620e1fbeaf3c097816e7c3d174e5fb9722b165527b92f18f81af350d4",
  );
  expect(prepareSkillLibraryBundle([resource, markdown]).revision).toBe(original.revision);
  for (const changed of [
    { ...resource, path: "scripts/renamed.sh" },
    { ...resource, content: `${resource.content}\n` },
    { ...resource, executable: false },
  ]) {
    expect(prepareSkillLibraryBundle([markdown, changed]).revision).not.toBe(original.revision);
  }
});

it.each([
  ["missing description", [missingDescription], "requires name and description"],
  ...["../escape", "/absolute", "a\\b", "LPT³", "node_modules/a"].map(
    (name) => [name, [markdown, file(name)], "Non-portable"] as const,
  ),
  ["case collision", [markdown, file("a"), file("A", "y")], undefined],
  ["file/directory collision", [markdown, file("a"), file("a/b", "y")], undefined],
  ["oversized file", [markdown, file("big", "x".repeat(1024 * 1024 + 1))], undefined],
] as const)("rejects %s", (_name, files, message) => {
  expect(() => prepareSkillLibraryBundle(files)).toThrow(message);
});

it.runIf(posix)("rejects hardlink imports", async () => {
  const directory = await makeTree();
  const linked = path.join(directory, "linked");
  await fs.link(path.join(directory, "SKILL.md"), linked);
  await expect(readSkillLibraryTree(directory)).rejects.toThrow();
});

it.runIf(posix)("accepts a symlink root but rejects nested links", async () => {
  const target = await makeTree({ "scripts/run.sh": resource.content });
  const linkedRoot = path.join(target, "..", "managed-skill");
  await fs.symlink(target, linkedRoot, "dir");
  await expect(readSkillBundleTree(linkedRoot)).resolves.toMatchObject([
    { path: "SKILL.md" },
    { path: "scripts/run.sh" },
  ]);
  await fs.symlink("../SKILL.md", path.join(target, "scripts/linked"));
  await expect(readSkillBundleTree(linkedRoot)).rejects.toMatchObject({
    code: "INVALID_BUNDLE",
    message: expect.stringContaining("Skill trees cannot contain links or special files"),
  });
});

it.each(["removed", ...(posix ? ["broken"] : [])])(
  "reports a %s root with path diagnostics",
  async (kind) => {
    const directory = await makeTree();
    const broken = kind === "broken";
    const requested = broken ? path.join(directory, "..", "managed-skill") : directory;
    if (broken) {
      await fs.symlink(path.join(directory, "missing"), requested, "dir");
    }
    let removed = false;
    const removeRoot = () => {
      if (!removed) {
        renameSync(directory, path.join(directory, "..", "moved"));
        removed = true;
      }
      return true;
    };
    const code = broken ? "ENOENT" : "not-found";
    const name = broken ? "managed-skill" : "skill";
    await expect(
      readSkillBundleTree(requested, broken ? undefined : removeRoot),
    ).rejects.toMatchObject({
      code: "INVALID_BUNDLE",
      message: expect.stringMatching(new RegExp(`root=.*${name}.*path=.*${name}.*${code}`, "s")),
      rootPath: requested,
      failedPath: requested,
      cause: { code },
    });
  },
);

it.runIf(posix)("rejects unreadable nested directories with path diagnostics", async () => {
  const directory = await makeTree({ "private/file": "x" });
  const nested = path.join(directory, "private");
  await fs.chmod(nested, 0);
  try {
    await expect(readSkillBundleTree(directory)).rejects.toMatchObject({
      code: "INVALID_BUNDLE",
      message: expect.stringMatching(/path=.*private.*EACCES/s),
    });
  } finally {
    await fs.chmod(nested, 0o700);
  }
});

it("rejects excessive depth rather than silently omitting files", async () => {
  const directory = await makeTree({ [`${"nested/".repeat(16)}data.bin`]: "x" });
  await expect(readSkillLibraryTree(directory)).rejects.toMatchObject({
    code: "INVALID_BUNDLE",
    message: "Skill tree exceeds traversal limits.",
  });
});
