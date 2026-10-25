import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
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
import * as processExec from "../process/exec.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { observe } from "../state/openclaw-state-lease-async.test-support.js";
import { createCommandResult } from "../test-utils/npm-spec-install-test-helpers.js";
import {
  cloneProjectCheckout,
  ensureProjectCheckoutCommit,
  ProjectCloneError,
  refreshProjectCheckout,
} from "./project-clone-runtime.js";
import {
  materializeProjectClone,
  refreshProjectClone,
  removeClonedProjectCheckout,
} from "./project-clone.js";
import { parseProjectGitUrl } from "./project-git-url.js";
import {
  listProjectRegistry,
  ProjectCheckoutError,
  registerProjectRegistry,
  removeProjectRegistry,
} from "./project-registry.js";
import { registerClonedProjectRegistry } from "./project-registry.test-support.js";

const execFileAsync = promisify(execFile);
const tempDirs = createTempDirTracker();
it.each([
  ["https://github.com/openclaw/openclaw.git", "ghe.example.test"],
  ["file:///tmp/openclaw.git"],
  ["ssh://git@github.com:2222/openclaw/openclaw.git"],
  ["/tmp/openclaw"],
  ["--upload-pack=touch-pwned"],
  ["https://token@github.com/openclaw/openclaw.git"],
  ["https://github.com/openclaw/openclaw.git?config=evil"],
  ["https://github.com/openclaw/openclaw/extra"],
  ["git@github.com:../../tmp/openclaw.git"],
  ["https://github.com/openclaw/openclaw.git --config=evil"],
])("rejects unsafe project clone URL %s", (input, host?: string) => {
  expect(parseProjectGitUrl(input, host)).toBeNull();
});

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
    await cloneProjectCheckout({ url: source, target });
    return { source, target };
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
        const project = await registerClonedProjectRegistry(
          { path: target, name: "Legacy clone", originUrl },
          options,
        );
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
    const project = await registerClonedProjectRegistry(
      { path: checkout, name: "Recorded", originUrl: source },
      options,
    );
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
    const project = await registerClonedProjectRegistry(
      { path: checkout, name, originUrl },
      stateOptions,
    );
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
    const repo = await initializeRepository(root, "openclaw");
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

  it("scopes private clone and refresh credentials to the repository origin", async ({
    onTestFinished,
  }) => {
    const checkout = await initializeRepository(root, "checkout");
    const token = "synthetic-project-token";
    const runCommand = processExec.runCommandWithTimeout;
    const commandSpy = vi.spyOn(processExec, "runCommandWithTimeout");
    commandSpy.mockImplementation(async (argv, commandOptions) => {
      if (argv.includes("clone") || argv.includes("fetch")) {
        return createCommandResult();
      }
      return await runCommand(argv, commandOptions);
    });
    onTestFinished(() => commandSpy.mockRestore());
    for (const host of ["ghe.example.test", "github.com"]) {
      await cloneProjectCheckout(
        { url: `https://${host}/acme/repository.git`, target: path.join(root, host) },
        { token },
      );
    }
    await refreshProjectCheckout(
      { target: checkout, url: "https://ghe.example.test/acme/enterprise.git" },
      { token },
    );

    const networkCalls = commandSpy.mock.calls.filter(
      ([argv]) => argv.includes("clone") || argv.includes("fetch"),
    );
    const networkEnvs = networkCalls.map(([, commandOptions]) =>
      typeof commandOptions === "object" ? commandOptions?.env : undefined,
    );
    expect(networkEnvs.map((env) => env?.GIT_CONFIG_KEY_0)).toEqual([
      "http.https://ghe.example.test/.extraHeader",
      "http.https://github.com/.extraHeader",
      "http.https://ghe.example.test/.extraHeader",
    ]);
    expect(networkEnvs.map((env) => env?.GIT_CONFIG_COUNT)).toEqual(["1", "1", "1"]);
    expect(networkCalls.flatMap(([argv]) => argv)).not.toContain(token);
    const unrelatedOrigin = await runCommand(
      [
        "git",
        "config",
        "--get-urlmatch",
        "http.extraHeader",
        "https://unrelated.example/acme/repository.git",
      ],
      { env: networkEnvs[0] },
    );
    expect(unrelatedOrigin).toMatchObject({ code: 1, stdout: "" });
  });

  it.each(["sha256", ...(process.platform !== "win32" ? (["sha1"] as const) : [])] as const)(
    "refreshes managed %s refs (SHA-1 with a forbidden checkout hook)",
    async (format) => {
      const { source, target } = await cloneFixture(format);
      const marker = path.join(root, "hook-ran");
      if (format === "sha1") {
        const hooks = path.join(target, "git-hooks");
        await fs.mkdir(hooks);
        const hook = path.join(hooks, "reference-transaction");
        await fs.writeFile(hook, `#!/bin/sh\ntouch '${marker}'\n`);
        await fs.chmod(hook, 0o755);
        await git(target, "config", "core.hooksPath", hooks);
      }
      const sourceHead = await commitFile(source, "later.txt", "later\n");
      await refreshProjectCheckout({ url: source, target });

      if (format === "sha1") {
        await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
      }
      expect(await gitText(target, "rev-parse", "origin/main")).toBe(sourceHead);
    },
  );

  it("negotiates pinned partial-clone commits and preserves filtering during refresh", async () => {
    const source = await initializeRepository(root, "source");
    await git(source, "config", "uploadpack.allowFilter", "true");
    const target = path.join(root, "partial");
    const url = pathToFileURL(source).href;
    await git(root, "clone", "--filter=blob:none", "--no-checkout", url, target);
    await git(target, "config", `remote.${url}.promisor`, "true");
    await git(target, "config", `remote.${url}.partialclonefilter`, "blob:none");
    const base = await gitText(target, "rev-parse", "HEAD");
    const packs = path.join(target, ".git", "objects", "pack");
    const before = new Set(await fs.readdir(packs));
    const commit = await commitFile(source, "later.txt", "keep this blob lazy\n");

    // A missing pinned SHA must use negotiated transport, not cat-file's lazy
    // fetch of the whole commit ancestry. Caller environment cannot enable it.
    await ensureProjectCheckoutCommit(
      { url, target, commit },
      { env: { ...process.env, GIT_NO_LAZY_FETCH: "0" } },
    );
    const added = (await fs.readdir(packs)).filter(
      (name) => name.endsWith(".idx") && !before.has(name),
    );
    expect(added).toHaveLength(1);
    const indexed = (await git(target, "verify-pack", "-v", path.join(packs, added[0]!))).stdout;
    expect(indexed).toContain(`${commit} commit`);
    expect(indexed).not.toContain(`${base} commit`);
    expect(await gitText(target, "rev-parse", "HEAD")).toBe(base);
    expect(await gitText(target, "cat-file", "-t", commit)).toBe("commit");
    await ensureProjectCheckoutCommit(
      { url, target, commit },
      { env: { ...process.env, GIT_ALLOW_PROTOCOL: "" } },
    );
    const refreshed = await commitFile(source, "refresh.txt", "keep refreshed blobs lazy\n");
    const refreshedBlob = await gitText(source, "rev-parse", "HEAD:refresh.txt");
    await refreshProjectCheckout({ url, target });
    expect(await gitText(target, "rev-parse", "origin/main")).toBe(refreshed);

    await expect(
      execFileAsync("git", ["-C", target, "cat-file", "-e", refreshedBlob], {
        env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_ALLOW_PROTOCOL: "" },
      }),
    ).rejects.toMatchObject({ code: 1 });
    expect((await git(target, "show", `${refreshed}:refresh.txt`)).stdout).toBe(
      "keep refreshed blobs lazy\n",
    );
  });

  it.each(["initial", "fetched"] as const)(
    "refreshes a large complete %s ref inventory and prunes only deleted upstream refs",
    async (inventory) => {
      const { source, target } = await cloneFixture();
      const commit = await gitText(source, "rev-parse", "HEAD");
      const branches = Array.from({ length: 7_850 }, (_, index) => String(index).padStart(65, "0"));
      const writeRefs = (repo: string, prefix: string) =>
        fs.writeFile(
          path.join(repo, ".git", "packed-refs"),
          branches.map((branch) => `${commit} ${prefix}/${branch}\n`).join(""),
        );
      await writeRefs(source, "refs/heads");
      if (inventory === "initial") {
        await writeRefs(target, "refs/remotes/origin");
      }
      await git(target, "update-ref", "refs/remotes/origin/deleted", commit);
      const next = await commitFile(source, "later.txt", "new upstream commit\n");

      await refreshProjectCheckout({ url: source, target });

      expect(await gitText(target, "rev-parse", "origin/main")).toBe(next);
      expect(await gitText(target, "rev-parse", `origin/${branches.at(-1)}`)).toBe(commit);
      await expectRef(target, "origin/deleted").rejects.toMatchObject({ code: 128 });
      expect(await gitText(target, "rev-parse", "HEAD")).toBe(commit);
    },
  );

  it.each(["initial", "fetched"] as const)(
    "rejects a truncated %s ref inventory before deleting tracking refs",
    async (inventory) => {
      const { source, target } = await cloneFixture();
      const commit = await gitText(target, "rev-parse", "HEAD");
      // Each record is 128 bytes, so truncation can leave only complete records.
      const refNames = Array.from(
        { length: 65_537 },
        (_, index) => `refs/remotes/origin/${String(index).padStart(65, "0")}`,
      );
      const packed = path.join(target, ".git", "packed-refs");
      const initialRefs = inventory === "initial" ? refNames : refNames.slice(0, 1);
      const original = initialRefs.map((ref) => `${commit} ${ref}\n`).join("");
      await fs.writeFile(packed, original);
      if (inventory === "fetched") {
        await fs.writeFile(
          path.join(source, ".git", "packed-refs"),
          refNames
            .map((ref) => `${commit} ${ref.replace("refs/remotes/origin/", "refs/heads/")}\n`)
            .join(""),
        );
      }

      await expect(refreshProjectCheckout({ url: source, target })).rejects.toThrow(
        "ref inventory exceeded the 8 MiB refresh limit",
      );
      await expectRef(target, refNames[0]!).resolves.toMatchObject({
        stdout: `${commit}\n`,
      });
      expect(await fs.readFile(packed, "utf8")).toBe(original);
    },
  );

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

  it("ignores checkout URL rewrites while refreshing the recorded project", async () => {
    const { source, checkout, project } = await registeredClone();
    await git(source, "branch", "expected-base");
    const unrelated = await initializeRepository(root, "unrelated");
    await git(unrelated, "branch", "injected-base");
    await git(checkout, "config", `url.${unrelated}.insteadOf`, source);

    await expect(refreshProjectClone(project, options)).resolves.toBeUndefined();
    await expectRef(checkout, "refs/remotes/origin/expected-base").resolves.toBeDefined();
    await expectRef(checkout, "refs/remotes/origin/injected-base").rejects.toBeDefined();
  });

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
      const project = await registerClonedProjectRegistry(
        { path: checkout, name: "Refresh", originUrl },
        options,
      );
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

  it("classifies authentication failures without returning credential material", async ({
    onTestFinished,
  }) => {
    const token = "github_pat_secret-fixture-value";
    const server = http.createServer((_request, response) => {
      response.writeHead(401, { "WWW-Authenticate": 'Basic realm="Git"' });
      response.end("authentication required");
    });
    onTestFinished(() => closeServer(server));
    const url = `${await listen(server)}/private.git`;
    const error = await cloneProjectCheckout(
      { url, target: path.join(root, "private") },
      { token },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProjectCloneError);
    expect(error).toMatchObject({ failure: "auth_required" });
    expect((error as Error).message).not.toContain(token);
    expect((error as Error).message).toContain("gateway.controlUi.github.token");
    expect((error as Error).message).toContain("shared Gateway process environment");
  });
});
