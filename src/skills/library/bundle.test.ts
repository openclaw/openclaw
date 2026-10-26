import { renameSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  prepareSkillBundle,
  prepareSkillLibraryBundle,
  readSkillBundleTree,
  readSkillLibraryTree,
} from "./bundle.js";

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

it("avoids expanding retained text without enlarging escaped or binary resources", async () => {
  const directory = await makeTree();
  const inputs = new Map([
    ["plain.txt", Buffer.from('Read the guide.\nRun "check.sh".\n'.repeat(100))],
    ["unicode.txt", Buffer.from(`${"a".repeat(3000)}🦞`)],
    ["sparse-nul.dat", Buffer.from(`${"a".repeat(3000)}\0`)],
    ["escaped.txt", Buffer.from('"\\\t\n\r'.repeat(600))],
  ]);
  for (const [name, bytes] of inputs) {
    await fs.writeFile(path.join(directory, name), bytes);
  }
  const delivery = await readSkillBundleTree(directory);
  const serialized = JSON.stringify(delivery);
  const received = prepareSkillBundle(JSON.parse(serialized));
  for (const [name, bytes] of inputs) {
    expect(received.files.find((entry) => entry.path === name)?.bytes).toEqual(bytes);
    const delivered = delivery.find((entry) => entry.path === name)!;
    const base64 = { ...delivered, content: bytes.toString("base64"), encoding: "base64" };
    expect(Buffer.byteLength(JSON.stringify(delivered))).toBeLessThanOrEqual(
      Buffer.byteLength(JSON.stringify(base64)),
    );
  }
  expect(delivery.find((entry) => entry.path === "plain.txt")?.content.length).toBe(
    inputs.get("plain.txt")!.length,
  );
  // Mixed Unicode must not turn a mostly ASCII payload into a two-byte JS string.
  expect(delivery.find((entry) => entry.path === "unicode.txt")?.encoding).toBe("base64");
  // Keep NUL payloads classified as binary even when UTF-8 would be smaller.
  expect(delivery.find((entry) => entry.path === "sparse-nul.dat")?.encoding).toBe("base64");
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

it.runIf(posix)("accepts a symlink root but rejects linked resources", async () => {
  const target = await makeTree({ "scripts/run.sh": resource.content });
  const linkedRoot = path.join(target, "..", "managed-skill");
  await fs.symlink(target, linkedRoot, "dir");
  await expect(readSkillBundleTree(linkedRoot)).resolves.toMatchObject([
    { path: "SKILL.md" },
    { path: "scripts/run.sh" },
  ]);
  const linked = path.join(target, "scripts/linked");
  await fs.symlink("../SKILL.md", linked);
  await expect(readSkillBundleTree(linkedRoot)).rejects.toMatchObject({
    code: "INVALID_BUNDLE",
    message: expect.stringContaining("Skill trees cannot contain links or special files"),
  });
  await fs.unlink(linked);
  await fs.link(path.join(target, "SKILL.md"), linked);
  await expect(readSkillLibraryTree(target)).rejects.toThrow();
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
