import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { drainGlobalSingletonLifecycleState } from "../../shared/global-singleton.js";
import { git, initializeGitFixture } from "./git-fixture.test-support.js";
import { provisionIncludedFiles } from "./provisioned-files.js";

const directories = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  vi.restoreAllMocks();
  await drainGlobalSingletonLifecycleState();
});

async function fixture() {
  const directory = directories.make("worktree-copy-");
  const source = await initializeGitFixture(directory, "source", "README.md", "tracked");
  const destination = path.join(directory, "destination");
  await fs.mkdir(destination);
  await fs.writeFile(path.join(source, ".gitignore"), "*.local\n");
  await git(source, "add", ".gitignore");
  await git(source, "commit", "-m", "ignore local files");
  await fs.writeFile(path.join(source, "a.local"), "first", { mode: 0o640 });
  await fs.writeFile(path.join(source, "b.local"), "second");
  return { source, destination };
}

it("provisions an untracked include manifest without synchronous source filesystem work on the caller", async () => {
  const { source, destination } = await fixture();
  expect(await provisionIncludedFiles(source, destination)).toEqual([]);
  await fs.writeFile(path.join(source, ".worktreeinclude"), "*.local\n");
  using stats = vi.spyOn(fsSync, "lstatSync");
  expect(await provisionIncludedFiles(source, destination)).toEqual(["a.local", "b.local"]);
  expect(await fs.readFile(path.join(destination, "a.local"), "utf8")).toBe("first");
  expect(await fs.readFile(path.join(destination, "b.local"), "utf8")).toBe("second");
  expect(stats.mock.calls.filter(([target]) => String(target).startsWith(source))).toEqual([]);
});

it.each(["guard", "abort"] as const)(
  "refuses the completion receipt when %s revokes the caller",
  async (kind) => {
    const { source, destination } = await fixture();
    await fs.writeFile(path.join(source, ".worktreeinclude"), "*.local\n");
    const revoked = new Error("source authority retired");
    const controller = new AbortController();
    await expect(
      provisionIncludedFiles(source, destination, {
        signal: controller.signal,
        assertCurrent() {
          if (fsSync.existsSync(path.join(destination, "a.local"))) {
            if (kind === "abort") {
              controller.abort(revoked);
              return;
            }
            throw revoked;
          }
        },
      }),
    ).rejects.toBe(revoked);
    expect(await fs.readFile(path.join(destination, "a.local"), "utf8")).toBe("first");
    // Copies already accepted by the worker may settle; no receipt may publish afterward.
    const settled = await fs.readdir(destination);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(await fs.readdir(destination)).toEqual(settled);
  },
);
