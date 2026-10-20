import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import { addManagedWorktree } from "./checkout.js";
import { detectWorktreeFilesystemBackend } from "./filesystem-backend.js";
import { createCopyWorktreeBackend } from "./filesystem-backend.test-support.js";
import { ManagedWorktreeService } from "./service.js";
import { git, useManagedWorktreeTestRepository } from "./service.test-support.js";
import { useWorktreeStateRoots } from "./state-fixture.test-support.js";
import { listTemplatesAsync } from "./template-registry-async.js";

// mock-isolation: exercise Btrfs selection on every host without native filesystem probes.
vi.mock("./filesystem-backend.js", () => ({ detectWorktreeFilesystemBackend: vi.fn() }));

const initializeRepository = useManagedWorktreeTestRepository();
const tempDirs = useWorktreeStateRoots();
let root: string;
let repo: string;
let env: NodeJS.ProcessEnv;
let backend: ReturnType<typeof createCopyWorktreeBackend>;
let service: ManagedWorktreeService;
beforeEach(async () => {
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  vi.stubEnv("GIT_ATTR_NOSYSTEM", "1");
  root = tempDirs.make("openclaw-btrfs-");
  repo = await initializeRepository(root);
  env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") };
  backend = createCopyWorktreeBackend();
  vi.mocked(detectWorktreeFilesystemBackend).mockResolvedValue(backend);
  service = new ManagedWorktreeService({ env, getConfig: () => ({}) });
});
const create = (name: string) => service.create({ repoRoot: repo, name, baseRef: "HEAD" });
const read = (target: string, file: string) => fs.readFile(path.join(target, file), "utf8");

it("keeps cloning when disk admission is slow", async () => {
  const worktreeRoot = path.join(root, "worktrees");
  await fs.mkdir(worktreeRoot);
  let elapsed = 0;
  vi.spyOn(performance, "now").mockImplementation(() => elapsed);
  for (const name of ["cold", "warm", "still-cloned", "new-commit"]) {
    const content = name === "new-commit" ? "changed source\n" : "base\n";
    if (name === "new-commit") {
      await fs.writeFile(path.join(repo, "README.md"), content);
      await git(repo, "commit", "-am", "changed source");
    }
    const destination = path.join(worktreeRoot, name);
    const result = await addManagedWorktree({
      env,
      now: Date.now,
      enabled: true,
      repoRoot: repo,
      commonDir: path.join(repo, ".git"),
      worktreeRoot,
      destination,
      base: "HEAD",
      commitGuard: () => {},
      requireSpace: async () => {
        elapsed += 1_000;
      },
    });
    expect(result.code).toBe(0);
    expect(await read(destination, "README.md")).toBe(content);
    expect(await git(destination, "rev-parse", "HEAD")).toBe(await git(repo, "rev-parse", "HEAD"));
  }
  expect(backend.createTemplate).toHaveBeenCalledTimes(1);
  expect(backend.cloneTemplate).toHaveBeenCalledTimes(4);
});

it("keeps cloning after a slow snapshot and refreshes changed commits", async () => {
  let elapsed = 0;
  vi.spyOn(performance, "now").mockImplementation(() => elapsed);
  const clone = createCopyWorktreeBackend().cloneTemplate;
  vi.mocked(backend.cloneTemplate).mockImplementation(async (...args) => {
    await clone(...args);
    elapsed += 1_000;
  });
  await fs.writeFile(path.join(repo, "unchanged.txt"), "unchanged\n");
  await git(repo, "add", "unchanged.txt");
  await git(repo, "commit", "-m", "stable file");
  await fs.writeFile(path.join(repo, "private.txt"), "untracked source only\n");
  for (const name of ["cold", "warm", "still-cloned"]) {
    const created = await create(name);
    expect(await read(created.path, "README.md")).toBe("base\n");
    expect(await git(created.path, "status", "--porcelain")).toBe("");
  }
  const original = (await listTemplatesAsync(env))[0]!;
  const unchanged = await fs.stat(path.join(original.path, "unchanged.txt"));
  for (const name of ["commit-b", "commit-c"]) {
    await fs.writeFile(path.join(repo, "README.md"), `${name}\n`);
    await git(repo, "commit", "-am", name);
    const commit = await git(repo, "rev-parse", "HEAD");
    const next = await create(name);
    expect(await read(next.path, "README.md")).toBe(`${name}\n`);
    expect(await git(next.path, "rev-parse", "HEAD")).toBe(commit);
    expect(await git(next.path, "status", "--porcelain")).toBe("");
    await expect(fs.access(path.join(next.path, "private.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  }
  const refreshed = (await listTemplatesAsync(env))[0]!;
  expect(refreshed.id).toBe(original.id);
  expect(refreshed.sourceCommit).toBe(await git(repo, "rev-parse", "HEAD"));
  expect(await git(refreshed.path, "status", "--porcelain")).toBe("");
  const kept = await fs.stat(path.join(refreshed.path, "unchanged.txt"));
  expect([kept.ino, kept.mtimeMs]).toEqual([unchanged.ino, unchanged.mtimeMs]);
  expect.soft(backend.createTemplate).toHaveBeenCalledTimes(1);
  expect.soft(backend.cloneTemplate).toHaveBeenCalledTimes(5);
});

it.each([".gitattributes", "nested/.gitattributes"])(
  "rebuilds unchanged blobs when %s changes checkout attributes",
  async (attributes) => {
    await fs.mkdir(path.join(repo, "nested"));
    await fs.writeFile(path.join(repo, "nested", "file.txt"), "line\n");
    await git(repo, "add", ".");
    await git(repo, "commit", "-m", "text fixture");
    const first = await create("before");
    await fs.writeFile(path.join(repo, attributes), "*.txt text eol=crlf\n");
    await git(repo, "add", attributes);
    await git(repo, "commit", "-m", "checkout attributes");
    const next = await create("after");
    expect(await read(first.path, "nested/file.txt")).toBe("line\n");
    expect(await read(next.path, "nested/file.txt")).toBe("line\r\n");
    expect(await git(next.path, "status", "--porcelain")).toBe("");
    expect(backend.createTemplate).toHaveBeenCalledTimes(2);
  },
);
