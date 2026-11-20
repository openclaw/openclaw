import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { createDeferred, awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { prewarmLocalWorkspaceTemplates } from "../../gateway/worker-environments/local-workspace-prewarm.js";
import { observeWorktreeBase, resolveWorktreeBase } from "./base-ref.js";
import { detectWorktreeFilesystemBackend } from "./filesystem-backend.js";
import { createCopyWorktreeBackend } from "./filesystem-backend.test-support.js";
import { ManagedWorktreeService } from "./service.js";
import { git, useManagedWorktreeTestRepository } from "./service.test-support.js";
import { useWorktreeStateRoots } from "./state-fixture.test-support.js";
import * as registry from "./template-registry-async.js";

// mock-isolation: real Git, state, leases and scheduling; portable filesystem clone backend.
vi.mock("./filesystem-backend.js", () => ({ detectWorktreeFilesystemBackend: vi.fn() }));
const initializeRepository = useManagedWorktreeTestRepository();
const roots = useWorktreeStateRoots();

async function fixture() {
  const root = roots.make("openclaw-template-prewarm-");
  const repo = await initializeRepository(root);
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  vi.stubEnv("GIT_ATTR_NOSYSTEM", "1");
  await git(repo, "config", "maintenance.auto", "false");
  await git(repo, "config", "gc.auto", "0");
  const config = {};
  setRuntimeConfigSnapshot(config, config);
  const backend = createCopyWorktreeBackend();
  vi.mocked(detectWorktreeFilesystemBackend).mockResolvedValue(backend);
  const service = new ManagedWorktreeService({ getConfig: () => config });
  let now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const advance = async (contents: string) => {
    await fs.writeFile(path.join(repo, "README.md"), contents);
    await git(repo, "commit", "-am", contents);
    await git(repo, "push", "origin", "main");
    now += 31_000;
    return git(repo, "rev-parse", "HEAD");
  };
  const pass = (defer = false) =>
    prewarmLocalWorkspaceTemplates({
      getConfig: () => config,
      signal: new AbortController().signal,
      shouldDefer: async () => defer,
    });
  const create = (name: string) => service.create({ repoRoot: repo, name });
  return {
    root,
    repo,
    backend,
    service,
    advance,
    pass,
    create,
    tick: (ms: number) => {
      now += ms;
    },
  };
}

it.each([false, true])(
  "prepares the advanced default before the next create (sandbox source=%s)",
  async (sourceOnly) => {
    const f = await fixture();
    await f.service.create({ repoRoot: f.repo, name: "first", provisionIgnoredFiles: !sourceOnly });
    const next = await f.advance("advanced\n");
    await f.pass();
    const before = vi.mocked(f.backend.cloneTemplate).mock.calls.length;
    const second = await f.service.create({
      repoRoot: f.repo,
      name: "second",
      provisionIgnoredFiles: !sourceOnly,
    });
    expect(await git(second.path, "rev-parse", "HEAD")).toBe(next);
    expect(await fs.readFile(path.join(second.path, "README.md"), "utf8")).toBe("advanced\n");
    expect(await git(second.path, "status", "--porcelain")).toBe("");
    expect(vi.mocked(f.backend.cloneTemplate).mock.calls.length - before).toBe(1);
  },
);

it("joins the background generation when a create arrives during its build", async () => {
  const f = await fixture();
  await f.create("first");
  const target = await f.advance("next\n");
  const entered = createDeferred();
  const release = createDeferred();
  const clone = vi.mocked(f.backend.cloneTemplate).getMockImplementation()!;
  vi.mocked(f.backend.cloneTemplate).mockImplementationOnce(async (...args) => {
    expect(args[2].idleIoPriority).toBe(true);
    entered.resolve();
    await release.promise;
    await clone(...args);
  });
  // Keep the real implementation; observe the reader miss while publication is held.
  const attempted = createDeferred();
  const retain = registry.retainTemplateReaderAsync;
  const pass = f.pass();
  await awaitGateBeforeSettlement(entered.promise, pass, "background clone did not start");
  vi.spyOn(registry, "retainTemplateReaderAsync").mockImplementation(async (...args) => {
    const result = await retain(...args);
    if ("selection" in args[1] && !result) {
      attempted.resolve();
    }
    return result;
  });
  const before = vi.mocked(f.backend.cloneTemplate).mock.calls.length;
  const creating = f.create("joining");
  try {
    await awaitGateBeforeSettlement(attempted.promise, creating, "create did not join publication");
    expect(vi.mocked(f.backend.cloneTemplate).mock.calls.length).toBe(before);
  } finally {
    release.resolve();
  }
  const [, created] = await Promise.all([pass, creating]);
  expect(await git(created.path, "rev-parse", "HEAD")).toBe(target);
  expect(vi.mocked(f.backend.cloneTemplate).mock.calls.length - before).toBe(1);
  expect(vi.mocked(f.backend.cloneTemplate).mock.lastCall?.[2].idleIoPriority).not.toBe(true);
});

it("rebuilds unchanged files when checkout policy changes before background preparation", async () => {
  const f = await fixture();
  await git(f.repo, "config", "core.autocrlf", "false");
  await fs.writeFile(path.join(f.repo, "unchanged.txt"), "unchanged\n");
  await git(f.repo, "add", "unchanged.txt");
  await git(f.repo, "commit", "-m", "unchanged file");
  await git(f.repo, "push", "origin", "main");
  const first = await f.create("first");
  expect(await fs.readFile(path.join(first.path, "unchanged.txt"), "utf8")).toBe("unchanged\n");
  await git(f.repo, "config", "core.autocrlf", "true");
  const target = await f.advance("changed\n");
  await f.pass();
  const before = vi.mocked(f.backend.cloneTemplate).mock.calls.length;
  const second = await f.create("second");
  expect(await git(second.path, "rev-parse", "HEAD")).toBe(target);
  expect(await fs.readFile(path.join(second.path, "unchanged.txt"), "utf8")).toBe("unchanged\r\n");
  expect(await fs.readFile(path.join(second.path, "README.md"), "utf8")).toBe("changed\r\n");
  expect(await git(second.path, "status", "--porcelain")).toBe("");
  expect(vi.mocked(f.backend.cloneTemplate).mock.calls.length - before).toBe(1);
});

it("coalesces observed advances while a generation is building", async () => {
  const f = await fixture();
  await git(f.repo, "remote", "remove", "origin");
  await f.create("first");
  const advanceLocal = async (contents: string) => {
    await fs.writeFile(path.join(f.repo, "README.md"), contents);
    await git(f.repo, "commit", "-am", contents);
    return (await resolveWorktreeBase(f.repo)).commit;
  };
  const b = await advanceLocal("B\n");
  const entered = createDeferred();
  const release = createDeferred();
  const clone = vi.mocked(f.backend.cloneTemplate).getMockImplementation()!;
  vi.mocked(f.backend.cloneTemplate).mockImplementationOnce(async (...args) => {
    entered.resolve();
    await release.promise;
    await clone(...args);
  });
  const pass = f.pass();
  await awaitGateBeforeSettlement(entered.promise, pass, "background clone did not start");
  const c = await advanceLocal("C\n");
  const d = await advanceLocal("D\n");
  release.resolve();
  await pass;
  const commits = (await registry.listTemplatesAsync(process.env)).map((row) => row.sourceCommit);
  expect(commits).toContain(b);
  expect(commits).toContain(d);
  expect(commits).not.toContain(c);
  const before = vi.mocked(f.backend.cloneTemplate).mock.calls.length;
  expect(await git((await f.create("latest")).path, "rev-parse", "HEAD")).toBe(d);
  expect(vi.mocked(f.backend.cloneTemplate).mock.calls.length - before).toBe(1);
});

it("bounds discovery to recent successful creates, idle admission and a repository cooldown", async () => {
  const f = await fixture();
  const observed: string[] = [];
  using _ = observeWorktreeBase((repo, commit) => {
    if (repo === f.repo) {
      observed.push(commit);
    }
  });
  await f.pass();
  expect(observed).toEqual([]);
  await f.create("first");
  observed.length = 0;
  const state = process.env.OPENCLAW_STATE_DIR;
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(f.root, "other-state"));
  await f.pass();
  expect(observed).toEqual([]);
  vi.stubEnv("OPENCLAW_STATE_DIR", state);
  await f.service.create({ repoRoot: f.repo, name: "sandbox", provisionIgnoredFiles: false });
  const b = await f.advance("B\n");
  await f.pass(true);
  expect(observed).toEqual([]);
  await f.pass();
  expect(observed).toEqual([b]);
  const c = await f.advance("C\n");
  await f.pass();
  expect(observed).toEqual([b]);
  f.tick(90_000);
  await f.pass();
  expect(observed).toEqual([b, c]);
  await f.advance("D\n");
  f.tick(24 * 60 * 60_000);
  await f.pass();
  expect(observed).toEqual([b, c]);
});
