import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeHttpServer as closeServer,
  listenLoopback as listen,
} from "../../test/helpers/gateway-integration-fixtures.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { observe } from "../state/openclaw-state-lease-async.test-support.js";
import { configureProjectCheckoutMaintenance } from "./project-checkout-maintenance.js";
import { removeClonedProjectCheckout } from "./project-clone.js";
import {
  createProjectCloneSourceFixture,
  materializeProjectClone,
  refreshProjectClone,
} from "./project-clone.test-support.js";
import {
  listProjectRegistry,
  ProjectCheckoutError,
  registerProjectRegistry,
  removeProjectRegistry,
} from "./project-registry.js";
import { registerClonedProjectRegistry } from "./project-registry.test-support.js";

const execFileAsync = promisify(execFile);
const tempDirs = createTempDirTracker();
describe("project registry persistence", () => {
  let root: string;
  let options: { path: string };
  const list = (cfg: OpenClawConfig = {}) => listProjectRegistry(cfg, options);

  beforeEach(() => {
    root = tempDirs.make("openclaw-project-");
    options = { path: path.join(root, "state.sqlite") };
  });

  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    tempDirs.cleanup();
  });

  function git(repo: string, ...args: string[]) {
    return execFileAsync("git", ["-C", repo, ...args]);
  }

  async function gitText(repo: string, ...args: string[]) {
    return (await git(repo, ...args)).stdout.trim();
  }

  async function cloneFixture(objectFormat: "sha1" | "sha256" = "sha1") {
    const source = await initializeRepository(root, "source", objectFormat);
    const target = path.join(root, "managed", "fixture");
    await git(root, "clone", source, target);
    await configureProjectCheckoutMaintenance(target, {});
    return { source, target };
  }

  function registerClone(repoRoot: string, originUrl: string, name = "Recorded", state = options) {
    return registerClonedProjectRegistry({ path: repoRoot, name, originUrl }, state);
  }

  it.each(["new", "reused", "refreshed"] as const)(
    "keeps ordinary Git commands in a %s managed clone out of auto-GC",
    async (mode) => {
      const { source, target } = await cloneFixture();
      if (mode !== "new") {
        // Existing clones from before repository-local maintenance ownership.
        await git(target, "config", "maintenance.auto", "true");
        await git(target, "config", "gc.auto", "6700");
        const originUrl = mode === "refreshed" ? source : "https://github.com/example/project.git";
        const project = await registerClone(target, originUrl, "Legacy clone");
        if (mode === "reused") {
          await materializeProjectClone({ cfg: {}, gitUrl: originUrl }, options);
        } else {
          await refreshProjectClone(project, options);
        }
      }
      // Force the pack-count trigger without a large fixture or detached children.
      await git(target, "config", "gc.autoPackLimit", "1");
      await git(target, "config", "gc.autoDetach", "false");
      await git(target, "config", "maintenance.autoDetach", "false");
      await git(target, "config", "user.name", "OpenClaw Tests");
      await git(target, "config", "user.email", "tests@openclaw.invalid");
      for (let index = 0; index < 3; index++) {
        await git(
          target,
          "-c",
          "maintenance.auto=false",
          "commit",
          "--allow-empty",
          "-m",
          `${index}`,
        );
        await git(target, "repack");
      }
      const worktree = path.join(root, "agent-checkout");
      await git(target, "worktree", "add", "-b", "agent", worktree);
      const trace = path.join(root, "agent-git-trace.jsonl");
      const env = {
        ...process.env,
        GIT_CONFIG_PARAMETERS: "",
        GIT_CONFIG_COUNT: "0",
        GIT_TRACE2_EVENT: trace,
        GIT_AUTHOR_NAME: "OpenClaw Tests",
        GIT_AUTHOR_EMAIL: "tests@openclaw.invalid",
        GIT_COMMITTER_NAME: "OpenClaw Tests",
        GIT_COMMITTER_EMAIL: "tests@openclaw.invalid",
      };
      await execFileAsync("git", ["-C", worktree, "commit", "--allow-empty", "-m", "agent"], {
        env,
      });
      await execFileAsync("git", ["-C", worktree, "fetch", "origin"], { env });
      const events = (await fs.readFile(trace, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { event: string; argv?: string[] });
      const children = events.filter((event) => event.event === "child_start");
      expect(
        children.some(({ argv }) =>
          argv?.some((arg) => /^(maintenance|gc|repack|pack-objects)$/.test(arg)),
        ),
      ).toBe(false);
      expect(await gitText(worktree, "config", "--local", "--get", "maintenance.auto")).toBe(
        "false",
      );
      expect(await gitText(worktree, "config", "--local", "--get", "gc.auto")).toBe("0");
    },
  );

  function workspaceConfig(workspaces: Record<string, string>): OpenClawConfig {
    return {
      agents: {
        entries: Object.fromEntries(
          Object.entries(workspaces).map(([id, workspace]) => [id, { workspace }]),
        ),
      },
    };
  }

  it("preserves operator Git policy when reusing a registered repository", async () => {
    const repo = await initializeRepository(root, "operator");
    const originUrl = "https://github.com/example/operator.git";
    await git(repo, "remote", "add", "origin", originUrl);
    await git(repo, "config", "maintenance.auto", "true");
    await git(repo, "config", "gc.auto", "1234");
    await registerProjectRegistry({ path: repo }, options);
    await materializeProjectClone({ cfg: {}, gitUrl: originUrl }, options);
    expect(await gitText(repo, "config", "--local", "--get", "maintenance.auto")).toBe("true");
    expect(await gitText(repo, "config", "--local", "--get", "gc.auto")).toBe("1234");
  });

  async function commitFile(repo: string, file: string, content: string) {
    await fs.writeFile(path.join(repo, file), content);
    await git(repo, "add", file);
    await git(repo, "commit", "-m", file);
    return gitText(repo, "rev-parse", "HEAD");
  }

  function expectRef(repo: string, ref: string) {
    return expect(git(repo, "rev-parse", "--verify", ref));
  }

  async function registeredClone(noLocal = false) {
    const source = await initializeRepository(root, "source");
    const checkout = path.join(root, "checkout");
    await git(root, "clone", ...(noLocal ? ["--no-local"] : []), source, checkout);
    const project = await registerClone(checkout, source);
    return { source, checkout, project };
  }

  async function initializeRepository(
    parent: string,
    name: string,
    objectFormat: "sha1" | "sha256" = "sha1",
  ): Promise<string> {
    const repo = path.join(parent, name);
    await fs.mkdir(repo, { recursive: true });
    await execFileAsync("git", ["init", "-b", "main", `--object-format=${objectFormat}`, repo]);
    await git(repo, "config", "user.name", "OpenClaw Tests");
    await git(repo, "config", "user.email", "tests@openclaw.invalid");
    await commitFile(repo, "README.md", `${name}\n`);
    return await fs.realpath(repo);
  }

  async function createManagedProject(name: string) {
    const stateDir = tempDirs.make("openclaw-project-delete-race-");
    const originUrl = `https://github.com/acme/${name}.git`;
    const checkout = await initializeRepository(
      path.join(stateDir, "projects", "0123456789abcdef"),
      name,
    );
    const stateOptions = {
      path: path.join(stateDir, "openclaw.sqlite"),
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    };
    const project = await registerClone(checkout, originUrl, name, stateOptions);
    return { checkout, originUrl, options: stateOptions, project };
  }

  it("leaves an absent registry empty until registration installs its table", async () => {
    openOpenClawStateDatabase(options);
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    await fs.rename(options.path, `${options.path}.template`);
    await fs.copyFile(`${options.path}.template`, options.path, fs.constants.COPYFILE_EXCL);
    const { DatabaseSync } = requireNodeSqlite();
    const legacy = new DatabaseSync(options.path);
    legacy.exec("DROP TABLE projects;");
    legacy.close();

    const state = openOpenClawStateDatabase(options);
    const table = state.db.prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'projects'",
    );
    expect(table.get()).toBeUndefined();

    expect(await list()).toEqual([
      expect.objectContaining({ id: "workspace:main", source: "workspace" }),
    ]);

    expect(table.get()).toBeUndefined();
    const repo = await initializeRepository(root, "registered");
    const registered = await registerProjectRegistry({ path: repo }, options);
    expect(await list()).toContainEqual(registered);

    expect(table.all()).toEqual([{ name: "projects" }]);
  });

  it("registers, orders, resolves real paths, deduplicates roots, and removes rows", async () => {
    const repo = await initializeRepository(root, "openclaw ");
    const alias = path.join(root, "repo-link");
    await fs.symlink(repo, alias, "dir");

    const first = await registerProjectRegistry({ path: alias, name: "OpenClaw" }, options);
    const second = await registerProjectRegistry({ path: repo, name: "OpenClaw" }, options);
    expect(first).toMatchObject({
      id: "openclaw",
      displayName: "OpenClaw",
      repoRoot: repo,
      source: "registered",
    });
    expect(second).toEqual(first);

    const cfg = workspaceConfig({ main: "/workspace/zeta", work: "/workspace/alpha" });
    expect((await list(cfg)).map((project) => project.displayName)).toEqual([
      "alpha",
      "OpenClaw",
      "zeta",
    ]);
    const sharedWorkspaceCfg = workspaceConfig({ main: repo, work: repo });
    expect((await list(sharedWorkspaceCfg)).map((project) => project.id)).toEqual([
      "openclaw",
      "workspace:main",
      "workspace:work",
    ]);
    expect(await removeProjectRegistry(first, options)).toBe(true);
    expect(await removeProjectRegistry(first, options)).toBe(false);
    expect((await list(cfg)).map((project) => project.id)).not.toContain(first.id);
  });

  it("bounds canonical roster reads while observing workspace edits on the next listing", async () => {
    const ids = Array.from({ length: 64 }, (_, index) => `agent-${String(index).padStart(2, "0")}`);
    const entries = Object.fromEntries(ids.map((id) => [id, { workspace: path.join(root, id) }]));
    let reads = 0;
    for (const [id, entry] of Object.entries(entries)) {
      Object.defineProperty(entries, id, {
        enumerable: true,
        get: () => {
          reads += 1;
          return entry;
        },
      });
    }
    const cfg: OpenClawConfig = { agents: { entries } };
    const before = await list(cfg);
    // Listing every workspace must not re-read each preceding agent for every point lookup.
    expect(reads).toBeLessThanOrEqual(ids.length * 4);
    expect(before.map((project) => project.id)).toEqual(ids.map((id) => `workspace:${id}`));
    const editedId = ids[0]!;
    const edited = entries[editedId]!;
    const previousWorkspace = edited.workspace;
    edited.workspace = path.join(root, "changed");
    const after = await list(cfg);
    expect(after.find((project) => project.id === `workspace:${editedId}`)?.repoRoot).toBe(
      edited.workspace,
    );
    expect(before[0]?.repoRoot).toBe(previousWorkspace);
  });

  it("rejects paths outside a git checkout", async () => {
    await expect(registerProjectRegistry({ path: root }, options)).rejects.toBeInstanceOf(
      ProjectCheckoutError,
    );
  });

  it("keeps generic source transport inside the existing managed clone and registry owner", async () => {
    const { source } = await cloneFixture();
    const url = "https://git.example/team/project.git";
    const local = createProjectCloneSourceFixture();
    const transport = {
      ...local,
      resolveUrl: (candidate: string) =>
        candidate === url ? { url, name: "source-project" } : null,
      invalidUrlMessage: "Select this source's repository URL",
      clone: (
        input: Parameters<typeof local.clone>[0],
        selected: Parameters<typeof local.clone>[1],
      ) => local.clone({ ...input, url: source }, selected),
      ensureCommit: (
        input: Parameters<typeof local.ensureCommit>[0],
        selected: Parameters<typeof local.ensureCommit>[1],
      ) => local.ensureCommit({ ...input, url: source }, selected),
      refresh: (
        input: Parameters<typeof local.refresh>[0],
        selected: Parameters<typeof local.refresh>[1],
      ) => local.refresh({ ...input, url: source }, selected),
    };
    const selected = { ...options, env: { ...process.env, OPENCLAW_STATE_DIR: root } };
    const project = await materializeProjectClone({ cfg: {}, gitUrl: url }, selected, transport);

    expect(project).toMatchObject({ originUrl: url, source: "cloned" });
    expect(
      (await listProjectRegistry({}, selected)).find((candidate) => candidate.id === project.id),
    ).toEqual(project);
    expect(await gitText(project.repoRoot, "rev-parse", "HEAD")).toBe(
      await gitText(source, "rev-parse", "HEAD"),
    );
    expect(await materializeProjectClone({ cfg: {}, gitUrl: url }, selected, transport)).toEqual(
      project,
    );
    await expect(materializeProjectClone({ cfg: {}, gitUrl: url }, selected)).rejects.toThrow(
      "GitHub",
    );
  });

  it.each(["existing clone", "registration"] as const)(
    "serializes %s with checkout deletion",
    async (operation) => {
      const existing = operation === "existing clone";
      const fixture = await createManagedProject("delete-race");
      const { checkout, originUrl, options: stateOptions, project } = fixture;
      const deletionError = new ProjectCheckoutError("keep the existing checkout");
      const ready = createDeferred();
      const release = createDeferred();
      const deletion = removeClonedProjectCheckout(
        project,
        async () => {
          ready.resolve();
          await release.promise;
          if (existing) {
            throw deletionError;
          }
        },
        stateOptions,
      );
      await ready.promise;
      const pending = observe(
        existing
          ? materializeProjectClone({ cfg: {}, gitUrl: originUrl }, stateOptions)
          : registerProjectRegistry({ path: checkout, name: "Raced registration" }, stateOptions),
      );
      await Promise.resolve();
      expect(pending.settled()).toBe(false);
      release.resolve();
      if (existing) {
        await expect(deletion).rejects.toBe(deletionError);
        await expect(pending.outcome).resolves.toEqual({ ok: true, value: project });
        await expect(fs.stat(checkout)).resolves.toBeDefined();
        return;
      }
      await expect(deletion).resolves.toBe(true);
      await expect(pending.outcome).resolves.toMatchObject({
        error: expect.any(ProjectCheckoutError),
      });
      expect(await listProjectRegistry({} as OpenClawConfig, stateOptions)).toEqual([
        expect.objectContaining({ source: "workspace" }),
      ]);
      await expect(fs.stat(checkout)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("revokes stale refresh after removal and operator re-registration", async () => {
    const { source, checkout, project } = await registeredClone(true);
    const revokedCommit = await commitFile(source, "revoked.txt", "must not fetch\n");
    await git(source, "branch", "revoked-base");
    await expect(removeProjectRegistry(project, options)).resolves.toBe(true);
    await expect(
      registerProjectRegistry({ path: checkout, name: "Operator" }, options),
    ).resolves.toMatchObject({ source: "registered" });

    await expect(refreshProjectClone(project, options)).rejects.toMatchObject({
      failure: "clone_failed",
    });
    await expect(
      git(checkout, "cat-file", "-e", `${revokedCommit}^{commit}`),
    ).rejects.toBeDefined();
    await expectRef(checkout, "refs/remotes/origin/revoked-base").rejects.toBeDefined();
  });

  it.each(["refresh", "pinned commit"] as const)(
    "stops %s fetching when its persisted checkout lease is lost",
    async (operation) => {
      const checkout = await initializeRepository(root, "checkout");
      const requested = createDeferred();
      let connectionClosed = false;
      const server = http.createServer((_request, response) => {
        response.on("close", () => {
          connectionClosed = true;
        });
        requested.resolve();
        // Hold the transport open: only cancellation, not a successful fetch, can finish.
      });
      const fixtureUrl = `${await listen(server)}/fixture.git`;
      await git(checkout, "remote", "add", "origin", fixtureUrl);
      const originUrl =
        operation === "refresh" ? fixtureUrl : "https://github.com/acme/refresh.git";
      const project = await registerClone(checkout, originUrl, "Refresh");
      if (operation === "pinned commit") {
        await git(
          checkout,
          "config",
          `url.${fixtureUrl}.insteadOf`,
          "https://github.com/acme/refresh.git",
        );
      }
      const controller = new AbortController();
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      const fetchOptions = { ...options, signal: controller.signal, timeoutMs: 5000 };
      const refresh = (
        operation === "refresh"
          ? refreshProjectClone(project, fetchOptions)
          : materializeProjectClone(
              {
                cfg: {} as OpenClawConfig,
                gitUrl: "https://github.com/acme/refresh.git",
                requiredCommit: "f".repeat(40),
              },
              fetchOptions,
            )
      ).catch((error: unknown) => error);
      try {
        await requested.promise;
        const { db } = openOpenClawStateDatabase(options);
        expect(
          db
            .prepare("DELETE FROM state_leases WHERE scope = ? AND lease_key = ?")
            .run("projects.checkout", checkout).changes,
        ).toBe(1);
        await vi.advanceTimersByTimeAsync(10_000);
        await expect.poll(() => connectionClosed, { timeout: 1000 }).toBe(true);
        expect(await refresh).toMatchObject({ code: "OPENCLAW_STATE_LEASE_LOST" });
      } finally {
        controller.abort();
        await refresh;
        vi.useRealTimers();
        await closeServer(server);
      }
    },
  );
});
