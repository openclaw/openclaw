import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import {
  createDeferred,
  awaitGateBeforeSettlement,
  withinTest,
} from "../../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { prepareSessionWorktree } from "../../gateway/session-worktree-preparation.js";
import { prewarmLocalWorkspaceTemplates } from "../../gateway/worker-environments/local-workspace-prewarm.js";
import { withDiagnosticsTimelineObserver } from "../../infra/diagnostics-timeline.js";
import { resolveSandboxConfigForAgent } from "../sandbox/config.js";
import { DOCKER_SANDBOX_ENGINE } from "../sandbox/container-engine.js";
import * as dependencies from "../sandbox/dependency-template.js";
import { prepareLocalSandboxWorkspace } from "../sandbox/local-workspace.js";
import { observeWorktreeBase, resolveWorktreeBase } from "./base-ref.js";
import { detectWorktreeFilesystemBackend } from "./filesystem-backend.js";
import { createCopyWorktreeBackend } from "./filesystem-backend.test-support.js";
import { withWorktreePreparationTiming } from "./preparation-timing.js";
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
  const config: OpenClawConfig = {};
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
    config,
    advance,
    pass,
    create,
    tick: (ms: number) => {
      now += ms;
    },
  };
}

async function sandboxFixture() {
  const f = await fixture();
  f.config.agents = {
    defaults: { sandbox: { mode: "all" } },
    entries: { main: { workspace: f.repo } },
  };
  await fs.writeFile(path.join(f.repo, "package.json"), '{"name":"fixture","private":true}\n');
  await fs.writeFile(path.join(f.repo, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  await fs.writeFile(path.join(f.repo, ".gitignore"), "node_modules/\n");
  await git(f.repo, "add", ".");
  await git(f.repo, "commit", "-m", "sandbox dependency inputs");
  await git(f.repo, "push", "origin", "main");
  const sandbox = resolveSandboxConfigForAgent(f.config, "main");
  // Synthetic guest identity and install output; Git, projection, state and template owners are real.
  vi.spyOn(dependencies, "resolveSandboxDependencyTemplateIdentity").mockResolvedValue({
    key: "synthetic-guest-image",
    image: "synthetic-image",
    docker: sandbox.docker,
    engine: DOCKER_SANDBOX_ENGINE,
  });
  const install = vi
    .spyOn(dependencies, "prepareSandboxDependencyTemplate")
    .mockImplementation(async ({ directory }) => {
      await fs.mkdir(path.join(directory, "node_modules"), { recursive: true });
      await fs.writeFile(
        path.join(directory, "node_modules/.modules.yaml"),
        'virtualStoreDir: ".pnpm"\n',
      );
      await fs.writeFile(
        path.join(directory, "node_modules/source-derived.txt"),
        await fs.readFile(path.join(directory, "README.md")),
      );
      return { installed: true };
    });
  const create = async (name: string) => {
    const sessionKey = `agent:main:prewarm-${name}`;
    const worktree = await f.service.create({
      repoRoot: f.repo,
      name,
      ownerKind: "session",
      ownerId: sessionKey,
      provisionIgnoredFiles: false,
    });
    await replaceSessionEntry(
      { agentId: "main", sessionKey },
      {
        sessionId: name,
        updatedAt: Date.now(),
        worktree: { id: worktree.id, branch: worktree.branch, repoRoot: worktree.repoRoot },
      },
    );
    return { sessionKey, workspaceDir: worktree.path };
  };
  const send = (session: Awaited<ReturnType<typeof create>>) =>
    withWorktreePreparationTiming("sandbox", () =>
      prepareLocalSandboxWorkspace({ cfg: f.config, agentId: "main", sandbox, ...session }),
    );
  return { ...f, createSession: create, send, install };
}

it.each([false, true])(
  "prepares the advanced default before the next create (sandbox source=%s)",
  async (sourceOnly) => {
    const f = await fixture();
    await f.service.create({ repoRoot: f.repo, name: "first", provisionIgnoredFiles: !sourceOnly });
    const next = await f.advance("advanced\n");
    await f.pass();
    const template = vi.mocked(f.backend.cloneTemplate).mock.lastCall![1];
    expect(await git(template, "rev-parse", "HEAD")).toBe(next);
    // Stale stat data must not let ready-generation validation rewrite its index.
    await fs.utimes(path.join(template, "README.md"), 1, 1);
    const index = path.resolve(template, await git(template, "rev-parse", "--git-path", "index"));
    const indexBefore = await fs.readFile(index);
    const indexStatBefore = await fs.stat(index);
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
    expect(await fs.readFile(index)).toEqual(indexBefore);
    expect((await fs.stat(index)).mtimeMs).toBe(indexStatBefore.mtimeMs);
  },
);

it.each([false, true])(
  "prepares both create and first-send templates at the new tip (prior sandbox use=%s)",
  async (priorSandboxUse) => {
    const f = await sandboxFixture();
    const { createSession: create, send, install } = f;
    const first = await create("a");
    if (priorSandboxUse) {
      using prepared = await send(first);
      expect(prepared).toBeDefined();
    }
    const target = await f.advance("advanced\n");
    const discovered: string[] = [];
    using _ = observeWorktreeBase((repo, commit) => {
      if (repo === f.repo) {
        discovered.push(commit);
      }
    });
    await f.pass(true);
    expect(discovered).toEqual([]);
    await f.pass();
    await f.pass();
    expect(discovered).toEqual([target]);
    const clone = vi.mocked(f.backend.cloneTemplate);
    const built = vi.mocked(f.backend.createTemplate);
    clone.mockClear();
    built.mockClear();
    install.mockClear();
    const second = await create("b");
    expect(await git(second.workspaceDir, "rev-parse", "HEAD")).toBe(target);
    expect(clone).toHaveBeenCalledTimes(1);
    expect(built).not.toHaveBeenCalled();
    clone.mockClear();
    const phases: string[] = [];
    using prepared = await withDiagnosticsTimelineObserver(
      (name) => {
        phases.push(name);
      },
      () => send(second),
    );
    expect(prepared).toBeDefined();
    expect(await git(prepared!.workspaceDir, "rev-parse", "HEAD")).toBe(target);
    expect(await git(prepared!.workspaceDir, "status", "--porcelain")).toBe("");
    expect(await fs.readFile(path.join(prepared!.workspaceDir, "README.md"), "utf8")).toBe(
      "advanced\n",
    );
    expect(
      await fs.readFile(
        path.join(prepared!.workspaceDir, "node_modules/source-derived.txt"),
        "utf8",
      ),
    ).toBe("advanced\n");
    expect(install).not.toHaveBeenCalled();
    expect(built).not.toHaveBeenCalled();
    expect(clone).toHaveBeenCalledTimes(1);
    expect(phases).toContain("worktree.sandbox");
    expect(phases.some((name) => name.endsWith(".snapshot"))).toBe(false);
    // Neither background publication nor a retained sandbox row renews create eligibility.
    discovered.length = 0;
    f.tick(24 * 60 * 60_000);
    await f.pass();
    expect(discovered).toEqual([]);
    expect(install).not.toHaveBeenCalled();
    expect(built).not.toHaveBeenCalled();
  },
);

it.for(["managed", "sandbox"] as const)(
  "starts a session at its retained base during a newer %s refresh",
  async (kind, { signal }) => {
    const f = await sandboxFixture();
    vi.mocked(Date.now).mockRestore();
    await git(f.repo, "remote", "remove", "origin");
    const first = await f.createSession("first");
    const base = await git(first.workspaceDir, "rev-parse", "HEAD");
    // Observe local advances while the idle owner is listening, without skewing
    // the lease worker's real clock to expire the repository's fetch cooldown.
    const pass = () =>
      prewarmLocalWorkspaceTemplates({
        getConfig: () => f.config,
        signal,
        shouldDefer: async () => {
          await resolveWorktreeBase(f.repo);
          return false;
        },
      });
    const advance = async (contents: string) => {
      await fs.writeFile(path.join(f.repo, "README.md"), contents);
      await git(f.repo, "commit", "-am", contents);
    };
    // Publish A without preparing this session's private projection.
    await pass();
    await advance("B\n");
    await pass();
    await advance("C\n");
    const entered = createDeferred();
    const release = createDeferred();
    const clone = vi.mocked(f.backend.cloneTemplate).getMockImplementation()!;
    vi.mocked(f.backend.cloneTemplate).mockImplementation(async (...args) => {
      // Sandbox generations live beside projections; managed generations beside worktrees.
      const sandbox = args[0].includes("worktree-projections");
      if (args[2].idleIoPriority && sandbox === (kind === "sandbox")) {
        entered.resolve();
        await release.promise;
      }
      await clone(...args);
    });
    const refreshing = pass();
    await awaitGateBeforeSettlement(entered.promise, refreshing, "refresh did not start");
    f.install.mockClear();
    const copies = vi.mocked(f.backend.cloneTemplate).mock.calls.length;
    try {
      let workspace: string;
      if (kind === "managed") {
        const prepared = await withinTest(
          prepareSessionWorktree({
            cfg: f.config,
            target: {
              agentId: "main",
              key: "agent:main:retained-send",
              storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
            },
            workspace: f.repo,
            name: "retained-send",
            checkoutCommit: base,
            runSetupScript: false,
            signal,
            waitBudget: { remainingMs: 0 },
          }),
          signal,
        );
        expect(prepared.ok).toBe(true);
        if (!prepared.ok || !prepared.value.sessionRoot) {
          throw new Error("Startup did not prepare the session's accepted base");
        }
        workspace = prepared.value.sessionRoot;
      } else {
        using prepared = await withinTest(f.send(first), signal);
        expect(prepared).toBeDefined();
        workspace = prepared!.workspaceDir;
        expect(
          await fs.readFile(path.join(workspace, "node_modules/source-derived.txt"), "utf8"),
        ).toBe("base\n");
      }
      expect(await git(workspace, "rev-parse", "HEAD")).toBe(base);
      expect(await git(workspace, "status", "--porcelain")).toBe("");
      expect(await fs.readFile(path.join(workspace, "README.md"), "utf8")).toBe("base\n");
      expect(f.install).not.toHaveBeenCalled();
      expect(vi.mocked(f.backend.cloneTemplate).mock.calls.length - copies).toBe(1);
    } finally {
      release.resolve();
      await refreshing;
    }
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
