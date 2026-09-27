import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { detectWorktreeFilesystemBackend } from "./filesystem-backend.js";
import { createCopyWorktreeBackend } from "./filesystem-backend.test-support.js";
import type { WorktreeFilesystemBackend } from "./filesystem-backend.types.js";
import { ManagedWorktreeService } from "./service.js";
import { useManagedWorktreeTestRepository } from "./service.test-support.js";
import { listTemplates } from "./template-registry.js";

vi.mock("./filesystem-backend.js", () => ({ detectWorktreeFilesystemBackend: vi.fn() }));
const execFileAsync = promisify(execFile);
async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execFileAsync("git", ["-C", cwd, ...args])).stdout.trim();
}
const read = (target: string, file: string) => fs.readFile(path.join(target, file), "utf8");

async function gitMetadata(target: string) {
  // Batch reads: Linux fork cost grows with the test worker's retained memory.
  // Resolve afresh at every observation because sparse setup changes path routing.
  const [commit, commonDir, indexPath, headPath] = (
    await git(
      target,
      "rev-parse",
      "HEAD",
      "--path-format=absolute",
      "--git-common-dir",
      "--git-path",
      "index",
      "--git-path",
      "HEAD",
    )
  ).split("\n");
  assert(commit && commonDir && indexPath && headPath);
  return { commit, commonDir, indexPath, headPath };
}

describe("ManagedWorktreeService sparse isolation", () => {
  const initializeRepository = useManagedWorktreeTestRepository();
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
    afterEach(() => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      closeOpenClawStateDatabaseForTest();
      cleanup();
    }),
  );
  let repo: string;
  let env: NodeJS.ProcessEnv;
  let service: ManagedWorktreeService;
  let backend: WorktreeFilesystemBackend;
  beforeEach(async () => {
    vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
    vi.stubEnv("GIT_ATTR_NOSYSTEM", "1");
    const root = tempDirs.make("openclaw-worktree-sparse-isolation-");
    repo = await initializeRepository(root);
    env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") };
    const now = Date.now();
    backend = createCopyWorktreeBackend();
    vi.mocked(detectWorktreeFilesystemBackend).mockReset().mockResolvedValue(backend);
    service = new ManagedWorktreeService({ env, now: () => now, getConfig: () => ({}) });
  });

  it.each([false, true])(
    "preserves isolated source and guarded fallback through sparse/disable order (companion-before-disable=%s)",
    async (companionBeforeDisable) => {
      await fs.mkdir(path.join(repo, ".openclaw/worktree-profiles"), { recursive: true });
      await fs.mkdir(path.join(repo, "selected"), { recursive: true });
      await fs.mkdir(path.join(repo, "excluded"), { recursive: true });
      await fs.writeFile(path.join(repo, "selected/source.txt"), "selected\n");
      await fs.writeFile(path.join(repo, "excluded/source.txt"), "excluded\n");
      await fs.writeFile(path.join(repo, ".gitignore"), "excluded/ignored.txt\n");
      await fs.writeFile(path.join(repo, ".openclaw/worktree-profiles/selected"), "selected\n");
      await git(repo, "add", ".");
      await git(repo, "commit", "-m", "source profile");
      const commit = await git(repo, "rev-parse", "HEAD");
      const targets = new Map<string, string>([["repository", repo]]);
      const observe = async () => {
        const samples = [];
        for (const target of [...targets.values(), ...listTemplates(env).map((t) => t.path)]) {
          samples.push(await gitMetadata(target));
        }
        expect(new Set(samples.map((s) => s.indexPath)).size).toBe(samples.length);
        expect(samples.every((s) => s.commit === commit)).toBe(true);
        expect(new Set(samples.map((s) => s.commonDir)).size).toBe(1);
      };
      const create = async (name: string, profiles?: string[]) => {
        const siblings = await Promise.all(
          [...targets.entries()].map(async ([label, target]) => {
            const { indexPath: index, headPath: head } = await gitMetadata(target);
            return {
              label,
              index,
              head,
              indexBytes: await fs.readFile(index),
              headBytes: await fs.readFile(head),
            };
          }),
        );
        const calls = vi.mocked(backend.cloneTemplate).mock.calls.length;
        const created = await service.create({ repoRoot: repo, name, baseRef: commit, profiles });
        // Sparse setup enables shared worktreeConfig, keeping later full creates on Git.
        expect(vi.mocked(backend.cloneTemplate).mock.calls.length > calls, name).toBe(
          name === "full-cold" || name === "full-warm",
        );
        for (const sibling of siblings) {
          expect(await fs.readFile(sibling.index), sibling.label).toEqual(sibling.indexBytes);
          expect(await fs.readFile(sibling.head), sibling.label).toEqual(sibling.headBytes);
        }
        targets.set(name, created.path);
        await observe();
        return created;
      };
      // Original order: cold full -> warm full -> sparse -> native disable ->
      // subsequent full -> sparse/reuse -> full. Companion adds a full create
      // while the first sparse checkout is still sparse to catch contamination.
      const cold = await create("full-cold");
      const warm = await create("full-warm");
      const sparseA = await create("sparse-a", ["selected"]);
      await fs.writeFile(path.join(sparseA.path, "selected/source.txt"), "sparse edit\n");
      await fs.mkdir(path.join(sparseA.path, "excluded"), { recursive: true });
      await fs.writeFile(path.join(sparseA.path, "excluded/ignored.txt"), "retained ignored\n");
      const companion = companionBeforeDisable ? await create("full-companion") : undefined;
      await git(sparseA.path, "sparse-checkout", "disable");
      await observe();
      const fullB = await create("full-after-disable");
      const sparseC = await create("sparse-c", ["selected"]);
      await fs.writeFile(path.join(sparseC.path, "selected/source.txt"), "sparse reuse edit\n");
      expect((await service.create({ repoRoot: repo, name: "sparse-c", baseRef: commit })).id).toBe(
        sparseC.id,
      );
      await expect(
        service.create({
          repoRoot: repo,
          name: "sparse-c",
          baseRef: commit,
          profiles: ["selected"],
        }),
      ).rejects.toThrow(/new worktree/);
      await observe();
      const fullD = await create("full-with-sparse-c");
      for (const target of [
        cold.path,
        warm.path,
        fullB.path,
        fullD.path,
        ...(companion ? [companion.path] : []),
        ...listTemplates(env).map((t) => t.path),
      ]) {
        expect(await read(target, "selected/source.txt")).toBe("selected\n");
        expect(await read(target, "excluded/source.txt")).toBe("excluded\n");
        expect(await git(target, "ls-files", "-t")).not.toMatch(/^S /m);
        expect(await git(target, "config", "--show-origin", "--show-scope", "--list")).not.toMatch(
          /core\.sparsecheckout=true/,
        );
      }
      expect(await read(sparseA.path, "selected/source.txt")).toBe("sparse edit\n");
      expect(await read(sparseA.path, "excluded/ignored.txt")).toBe("retained ignored\n");
      expect(await read(sparseA.path, "excluded/source.txt")).toBe("excluded\n");
      expect(await read(sparseC.path, "selected/source.txt")).toBe("sparse reuse edit\n");
      await expect(fs.access(path.join(sparseC.path, "excluded/source.txt"))).rejects.toMatchObject(
        { code: "ENOENT" },
      );
      expect(await git(sparseC.path, "ls-files", "-t")).toMatch(/^S excluded\/source.txt$/m);
      expect(await git(sparseC.path, "merge-base", "HEAD", "main")).toBe(commit);
      expect(await git(sparseC.path, "rev-parse", "--is-shallow-repository")).toBe("false");
    },
  );
});
