import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import { addManagedWorktree } from "./checkout.js";
import { detectWorktreeFilesystemBackend } from "./filesystem-backend.js";
import { createCopyWorktreeBackend } from "./filesystem-backend.test-support.js";
import { ManagedWorktreeService } from "./service.js";
import { git, useManagedWorktreeTestRepository } from "./service.test-support.js";
import { useWorktreeStateRoots } from "./state-fixture.test-support.js";
import { collectWorktreeTemplates } from "./template-cache.js";
import { listTemplatesAsync } from "./template-registry-async.js";
import type { WorktreeWarmPoolRequest } from "./template-registry.js";

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

it("takes a ready worktree without paying injected 20-second template latency", async () => {
  const requests: WorktreeWarmPoolRequest[] = [];
  const unsubscribe = service.onWarmPoolNeeded((request) => requests.push(request));
  let elapsed = 0;
  vi.spyOn(performance, "now").mockImplementation(() => elapsed);
  const clone = createCopyWorktreeBackend().cloneTemplate;
  vi.mocked(backend.cloneTemplate).mockImplementation(async (...args) => {
    elapsed += 20_000;
    await clone(...args);
  });
  try {
    // Session creation constructs its own service; maintenance owns a different instance.
    const sessionService = new ManagedWorktreeService({ env, getConfig: () => ({}) });
    const cold = await sessionService.create({
      repoRoot: repo,
      name: "pool-cold",
      baseRef: "HEAD",
    });
    expect(elapsed).toBe(20_000);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.template).not.toHaveProperty("release");
    await service.prewarm(requests[0]!, {});
    const before = elapsed;
    const calls = vi.mocked(backend.cloneTemplate).mock.calls.length;
    const warm = await create("pool-warm");
    // Logical time charges only backend latency; loaded-host Git time is not a latency gate.
    expect(elapsed - before).toBeLessThan(1_000);
    expect(backend.cloneTemplate).toHaveBeenCalledTimes(calls);
    expect(await git(warm.path, "status", "--porcelain")).toBe("");
    expect(await git(warm.path, "write-tree")).toBe(
      await git(cold.path, "rev-parse", "HEAD^{tree}"),
    );
    expect(await read(warm.path, "README.md")).toBe("base\n");
    expect(await git(warm.path, "symbolic-ref", "--short", "HEAD")).toBe(warm.branch);
    // A slot is single-use. An empty pool immediately uses the existing checkout path.
    await create("pool-empty");
    expect(elapsed - before).toBe(20_000);
    await service.prewarm(requests.at(-1)!, {});
    const slots = (await listTemplatesAsync(env)).filter((record) =>
      record.cacheKey.startsWith("warm:"),
    );
    expect(slots).toHaveLength(1);
    const request = requests.at(-1)!;
    const destination = path.join(request.template.worktreeRoot, "pool-canceled");
    let current = true;
    await expect(
      addManagedWorktree({
        env,
        now: Date.now,
        enabled: true,
        repoRoot: repo,
        commonDir: request.template.commonDir,
        worktreeRoot: request.template.worktreeRoot,
        destination,
        base: request.template.sourceCommit,
        commitGuard: () => {
          if (!current) {
            throw new Error("checkout authority withdrawn");
          }
        },
        rollbackGuard: () => {},
        requireSpace: async () => {
          const slot = (await listTemplatesAsync(env)).find(({ id }) => id === slots[0]!.id);
          if (slot?.status === "preparing") {
            current = false;
          }
        },
      }),
    ).rejects.toThrow("checkout authority withdrawn");
    expect(current).toBe(false);
    expect(await read(slots[0]!.path, "README.md")).toBe("base\n");
    await expect(fs.access(destination)).rejects.toMatchObject({ code: "ENOENT" });
    await collectWorktreeTemplates(env, Date.now() + 1, { commitGuard: () => {} });
    expect(await listTemplatesAsync(env)).toEqual([]);
    expect(await git(warm.path, "status", "--porcelain")).toBe("");
  } finally {
    unsubscribe();
  }
});

it("does not consume an unfinished refill, a stale base, or a modified ready slot", async () => {
  const requests: WorktreeWarmPoolRequest[] = [];
  const unsubscribe = service.onWarmPoolNeeded((request) => requests.push(request));
  await create("pool-source");
  const clone = createCopyWorktreeBackend().cloneTemplate;
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  vi.mocked(backend.cloneTemplate).mockImplementationOnce(async (...args) => {
    await clone(...args);
    entered.resolve();
    await resume.promise;
  });
  const refill = service.prewarm(requests.at(-1)!, {});
  try {
    await entered.promise;
    const during = await create("pool-incomplete");
    expect(await git(during.path, "status", "--porcelain")).toBe("");
    expect(backend.cloneTemplate).toHaveBeenCalledTimes(3);
  } finally {
    resume.resolve();
    await refill;
  }
  try {
    await fs.writeFile(path.join(repo, "README.md"), "new base\n");
    await git(repo, "commit", "-am", "advance base");
    const advanced = await create("pool-new-base");
    expect(await read(advanced.path, "README.md")).toBe("new base\n");
    expect(backend.cloneTemplate).toHaveBeenCalledTimes(4);
    await service.prewarm(requests.at(-1)!, {});
    const slot = (await listTemplatesAsync(env)).find((record) =>
      record.cacheKey.startsWith("warm:"),
    )!;
    await fs.writeFile(path.join(slot.path, "README.md"), "changed pool\n");
    const clean = await create("pool-dirty");
    expect(await read(clean.path, "README.md")).toBe("new base\n");
    expect(await git(clean.path, "status", "--porcelain")).toBe("");
    expect(backend.cloneTemplate).toHaveBeenCalledTimes(6);
  } finally {
    unsubscribe();
  }
});

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
