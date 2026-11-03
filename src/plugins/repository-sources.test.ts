import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";
import { createContext } from "../gateway/server-plugin-in-process-dispatch.test-support.js";
import { createManagedProjectCheckoutV1 } from "../plugin-sdk/repository-sources.js";
import { withTempHomeCore as withTempHome } from "../plugin-sdk/test-helpers/temp-home.js";
import { listProjectRegistry } from "../projects/project-registry.js";
import { createRepositorySourceFixture } from "./repository-source.test-support.js";
import { resolvePluginRepositorySource } from "./repository-sources.js";
import { bindGatewayContextResolver } from "./runtime/gateway-request-scope.js";

const url = "https://git.example/team/project.git";

it("admits only the manifest-owned source and retires retained checkout callbacks", async () => {
  const resolveBase = vi.fn(async () => ({ commit: "a".repeat(40), ref: "origin/main" }));
  const display = { identity: "team/subgroup/project", host: "git.example" };
  const fixture = createRepositorySourceFixture({
    id: "remote",
    resolve: (candidate) => (candidate === url ? { url, name: "project", display } : undefined),
    async prepare({ assertCurrent }) {
      assertCurrent();
      return {
        project: { id: "example-project", repoRoot: "/synthetic/project", source: "registered" },
        assertCurrent() {},
        resolveBase,
      };
    },
  });
  fixture.api.registerRepositorySource({
    id: "undeclared",
    resolve: () => undefined,
    prepare: async () => {
      throw new Error("must not run");
    },
  });
  expect(fixture.registry.repositorySources).toHaveLength(1);
  expect(fixture.registry.diagnostics).toContainEqual(
    expect.objectContaining({ message: expect.stringContaining("declared ID") }),
  );
  const source = resolvePluginRepositorySource(fixture.id, url, fixture.registry);
  expect(source.display).toEqual({ identity: "team/subgroup/project", host: "git.example" });
  display.identity = "team/renamed/project";
  expect(source.display?.identity).toBe("team/subgroup/project");
  const prepared = await source.prepare({ agentId: "main", assertCurrent() {} });
  await prepared.resolveBase();
  expect(resolveBase).toHaveBeenCalledTimes(1);
  expect(() => resolvePluginRepositorySource("other/remote", url, fixture.registry)).toThrow(
    "unavailable",
  );
  expect(() =>
    resolvePluginRepositorySource(fixture.id, "file:///private", fixture.registry),
  ).toThrow("supported repository URL");
  await fixture.instance.dispose();
  expect(() => source.assertCurrent()).toThrow("reloaded or disabled");
  await expect(prepared.resolveBase()).rejects.toThrow("reloaded or disabled");
  expect(resolveBase).toHaveBeenCalledTimes(1);
});

it("keeps plugin clones, registration and refresh with the managed checkout owner", async () => {
  await withTempHome(async (home) => {
    const git = promisify(execFile);
    const remote = path.join(home, "source");
    await fs.mkdir(remote);
    await git("git", ["init", "-b", "main", remote]);
    await git("git", [
      "-C",
      remote,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--allow-empty",
      "-m",
      "Fixture",
    ]);
    const commit = (await git("git", ["-C", remote, "rev-parse", "HEAD"])).stdout.trim();
    const clone = vi.fn(
      async (input: { target: string }, options: { assertCurrent?: () => void }) => {
        options.assertCurrent?.();
        await git("git", ["clone", "--no-local", remote, input.target]);
        options.assertCurrent?.();
      },
    );
    const refresh = vi.fn(
      async (input: { target: string }, options: { assertCurrent?: () => void }) => {
        options.assertCurrent?.();
        await git("git", ["-C", input.target, "fetch", remote, "main"]);
        options.assertCurrent?.();
      },
    );
    const checkout = createManagedProjectCheckoutV1({
      resolveUrl: (candidate) => (candidate === url ? { url, name: "project" } : null),
      invalidUrlMessage: "Select the fixture source",
      clone,
      ensureCommit: async (input, options) => {
        options.assertCurrent?.();
        await git("git", ["-C", input.target, "cat-file", "-e", `${input.commit}^{commit}`]);
        options.assertCurrent?.();
      },
      refresh,
      async resolveBase(input, options) {
        await refresh(input, options);
        return { commit, ref: "origin/main" };
      },
    });
    const fixture = createRepositorySourceFixture({
      id: "remote",
      resolve: (candidate) => (candidate === url ? { url, name: "project" } : undefined),
      async prepare(input) {
        const project = await checkout.materialize(
          { gitUrl: input.url, requiredCommit: input.requiredCommit },
          input,
        );
        return {
          project,
          assertCurrent: input.assertCurrent,
          resolveBase: (ref) => checkout.resolveBase(project, ref, input),
        };
      },
    });
    const config = { agents: { entries: { main: { workspace: path.join(home, "workspace") } } } };
    const context = createContext([], () => config);
    bindGatewayContextResolver(fixture.registry, () => context);
    await fixture.run(async () => {
      const source = resolvePluginRepositorySource(fixture.id, url);
      const prepared = await source.prepare({
        agentId: "main",
        requiredCommit: commit,
        assertCurrent() {},
      });
      expect(prepared.project.repoRoot).toContain(path.join(home, ".openclaw", "projects"));
      expect(await listProjectRegistry(config)).toContainEqual(
        expect.objectContaining({ id: prepared.project.id, originUrl: url }),
      );
      expect(
        (await source.prepare({ agentId: "main", requiredCommit: commit, assertCurrent() {} }))
          .project.id,
      ).toBe(prepared.project.id);
      expect(clone).toHaveBeenCalledTimes(1);
      await prepared.resolveBase();
      expect(refresh).toHaveBeenCalledTimes(1);
      await fixture.instance.dispose();
      await expect(prepared.resolveBase()).rejects.toThrow("reloaded or disabled");
      expect(refresh).toHaveBeenCalledTimes(1);
    });
  });
});

it("binds worker reads and restoration to the initiating source authority", async () => {
  let current = true;
  const assertCurrent = () => {
    if (!current) {
      throw new Error("Repository caller retired");
    }
  };
  const fixture = createRepositorySourceFixture({
    id: "remote",
    resolve: (candidate) => (candidate === url ? { url, name: "project" } : undefined),
    async prepare() {
      throw new Error("No local checkout");
    },
    worker: {
      async restore() {
        return {
          project: { id: "restored", repoRoot: "/synthetic/project", source: "registered" },
          assertCurrent() {},
          readRemoteHead: async () => "a".repeat(40),
        };
      },
      async prepare() {
        return {
          repositoryId: "repository_fixture",
          identityKey: "selected-reader",
          baseCommit: "a".repeat(40),
          tree: "b".repeat(40),
          assertCurrent() {},
          confirmAdmission: async () => {},
          revalidate: async () => {},
          readTree: async () => {
            current = false;
            return [];
          },
          readBlob: async () => "",
        };
      },
      async checkout() {},
    },
  });
  const source = resolvePluginRepositorySource(fixture.id, url, fixture.registry);
  const restored = await source.restoreWorker({
    agentId: "main",
    requiredCommit: "a".repeat(40),
    assertCurrent,
  });
  const prepared = await source.prepareWorker({ agentId: "main", assertCurrent });
  expect(prepared.prepareGitPack).toBeUndefined();
  await expect(prepared.readTree("b".repeat(40))).rejects.toThrow("Repository caller retired");
  await expect(restored.readRemoteHead("main")).rejects.toThrow("Repository caller retired");
});

it("resolves an unambiguous source without overriding an explicit selection", () => {
  const fixture = createRepositorySourceFixture({
    id: "remote",
    resolve: (candidate) => (candidate === url ? { url, name: "project" } : undefined),
    async prepare() {
      throw new Error("No checkout");
    },
  });
  expect(resolvePluginRepositorySource(undefined, url, fixture.registry).id).toBe(fixture.id);
  expect(() => resolvePluginRepositorySource("missing/remote", url, fixture.registry)).toThrow(
    "unavailable",
  );
});
