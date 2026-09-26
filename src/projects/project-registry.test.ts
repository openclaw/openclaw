import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
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

afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  tempDirs.cleanup();
});

function git(repo: string, ...args: string[]) {
  return execFileAsync("git", ["-C", repo, ...args]);
}

async function commitFile(repo: string, file: string, content: string) {
  await fs.writeFile(path.join(repo, file), content);
  await git(repo, "add", file);
  await git(repo, "commit", "-m", file);
}

async function initializeRepository(
  root: string,
  name: string,
  objectFormat: "sha1" | "sha256" = "sha1",
): Promise<string> {
  const repo = path.join(root, name);
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
  const options = {
    path: path.join(stateDir, "openclaw.sqlite"),
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
  };
  const project = await registerClonedProjectRegistry({ path: checkout, name, originUrl }, options);
  return { checkout, originUrl, options, project };
}

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("test HTTP server did not bind a TCP port");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: http.Server) {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

describe("project registry", () => {
  it.each([
    "https://github.com/OpenClaw/OpenClaw",
    "git@github.com:OpenClaw/OpenClaw.git",
    "ssh://git@github.com/OpenClaw/OpenClaw.git",
    "ssh://git@github.com:22/OpenClaw/OpenClaw",
  ])("canonicalizes accepted GitHub clone URL %s", (input) => {
    expect(parseProjectGitUrl(input)?.url).toBe("https://github.com/openclaw/openclaw.git");
  });

  it.each([
    "http://github.com/openclaw/openclaw.git",
    "file:///tmp/openclaw.git",
    "ssh://git@github.com:2222/openclaw/openclaw.git",
    "/tmp/openclaw",
    "--upload-pack=touch-pwned",
    "https://token@github.com/openclaw/openclaw.git",
    "https://github.com/openclaw/openclaw.git?config=evil",
    "https://github.com/openclaw/openclaw/extra",
    "git@github.com:../../tmp/openclaw.git",
    "https://github.com/openclaw/openclaw.git --config=evil",
  ])("rejects unsafe project clone URL %s", (input) => {
    expect(parseProjectGitUrl(input)).toBeNull();
  });

  it("lazily ensures the additive table exactly once per database", async () => {
    const root = tempDirs.make("openclaw-project-schema-");
    const options = { path: path.join(root, "state.sqlite") };
    openOpenClawStateDatabase(options);
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    const { DatabaseSync } = requireNodeSqlite();
    const legacy = new DatabaseSync(options.path);
    legacy.exec("DROP TABLE projects;");
    legacy.close();

    const state = openOpenClawStateDatabase(options);
    expect(
      state.db
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'projects'")
        .get(),
    ).toBeUndefined();

    expect(await listProjectRegistry({} as OpenClawConfig, options)).toEqual([
      expect.objectContaining({ id: "workspace:main", source: "workspace" }),
    ]);
    expect(await listProjectRegistry({} as OpenClawConfig, options)).toHaveLength(1);

    const rows = state.db
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'projects'")
      .all();
    expect(rows).toEqual([{ name: "projects" }]);
  });

  it("registers, orders, resolves real paths, deduplicates roots, and removes rows", async () => {
    const root = tempDirs.make("openclaw-project-roundtrip-");
    const repo = await initializeRepository(root, "openclaw");
    const alias = path.join(root, "repo-link");
    await fs.symlink(repo, alias, "dir");
    const options = { path: path.join(root, "state.sqlite") };

    const first = await registerProjectRegistry({ path: alias, name: "OpenClaw" }, options);
    const second = await registerProjectRegistry({ path: repo, name: "OpenClaw" }, options);
    expect(first).toMatchObject({
      id: "openclaw",
      displayName: "OpenClaw",
      repoRoot: repo,
      source: "registered",
    });
    expect(second).toEqual(first);

    const cfg = {
      agents: {
        list: [
          { id: "main", default: true, workspace: "/workspace/zeta" },
          { id: "work", workspace: "/workspace/alpha" },
        ],
      },
    } as OpenClawConfig;
    expect((await listProjectRegistry(cfg, options)).map((project) => project.displayName)).toEqual(
      ["alpha", "OpenClaw", "zeta"],
    );
    const sharedWorkspaceCfg = {
      agents: {
        list: [
          { id: "main", default: true, workspace: repo },
          { id: "work", workspace: repo },
        ],
      },
    } as OpenClawConfig;
    expect(
      (await listProjectRegistry(sharedWorkspaceCfg, options)).map((project) => project.id),
    ).toEqual(["openclaw", "workspace:main", "workspace:work"]);
    expect(await removeProjectRegistry(first, options)).toBe(true);
    expect(await removeProjectRegistry(first, options)).toBe(false);
    expect((await listProjectRegistry(cfg, options)).map((project) => project.id)).not.toContain(
      first.id,
    );
  });

  it.each(["entries", "list"] as const)(
    "bounds %s roster reads while observing workspace edits on the next listing",
    async (shape) => {
      const root = tempDirs.make("openclaw-project-roster-");
      const options = { path: path.join(root, "state.sqlite") };
      const agents = Array.from({ length: 64 }, (_, index) => ({
        id: `agent-${String(index).padStart(2, "0")}`,
        workspace: path.join(root, `workspace-${String(index).padStart(2, "0")}`),
      }));
      const entries = Object.fromEntries(
        agents.map((agent) => [agent.id, { workspace: agent.workspace }]),
      );
      let reads = 0;
      for (const agent of agents) {
        const id = agent.id;
        const entry = entries[id]!;
        Object.defineProperty(
          shape === "entries" ? entries : agent,
          shape === "entries" ? id : "id",
          {
            enumerable: true,
            get: () => {
              reads += 1;
              return shape === "entries" ? entry : id;
            },
          },
        );
      }
      const cfg: OpenClawConfig = {
        agents: shape === "entries" ? { entries } : { list: agents },
      };

      const before = await listProjectRegistry(cfg, options);
      // Listing every workspace must not re-read each preceding agent for every point lookup.
      expect(reads).toBeLessThanOrEqual(agents.length * 4);
      expect(before.map((project) => project.id)).toEqual(
        agents.map((agent) => `workspace:${agent.id}`),
      );
      const editedId = agents[0]!.id;
      const edited = shape === "entries" ? entries[editedId]! : agents[0]!;
      const previousWorkspace = edited.workspace;
      edited.workspace = path.join(root, "changed");
      const after = await listProjectRegistry(cfg, options);
      expect(after.find((project) => project.id === `workspace:${editedId}`)?.repoRoot).toBe(
        edited.workspace,
      );
      expect(before[0]?.repoRoot).toBe(previousWorkspace);
    },
  );

  it("rejects paths outside a git checkout", async () => {
    const root = tempDirs.make("openclaw-project-non-git-");
    await expect(
      registerProjectRegistry({ path: root }, { path: path.join(root, "state.sqlite") }),
    ).rejects.toBeInstanceOf(ProjectCheckoutError);
  });

  it("clones full history after cleaning up a transient failure", async () => {
    const root = tempDirs.make("openclaw-project-clone-");
    const source = await initializeRepository(root, "source");
    await commitFile(source, "second.txt", "second\n");
    const bare = path.join(root, "fixture.git");
    await execFileAsync("git", ["clone", "--bare", "--", source, bare]);
    const target = path.join(root, "managed", "fixture");

    const runCommand = processExec.runCommandWithTimeout;
    const commandSpy = vi.spyOn(processExec, "runCommandWithTimeout");
    commandSpy.mockImplementationOnce(async () => {
      await fs.mkdir(target, { recursive: true });
      await fs.writeFile(path.join(target, "partial-clone"), "incomplete clone\n");
      return {
        code: 128,
        stdout: "",
        stderr: "fatal: unable to access repository: The requested URL returned error: 503",
        signal: null,
        killed: false,
        termination: "exit",
      };
    });
    commandSpy.mockImplementation(runCommand);
    try {
      await cloneProjectCheckout({ url: bare, target });
      expect(commandSpy).toHaveBeenCalledTimes(2);
    } finally {
      commandSpy.mockRestore();
    }

    await expect(fs.stat(path.join(target, "partial-clone"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await fs.readFile(path.join(target, "second.txt"), "utf8")).toBe("second\n");
    const history = await git(target, "rev-list", "--count", "HEAD");
    expect(history.stdout.trim()).toBe("2");
    const originalHead = (await git(target, "rev-parse", "HEAD")).stdout.trim();
    await commitFile(source, "later.txt", "pinned later commit\n");
    const commit = (await git(source, "rev-parse", "HEAD")).stdout.trim();
    await ensureProjectCheckoutCommit({ url: source, target, commit });
    expect((await git(target, "rev-parse", "HEAD")).stdout.trim()).toBe(originalHead);
    expect((await git(target, "show", `${commit}:later.txt`)).stdout).toBe("pinned later commit\n");
    const project = await registerClonedProjectRegistry(
      {
        path: target,
        name: "Fixture",
        originUrl: "https://github.com/acme/fixture.git",
      },
      { path: path.join(root, "state.sqlite") },
    );
    expect(project).toMatchObject({
      source: "cloned",
      originUrl: "https://github.com/acme/fixture.git",
    });
  });

  it.runIf(process.platform !== "win32")(
    "does not run checkout hooks while refreshing managed refs",
    async () => {
      const root = tempDirs.make("openclaw-project-refresh-hooks-");
      const source = await initializeRepository(root, "source");
      const target = path.join(root, "managed", "fixture");
      await cloneProjectCheckout({ url: source, target });
      const marker = path.join(root, "hook-ran");
      const hooks = path.join(target, "git-hooks");
      await fs.mkdir(hooks);
      const hook = path.join(hooks, "reference-transaction");
      await fs.writeFile(hook, `#!/bin/sh\ntouch '${marker}'\n`);
      await fs.chmod(hook, 0o755);
      await git(target, "config", "core.hooksPath", hooks);
      await commitFile(source, "later.txt", "later\n");
      const sourceHead = (await git(source, "rev-parse", "HEAD")).stdout.trim();
      await refreshProjectCheckout({ url: source, target });

      await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await git(target, "rev-parse", "origin/main")).stdout.trim()).toBe(sourceHead);
    },
  );

  it("refreshes a managed SHA-256 checkout with its native object format", async () => {
    const root = tempDirs.make("openclaw-project-refresh-sha256-");
    const source = await initializeRepository(root, "source", "sha256");
    const target = path.join(root, "managed", "fixture");
    await cloneProjectCheckout({ url: source, target });
    await commitFile(source, "later.txt", "later\n");
    const sourceHead = (await git(source, "rev-parse", "HEAD")).stdout.trim();

    await refreshProjectCheckout({ url: source, target });

    expect((await git(target, "rev-parse", "origin/main")).stdout.trim()).toBe(sourceHead);
  });

  it("prunes seeded tracking refs deleted upstream during refresh", async () => {
    const root = tempDirs.make("openclaw-project-refresh-prune-");
    const source = await initializeRepository(root, "source");
    await git(source, "branch", "old");
    const target = path.join(root, "managed", "fixture");
    await cloneProjectCheckout({ url: source, target });
    await git(source, "branch", "-D", "old");
    await git(source, "branch", "new");

    await refreshProjectCheckout({ url: source, target });

    await expect(git(target, "rev-parse", "--verify", "origin/old")).rejects.toMatchObject({
      code: 128,
    });
    await expect(git(target, "rev-parse", "--verify", "origin/new")).resolves.toMatchObject({
      stdout: expect.stringMatching(/^[a-f0-9]{40}\n$/u),
    });
  });

  it("rejects a record-aligned truncated ref inventory before deleting tracking refs", async () => {
    const root = tempDirs.make("openclaw-project-refresh-truncated-refs-");
    const source = await initializeRepository(root, "source");
    const target = path.join(root, "managed", "fixture");
    await cloneProjectCheckout({ url: source, target });
    const commit = (await git(target, "rev-parse", "HEAD")).stdout.trim();
    const refNames = Array.from(
      { length: 2_049 },
      (_, index) => `refs/remotes/origin/${String(index).padStart(65, "0")}`,
    );
    await fs.writeFile(
      path.join(target, ".git", "packed-refs"),
      "# pack-refs with: peeled fully-peeled sorted\n" +
        refNames.map((ref) => `${commit} ${ref}`).join("\n") +
        "\n",
    );

    await expect(refreshProjectCheckout({ url: source, target })).rejects.toThrow(
      "too many managed repository refs",
    );
    await expect(git(target, "rev-parse", "--verify", refNames[0]!)).resolves.toMatchObject({
      stdout: `${commit}\n`,
    });
  });

  it("returns an existing registration for the same canonical remote without cloning", async () => {
    const root = tempDirs.make("openclaw-project-idempotent-");
    const repo = await initializeRepository(root, "existing");
    await git(repo, "remote", "add", "origin", "git@github.com:Acme/Existing.git");
    const options = { path: path.join(root, "state.sqlite"), env: process.env };
    const registered = await registerProjectRegistry({ path: repo, name: "Existing" }, options);

    const added = await materializeProjectClone(
      { cfg: {} as OpenClawConfig, gitUrl: "https://github.com/acme/existing.git" },
      options,
    );

    expect(added).toEqual(registered);
    expect(await listProjectRegistry({} as OpenClawConfig, options)).toHaveLength(2);
  });

  it("serializes an existing cloned-project return with checkout deletion", async () => {
    const { checkout, originUrl, options, project } =
      await createManagedProject("existing-delete-race");
    const deletionReady = createDeferred();
    const releaseDeletion = createDeferred();
    const deletionError = new ProjectCheckoutError("keep the existing checkout");
    const deletion = removeClonedProjectCheckout(
      project,
      async () => {
        deletionReady.resolve();
        await releaseDeletion.promise;
        throw deletionError;
      },
      options,
    );
    await deletionReady.promise;

    let additionSettled = false;
    const addition = materializeProjectClone(
      { cfg: {} as OpenClawConfig, gitUrl: originUrl },
      options,
    ).finally(() => {
      additionSettled = true;
    });
    await Promise.resolve();
    expect(additionSettled).toBe(false);

    releaseDeletion.resolve();
    await expect(deletion).rejects.toBe(deletionError);
    await expect(addition).resolves.toEqual(project);
    await expect(fs.stat(checkout)).resolves.toBeDefined();
  });

  it("serializes registration with the final managed-checkout deletion boundary", async () => {
    const { checkout, options, project } = await createManagedProject("delete-race");
    const deletionReady = createDeferred();
    const releaseDeletion = createDeferred();
    const deletion = removeClonedProjectCheckout(
      project,
      async () => {
        deletionReady.resolve();
        await releaseDeletion.promise;
      },
      options,
    );
    await deletionReady.promise;

    let registrationSettled = false;
    const registration = registerProjectRegistry(
      { path: checkout, name: "Raced registration" },
      options,
    ).then(
      (value) => {
        registrationSettled = true;
        return { value };
      },
      (error: unknown) => {
        registrationSettled = true;
        return { error };
      },
    );
    await Promise.resolve();
    expect(registrationSettled).toBe(false);

    releaseDeletion.resolve();
    await expect(deletion).resolves.toBe(true);
    const registrationResult = await registration;
    expect(registrationResult).toMatchObject({ error: expect.any(ProjectCheckoutError) });
    expect(await listProjectRegistry({} as OpenClawConfig, options)).toEqual([
      expect.objectContaining({ source: "workspace" }),
    ]);
    await expect(fs.stat(checkout)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("ignores checkout URL rewrites while refreshing the recorded project", async () => {
    const root = tempDirs.make("openclaw-project-refresh-rewrite-");
    const source = await initializeRepository(root, "source");
    const checkout = path.join(root, "checkout");
    await execFileAsync("git", ["clone", source, checkout]);
    await git(source, "branch", "expected-base");
    const unrelated = await initializeRepository(root, "unrelated");
    await git(unrelated, "branch", "injected-base");
    const options = { path: path.join(root, "state.sqlite") };
    const project = await registerClonedProjectRegistry(
      { path: checkout, name: "Recorded", originUrl: source },
      options,
    );
    await git(checkout, "config", `url.${unrelated}.insteadOf`, source);

    await expect(refreshProjectClone(project, options)).resolves.toBeUndefined();
    await expect(
      git(checkout, "rev-parse", "--verify", "refs/remotes/origin/expected-base"),
    ).resolves.toBeDefined();
    await expect(
      git(checkout, "rev-parse", "--verify", "refs/remotes/origin/injected-base"),
    ).rejects.toBeDefined();
  });

  it("revokes stale refresh after removal and operator re-registration", async () => {
    const root = tempDirs.make("openclaw-project-refresh-revocation-");
    const source = await initializeRepository(root, "source");
    const checkout = path.join(root, "checkout");
    await execFileAsync("git", ["clone", "--no-local", source, checkout]);
    await commitFile(source, "revoked.txt", "must not fetch\n");
    await git(source, "branch", "revoked-base");
    const revokedCommit = (await git(source, "rev-parse", "revoked-base")).stdout.trim();
    const options = { path: path.join(root, "state.sqlite") };
    const project = await registerClonedProjectRegistry(
      { path: checkout, name: "Revoked", originUrl: source },
      options,
    );
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
    await expect(
      git(checkout, "rev-parse", "--verify", "refs/remotes/origin/revoked-base"),
    ).rejects.toBeDefined();
  });

  it.each(["refresh", "pinned commit"] as const)(
    "stops %s fetching when its persisted checkout lease is lost",
    async (operation) => {
      const root = tempDirs.make("openclaw-project-refresh-lease-loss-");
      const checkout = await initializeRepository(root, "checkout");
      const options = { path: path.join(root, "state.sqlite") };
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
        server.closeAllConnections();
        await closeServer(server);
      }
    },
  );

  it("classifies authentication failures without returning credential material", async () => {
    const token = "github_pat_secret-fixture-value";
    const server = http.createServer((_request, response) => {
      response.writeHead(401, { "WWW-Authenticate": 'Basic realm="Git"' });
      response.end("authentication required");
    });
    const url = `${await listen(server)}/private.git`;
    try {
      const error = await cloneProjectCheckout(
        {
          url,
          target: path.join(tempDirs.make("openclaw-project-auth-"), "private"),
        },
        { token },
      ).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ProjectCloneError);
      expect(error).toMatchObject({ failure: "auth_required" });
      expect((error as Error).message).not.toContain(token);
      expect((error as Error).message).toContain("gateway.controlUi.github.token");
      expect((error as Error).message).toContain("shared Gateway process environment");
    } finally {
      await closeServer(server);
    }
  });
});
