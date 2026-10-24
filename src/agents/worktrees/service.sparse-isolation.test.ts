import fs from "node:fs/promises";
import path from "node:path";
import { assert, expect, it, vi } from "vitest";
import { detectWorktreeFilesystemBackend } from "./filesystem-backend.js";
import { createCopyWorktreeBackend } from "./filesystem-backend.test-support.js";
import { ManagedWorktreeService } from "./service.js";
import { git, useManagedWorktreeTestRepository } from "./service.test-support.js";
import { useWorktreeStateRoots } from "./state-fixture.test-support.js";
import { listTemplatesAsync } from "./template-registry-async.js";

vi.mock("./filesystem-backend.js", () => ({ detectWorktreeFilesystemBackend: vi.fn() }));
const read = (target: string, file: string) => fs.readFile(path.join(target, file), "utf8");
const readFiles = (files: string[]) => Promise.all(files.map((file) => fs.readFile(file)));

async function gitMetadata(target: string) {
  // Resolve fresh metadata in one process: sparse setup changes Git path routing.
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

const initializeRepository = useManagedWorktreeTestRepository();
const tempDirs = useWorktreeStateRoots();
it("preserves isolated source and guarded fallback across sparse checkout changes", async () => {
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  vi.stubEnv("GIT_ATTR_NOSYSTEM", "1");
  const root = tempDirs.make("openclaw-worktree-sparse-isolation-");
  const repo = await initializeRepository(root);
  const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") };
  const backend = createCopyWorktreeBackend();
  vi.mocked(detectWorktreeFilesystemBackend).mockReset().mockResolvedValue(backend);
  const service = new ManagedWorktreeService({ env, getConfig: () => ({}) });
  // Sparse isolation must not depend on Btrfs checkout timing selection.
  vi.spyOn(performance, "now").mockReturnValue(0);
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
  const request = (name: string, profiles?: string[]) =>
    service.create({ repoRoot: repo, name, baseRef: commit, profiles });
  const targets = new Map<string, string>([["repository", repo]]);
  const full: string[] = [];
  const observe = async () => {
    const samples = [];
    for (const target of [
      ...targets.values(),
      ...(await listTemplatesAsync(env)).map((t) => t.path),
    ]) {
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
        const paths = [index, head];
        return { label, paths, bytes: await readFiles(paths) };
      }),
    );
    const calls = vi.mocked(backend.cloneTemplate).mock.calls.length;
    const created = await request(name, profiles);
    expect(vi.mocked(backend.cloneTemplate).mock.calls.length > calls, name).toBe(
      !profiles?.length,
    );
    for (const sibling of siblings) {
      expect(await readFiles(sibling.paths), sibling.label).toEqual(sibling.bytes);
    }
    if (!profiles?.length) {
      full.push(created.path);
    }
    targets.set(name, created.path);
    await observe();
    return created;
  };
  await create("full-cold");
  await create("full-warm");
  const sparseA = await create("sparse-a", ["selected"]);
  await fs.writeFile(path.join(sparseA.path, "selected/source.txt"), "sparse edit\n");
  await fs.mkdir(path.join(sparseA.path, "excluded"), { recursive: true });
  await fs.writeFile(path.join(sparseA.path, "excluded/ignored.txt"), "retained ignored\n");
  await create("full-companion");
  await git(sparseA.path, "sparse-checkout", "disable");
  await observe();
  await create("full-after-disable");
  const sparseC = await create("sparse-c", ["selected"]);
  await fs.writeFile(path.join(sparseC.path, "selected/source.txt"), "sparse reuse edit\n");
  expect((await request("sparse-c")).id).toBe(sparseC.id);
  await expect(request("sparse-c", ["selected"])).rejects.toThrow(/new worktree/);
  await observe();
  await create("full-with-sparse-c");
  for (const target of [...full, ...(await listTemplatesAsync(env)).map((t) => t.path)]) {
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
  await expect(fs.access(path.join(sparseC.path, "excluded/source.txt"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(await git(sparseC.path, "ls-files", "-t")).toMatch(/^S excluded\/source.txt$/m);
  expect(await git(sparseC.path, "merge-base", "HEAD", "main")).toBe(commit);
  expect(await git(sparseC.path, "rev-parse", "--is-shallow-repository")).toBe("false");
});
