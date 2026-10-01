import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { collectCheckoutDiffBaseline } from "./session-diff.runtime.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

function git(root: string, ...args: string[]) {
  execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
}

function repository(): string {
  const root = tempDirs.make("session-diff-fingerprints-");
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Test");
  git(root, "config", "user.email", "test@openclaw.test");
  git(root, "config", "commit.gpgsign", "false");
  return root;
}

// Version-one stored fingerprints prefix raw bytes with these NUL-separated fields.
function storedFingerprint(
  name: string,
  descriptor: string,
  bytes: Buffer = Buffer.alloc(0),
  status = "added",
  oldPath = "",
  untracked = true,
): string {
  return createHash("sha256")
    .update([name, oldPath, status, untracked ? "untracked" : "tracked", descriptor].join("\0"))
    .update(bytes)
    .digest("hex");
}

describe("session diff baseline file capture", () => {
  it("retains unchanged content when modification time changes during the display read", async () => {
    const root = repository();
    const file = path.join(root, "work.bin");
    const bytes = Buffer.from([0, 1, 255, 2, 0, 3]);
    await fs.writeFile(file, bytes, { mode: 0o640 });
    const stat = await fs.stat(file);
    const open = fs.open.bind(fs);
    let touched = false;
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (args[0] === file) {
        const read = handle.read.bind(handle);
        vi.spyOn(handle, "read").mockImplementationOnce(async (...readArgs) => {
          const result = await read(...readArgs);
          await fs.utimes(file, stat.atime, new Date("2000-01-01T00:00:00Z"));
          touched = true;
          return result;
        });
      }
      return handle;
    });

    const baseline = await collectCheckoutDiffBaseline({ cwd: root });

    expect(touched).toBe(true);
    expect(baseline?.files).toEqual([
      {
        path: "work.bin",
        fingerprint: storedFingerprint("work.bin", `${stat.mode}\0${stat.size}`, bytes),
      },
    ]);
    expect(baseline?.truncated).toBeUndefined();
  });

  it.skipIf(process.platform === "win32")(
    "preserves stored rename, deletion, symlink and literal-name fingerprints",
    async () => {
      const root = repository();
      await fs.writeFile(path.join(root, "old.txt"), "tracked bytes\n");
      await fs.writeFile(path.join(root, "deleted.txt"), "deleted bytes\n");
      git(root, "add", ".");
      git(root, "commit", "-qm", "base");
      git(root, "mv", "old.txt", "renamed.txt");
      await fs.unlink(path.join(root, "deleted.txt"));
      await fs.mkdir(path.join(root, "~"));
      const bytes = Buffer.from("literal path bytes\n");
      await fs.writeFile(path.join(root, "~", "draft.txt"), bytes);
      await fs.symlink("~/draft.txt", path.join(root, "link"));
      const renamed = await fs.stat(path.join(root, "renamed.txt"));
      const literal = await fs.stat(path.join(root, "~", "draft.txt"));

      const baseline = await collectCheckoutDiffBaseline({ cwd: root });

      expect(new Map(baseline?.files.map((entry) => [entry.path, entry.fingerprint]))).toEqual(
        new Map([
          [
            "deleted.txt",
            storedFingerprint("deleted.txt", "deleted", undefined, "deleted", "", false),
          ],
          ["link", storedFingerprint("link", "symlink:~/draft.txt")],
          [
            "renamed.txt",
            storedFingerprint(
              "renamed.txt",
              `${renamed.mode}\0${renamed.size}`,
              Buffer.from("tracked bytes\n"),
              "renamed",
              "old.txt",
              false,
            ),
          ],
          [
            "~/draft.txt",
            storedFingerprint("~/draft.txt", `${literal.mode}\0${literal.size}`, bytes),
          ],
        ]),
      );
      expect(baseline?.truncated).toBeUndefined();
    },
  );

  it("keeps the per-file and aggregate byte caps while rejecting hardlinks", async () => {
    const root = repository();
    const fourMiB = Buffer.alloc(4 * 1024 * 1024);
    await fs.writeFile(path.join(root, "00-oversized.bin"), Buffer.alloc(fourMiB.length + 1));
    const outside = path.join(tempDirs.make("session-diff-outside-"), "retained.txt");
    await fs.writeFile(outside, "outside bytes\n");
    await fs.link(outside, path.join(root, "01-hardlink.txt"));
    const included = ["10-a.bin", "11-b.bin", "12-c.bin", "13-d.bin"];
    for (const name of included) {
      await fs.writeFile(path.join(root, name), fourMiB);
    }
    await fs.writeFile(path.join(root, "20-over-budget.txt"), "x");
    await fs.writeFile(path.join(root, "30-empty.txt"), "");

    const baseline = await collectCheckoutDiffBaseline({ cwd: root });

    expect(baseline?.files.map((entry) => entry.path)).toEqual([...included, "30-empty.txt"]);
    expect(baseline?.truncated).toBe(true);
    await expect(fs.readFile(outside, "utf8")).resolves.toBe("outside bytes\n");
  });
});
