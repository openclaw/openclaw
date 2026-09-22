import { describe, expect, it, vi } from "vitest";
import {
  PREPARATION_KEY,
  PROJECT_KEY,
  usePreparedPoolFixture,
  type PoolOptions,
} from "./prepared-pool.test-support.js";
import type { RepositoryWorkerProjectSnapshot } from "./workspace-git-base.js";

describe("repository prepared worker reserves", () => {
  const fixture = usePreparedPoolFixture();
  it.each([undefined, false])(
    "retains a pinned repository with setup=%s without admission and refuses refill after access loss",
    async (runSetupScript) => {
      const repository: RepositoryWorkerProjectSnapshot = {
        key: PROJECT_KEY,
        baseCommit: "d".repeat(40),
        source: {
          kind: "repository",
          url: "https://github.com/openclaw/prepared-fixture.git",
          repositoryId: "R_prepared_fixture",
          owner: {
            agent: { agentId: "main", provenance: null },
            identity: {
              source: "agent-override",
              profileId: `ghp_${"a".repeat(32)}`,
              accountId: 123,
            },
          },
        },
      };
      fixture.teardown(
        fixture.attach(
          fixture.ready(fixture.seed("repository-source", { repository, runSetupScript })),
        ),
      );
      fixture.reopenStore();
      let accessible = true;
      const prepareIntent = vi.fn<PoolOptions["prepareIntent"]>(async (_profileId, options) => {
        expect(options).toEqual({
          projectRepository: repository,
          executionMode: "worker-turn",
          // This fixture has no executable recipe to authorize.
          setupAuthorized: false,
          runSetupScript,
          signal: fixture.abort.signal,
        });
        if (!accessible) {
          throw new Error("Repository access is no longer available");
        }
        return {
          providerId: fixture.provider.id,
          profileSnapshot: fixture.profile(
            PROJECT_KEY,
            PREPARATION_KEY,
            options.runSetupScript,
            options.projectRepository,
          ),
          preparationKey: PREPARATION_KEY,
        };
      });
      await fixture.schedule(fixture.pool({ prepareIntent }));
      const reserve = fixture.ready(fixture.reserves()[0]!);
      expect(reserve.profileSnapshot.project).toMatchObject(repository);
      expect(reserve.preparation).toMatchObject({ demandAtMs: 1_000, expiresAtMs: 2_000 });
      expect(prepareIntent).toHaveBeenCalledTimes(1);

      fixture.reopenStore();
      accessible = false;
      fixture.nowMs = 1_100;
      const reconcile = vi.fn<PoolOptions["reconcile"]>(async () => {});
      await fixture.schedule(fixture.pool({ prepareIntent, reconcile }));
      expect(prepareIntent).toHaveBeenCalledTimes(1);
      expect(fixture.store.get(reserve.environmentId)).toEqual(reserve);
      expect(reconcile.mock.lastCall?.[0]).toMatchObject({ environmentId: reserve.environmentId });
      // Provider cleanup frees capacity without granting a session access to
      // retained private contents. Replacement still requires fresh admission.
      fixture.destroy(fixture.store.get(reserve.environmentId)!);
      await fixture.schedule(fixture.pool({ prepareIntent, reconcile }));
      expect(prepareIntent).toHaveBeenCalledTimes(2);
      expect(fixture.reserves()).toHaveLength(1);
      expect(fixture.store.get(reserve.environmentId)).toMatchObject({
        state: "destroyed",
        destroyRequestedAtMs: 1_100,
        preparation: reserve.preparation,
      });
      expect(fixture.provider.notePreparedDemand).not.toHaveBeenCalled();
    },
  );
});
