import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { requireGit, requireGitBuffer } from "../../agents/worktrees/git.js";
import { gitNullConfigPath } from "../../infra/git-exec.js";
import { STAGED_INPUT_GITIGNORE } from "../../media/staged-inputs.js";
import "../../test-utils/prepare-compiled-subprocesses.js";
import { sha256, workspaceFile } from "./workspace-manifest-fixtures.test-support.js";
import {
  captureTemplateWorkspaceManifest,
  captureWorkspaceManifestDocument,
} from "./workspace-manifest-worker.js";
import { parseWorkerWorkspaceManifest } from "./workspace-manifest.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

// This fixture exercises Git's POSIX executable bit and real symbolic links.
it.skipIf(process.platform === "win32")(
  "matches full captures across Git deltas, empty directories and staged-input membership",
  async () => {
    const root = await fs.realpath(tempDirs.make("workspace-template-manifest-"));
    const options = {
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: gitNullConfigPath(),
        GIT_CONFIG_SYSTEM: gitNullConfigPath(),
      },
    };
    const git = (...args: string[]) => requireGit(root, args, options);
    const write = async (relative: string, content: string) => {
      await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
      await fs.writeFile(path.join(root, relative), content);
    };
    const commit = async () => {
      await git("add", "--all", "--force", "--", ".", ":(exclude)**/node_modules/**");
      await git("commit", "--quiet", "-m", "synthetic generation");
      return await git("rev-parse", "HEAD");
    };
    await git("init", "--quiet", "--template=", "-b", "main");
    await git("config", "user.name", "OpenClaw Test");
    await git("config", "user.email", "test@example.invalid");
    await git("config", "core.fileMode", "true");
    const files = new Map(
      Array.from({ length: 36 }, (_, index) => [
        `src/group-${index % 3}/file-${index}.txt`,
        `original ${String(index).padStart(2, "0")}\n`,
      ]),
    );
    const modes = new Map<string, number>();
    for (const [relative, content] of files) {
      await write(relative, content);
    }
    const staged = `media/inbound/openclaw-staged-${"a".repeat(64)}`;
    const marker = `${staged}/.gitignore`;
    const stagedFile = `${staged}/input.pyc`;
    const installerFile = `${staged}/node_modules/generated.txt`;
    await write(marker, "# ordinary project directory\n");
    await write(stagedFile, "retained task input\n");
    const buildInput = ".artifacts/build-cache-inputs/source.txt";
    await write(buildInput, "trusted source input\n");
    await write(".artifacts/build-cache-inputs/derived.txt", "generated cache\n");
    await write("shape", "a file\n");
    await fs.symlink("shape", path.join(root, "alias"));
    let baseCommit = await commit();
    const buildCacheInputs = [buildInput];
    let previous = await captureTemplateWorkspaceManifest({ root, baseCommit, buildCacheInputs });
    const fullCapture = () =>
      captureWorkspaceManifestDocument({
        root,
        baseCommit,
        buildCacheInputs: new Set(buildCacheInputs),
      });
    expect(previous).toEqual(await fullCapture());
    let seed = 2340;
    const pick = (candidates: string[]) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return candidates.splice(seed % candidates.length, 1)[0]!;
    };
    for (let round = 0; round < 3; round++) {
      const candidates = [...files.keys()];
      const edited = pick(candidates);
      const renamed = pick(candidates);
      const deleted = pick(candidates);
      const executable = pick(candidates);
      const content = `changed ${round}`.padEnd(files.get(edited)!.length, "!");
      files.set(edited, content);
      await write(edited, content);
      const destination = `renamed/round-${round} with space.txt`;
      await fs.mkdir(path.dirname(path.join(root, destination)), { recursive: true });
      await fs.rename(path.join(root, renamed), path.join(root, destination));
      files.set(destination, files.get(renamed)!);
      modes.set(destination, modes.get(renamed) ?? 0o644);
      files.delete(renamed);
      await fs.unlink(path.join(root, deleted));
      files.delete(deleted);
      const mode = modes.get(executable) === 0o755 ? 0o644 : 0o755;
      await fs.chmod(path.join(root, executable), mode);
      modes.set(executable, mode);
      const added = `added/round-${round}.txt`;
      files.set(added, `added ${round}\n`);
      await write(added, files.get(added)!);
      await fs.rm(path.join(root, "shape"), { recursive: true });
      const isDirectory = round % 2 === 0;
      await write(isDirectory ? "shape/child.txt" : "shape", `shape ${round}\n`);
      await fs.unlink(path.join(root, "alias"));
      const target = isDirectory ? "shape/child.txt" : "shape";
      await fs.symlink(target, path.join(root, "alias"));
      const retainedInput = round < 2;
      await write(
        marker,
        retainedInput ? STAGED_INPUT_GITIGNORE : "# ordinary project directory\n",
      );
      const before = baseCommit;
      baseCommit = await commit();
      const changedPaths = (
        await requireGitBuffer(
          root,
          ["diff", "--no-renames", "--name-only", "-z", before, baseCommit, "--"],
          options,
        )
      )
        .toString("utf8")
        .split("\0")
        .filter(Boolean);
      expect(changedPaths).toEqual(
        expect.arrayContaining([edited, renamed, destination, deleted, executable]),
      );
      expect(changedPaths).not.toContain(stagedFile);
      // Validation permits these installer bytes; Git never owns or reports them.
      await write(installerFile, `installer ${round}\n`);
      expect(changedPaths).not.toContain(installerFile);
      // Installer-created empty directories have no entry in either Git tree.
      if (round > 0) {
        await fs.rmdir(path.join(root, `generated-empty-${round - 1}`));
      }
      const empty = `generated-empty-${round}`;
      await fs.mkdir(path.join(root, empty));
      expect(changedPaths).not.toContain(empty);
      const captured = await captureTemplateWorkspaceManifest({
        root,
        baseCommit,
        buildCacheInputs,
        previous: { ...previous, changedPaths },
      });
      expect(captured, `round ${round}`).toEqual(await fullCapture());
      expect(captured.manifestRef).toBe(`sha256:${sha256(captured.rawManifest)}`);
      const manifest = parseWorkerWorkspaceManifest(
        captured.rawManifest,
        captured.manifestRef,
        buildCacheInputs,
      );
      expect(manifest.baseCommit).toBe(baseCommit);
      const entries = new Map(manifest.entries.map((entry) => [entry.path, entry]));
      for (const [relative, value] of files) {
        expect(entries.get(relative)).toEqual({
          ...workspaceFile(relative, value),
          mode: modes.get(relative) ?? 0o644,
        });
      }
      expect(entries.has(renamed)).toBe(false);
      expect(entries.has(deleted)).toBe(false);
      expect(entries.get(target)).toEqual(workspaceFile(target, `shape ${round}\n`));
      expect(entries.get("alias")).toEqual({ path: "alias", type: "symlink", mode: 0o777, target });
      expect(entries.has(stagedFile)).toBe(retainedInput);
      expect(entries.has(installerFile)).toBe(retainedInput);
      if (retainedInput) {
        expect(entries.get(stagedFile)).toEqual(workspaceFile(stagedFile, "retained task input\n"));
        expect(entries.get(installerFile)).toEqual(
          workspaceFile(installerFile, `installer ${round}\n`),
        );
      }
      expect(entries.get(buildInput)).toEqual(workspaceFile(buildInput, "trusted source input\n"));
      expect(entries.has(".artifacts/build-cache-inputs/derived.txt")).toBe(false);
      expect(manifest.directories).toContain(empty);
      expect(manifest.directories?.includes("shape")).toBe(isDirectory);
      expect(manifest.directories).not.toContain(`generated-empty-${round - 1}`);
      previous = captured;
    }
  },
);
