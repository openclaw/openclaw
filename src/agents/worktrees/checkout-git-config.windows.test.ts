import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { withWorktreeGitConfig, type WorktreeGitPolicy } from "./checkout-git-config.js";

const fixture = vi.hoisted(() => ({
  common: "",
  beforeProcess: async (_view: string) => {},
  views: [] as string[],
  run: vi.fn(
    async (
      _cwd: string,
      args: string[],
      options: { env?: NodeJS.ProcessEnv; beforeRun?: () => void } = {},
    ) => {
      options.beforeRun?.();
      if (args[0] === "config") {
        return { code: 1, stdout: "", stderr: "" };
      }
      const view = options.env?.GIT_COMMON_DIR;
      if (!view) {
        throw new Error("Content operation lost its isolated configuration");
      }
      fixture.views.push(view);
      await fixture.beforeProcess(view);
      return { code: 0, stdout: "", stderr: "" };
    },
  ),
}));
vi.mock("./git.js", () => ({
  requireGit: async (_cwd: string, args: string[]) =>
    args.includes("--git-common-dir") ? fixture.common : "a".repeat(40),
  runGit: fixture.run,
  runGitBytes: fixture.run,
  runGitBuffered: fixture.run,
  commandError: () => new Error("Git failed"),
}));
// Real filesystem operations exercise the Windows junction/copy strategy on this
// host. Native Windows path conversion and process spawning have separate owners.
vi.mock("../../infra/git-exec.js", () => ({
  normalizeGitPathForFilesystem: (value: string) => value,
  gitNullConfigPath: () => "NUL",
  requireGitCommandOutput: () => "",
}));
const dirs = useAutoCleanupTempDirTracker(afterEach);

it("isolates copied metadata per Windows process and keeps views until in-flight work settles", async () => {
  const root = dirs.make("windows-git-view-");
  fixture.common = path.join(root, "common");
  for (const name of ["objects", "refs", "worktrees"]) {
    await fs.mkdir(path.join(fixture.common, name), { recursive: true });
  }
  await fs.writeFile(path.join(fixture.common, "packed-refs"), "first");
  fixture.views = [];
  fixture.beforeProcess = async () => {};
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const links = vi.spyOn(fs, "symlink");
  const entered = createDeferredCore();
  const release = createDeferredCore();
  let saved: WorktreeGitPolicy | undefined;
  let finished = false;
  try {
    Object.defineProperty(process, "platform", { value: "win32" });
    const scope = withWorktreeGitConfig(root, true, {}, async (git) => {
      saved = git;
      await git.run(root, ["status"]);
      await fs.writeFile(path.join(fixture.common, "packed-refs"), "second");
      await git.run(root, ["status"]);
      expect(fixture.views[0]).not.toBe(fixture.views[1]);
      expect(await fs.readFile(path.join(fixture.views[0]!, "packed-refs"), "utf8")).toBe("first");
      expect(await fs.readFile(path.join(fixture.views[1]!, "packed-refs"), "utf8")).toBe("second");
      fixture.beforeProcess = async () => {
        entered.resolve();
        await release.promise;
      };
      void git.run(root, ["status"]);
      await entered.promise;
    }).then(() => {
      finished = true;
    });
    await entered.promise;
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(finished).toBe(false);
    expect((await fs.stat(fixture.views.at(-1)!)).isDirectory()).toBe(true);
    expect(links.mock.calls.every((call) => call[2] === "junction")).toBe(true);
    release.resolve();
    await scope;
    for (const view of fixture.views) {
      await expect(fs.stat(view)).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(await fs.readFile(path.join(fixture.common, "packed-refs"), "utf8")).toBe("second");
    expect((await fs.stat(path.join(fixture.common, "refs"))).isDirectory()).toBe(true);
    expect(() => saved!.run(root, ["status"])).toThrow("scope closed");
  } finally {
    release.resolve();
    Object.defineProperty(process, "platform", platform);
    links.mockRestore();
  }
});
