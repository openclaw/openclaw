import { expect, it, vi } from "vitest";
import { withTempHomeCore as withTempHome } from "../../plugin-sdk/test-helpers/temp-home.js";
import { createRepositorySourceFixture } from "../../plugins/repository-source.test-support.js";
import { prepareRepositoryWorkerProjectSource } from "./repository-project-admission.js";

it("pins generic worker source facts and rechecks the exact plugin on preparation replay", async () => {
  await withTempHome(async (home) => {
    const url = "https://git.example/team/project.git";
    const commit = "a".repeat(40);
    const config = { agents: { entries: { main: { workspace: home } } } };
    let identityKey = "selected-reader";
    let withPack = true;
    const fixture = createRepositorySourceFixture({
      id: "remote",
      resolve: (candidate) => (candidate === url ? { url, name: "project" } : undefined),
      prepare: async () => {
        throw new Error("Worker admission must not materialize locally");
      },
      worker: {
        prepare: async ({ assertCurrent }) => ({
          repositoryId: "repository_fixture",
          identityKey,
          baseCommit: commit,
          tree: "b".repeat(40),
          credential: "synthetic-private-source-value",
          assertCurrent,
          confirmAdmission: async () => {},
          revalidate: async () => {},
          readTree: async () => [],
          readBlob: async () => {
            throw new Error("No recipe blobs in this source");
          },
          ...(withPack
            ? {
                prepareGitPack: async () => {
                  throw new Error("No transport runs during source admission");
                },
              }
            : {}),
        }),
        checkout: async () => {
          throw new Error("No worker starts during source admission");
        },
      },
    });
    const options = { namespace: "fixture", getConfig: () => config, assertCurrent() {} };

    await fixture.run(async () => {
      const admitted = await prepareRepositoryWorkerProjectSource({
        ...options,
        repository: { agentId: "main", url, repositorySourceId: fixture.id },
      });
      expect(admitted.project.source).toEqual({
        kind: "repository",
        url,
        repositorySourceId: fixture.id,
        repositoryId: "repository_fixture",
        owner: {
          agent: { agentId: "main", provenance: null },
          identity: { source: "plugin", key: "selected-reader" },
        },
      });
      expect(JSON.stringify(admitted.project)).not.toContain("synthetic-private-source-value");
      expect(
        (await prepareRepositoryWorkerProjectSource({ ...options, expected: admitted.project }))
          .project,
      ).toEqual(admitted.project);
      withPack = false;
      expect(
        (await prepareRepositoryWorkerProjectSource({ ...options, expected: admitted.project }))
          .prepareGitPack,
      ).toBeUndefined();
      identityKey = "replacement-reader";
      await expect(
        prepareRepositoryWorkerProjectSource({ ...options, expected: admitted.project }),
      ).rejects.toThrow("source changed");
      await fixture.instance.dispose();
      await expect(admitted.revalidate()).rejects.toThrow("reloaded or disabled");
    });
  });
});

it.each(["revalidation", "pack effect"] as const)(
  "keeps initiating operation authority through generic pack %s",
  async (retirement) => {
    await withTempHome(async (home) => {
      const config = { agents: { entries: { main: { workspace: home } } } };
      let current = true;
      const assertCurrent = () => {
        if (!current) {
          throw new Error("Repository operation retired");
        }
      };
      const prepareGitPack = vi.fn(async (input: { assertCurrent: () => void }) => {
        current = false;
        input.assertCurrent();
        return "/synthetic/pack";
      });
      const fixture = createRepositorySourceFixture({
        id: "remote",
        resolve: (url) => ({ url, name: "project" }),
        prepare: async () => {
          throw new Error("No local preparation");
        },
        worker: {
          prepare: async () => ({
            repositoryId: "repository_fixture",
            identityKey: "selected-reader",
            baseCommit: "a".repeat(40),
            tree: "b".repeat(40),
            assertCurrent() {},
            confirmAdmission: async () => {},
            revalidate: async () => {
              await Promise.resolve();
              if (retirement === "revalidation") {
                current = false;
              }
            },
            readTree: async () => [],
            readBlob: async () => "",
            prepareGitPack,
          }),
          checkout: async () => {},
        },
      });
      await fixture.run(async () => {
        const admitted = await prepareRepositoryWorkerProjectSource({
          namespace: "fixture",
          getConfig: () => config,
          assertCurrent,
          repository: {
            agentId: "main",
            url: "https://git.example/team/project.git",
            repositorySourceId: fixture.id,
          },
        });
        await expect(
          admitted.prepareGitPack!({ temporaryRoot: home, signal: new AbortController().signal }),
        ).rejects.toThrow("Repository operation retired");
        expect(prepareGitPack).toHaveBeenCalledTimes(retirement === "revalidation" ? 0 : 1);
      });
    });
  },
);
