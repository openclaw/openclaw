import { describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type { PreparedPoolPresenceDemand } from "./prepared-pool-presence.types.js";
import {
  PREPARATION_KEY,
  PROJECT_KEY,
  usePreparedPoolFixture,
  type PoolOptions,
} from "./prepared-pool.test-support.js";
import { readWorkerProjectSnapshot } from "./project-preparation.js";
import type { RepositoryWorkerProjectSnapshot } from "./repository-project-source.schema.js";

describe("activation demand overlapping presence admission", () => {
  const fixture = usePreparedPoolFixture();

  it.each([
    { failure: "rejected", activation: "current" },
    { failure: "held", activation: "current" },
    { failure: "rejected", activation: "expired" },
    { failure: "held", activation: "different preparation" },
  ] as const)(
    "uses only $activation activation while presence admission is $failure",
    async ({ failure, activation }) => {
      const repository: RepositoryWorkerProjectSnapshot = {
        key: PROJECT_KEY,
        baseCommit: "d".repeat(40),
        source: {
          kind: "repository",
          url: "https://github.com/acme/private-repo.git",
          repositoryId: "R_acme_private_repo",
          owner: {
            agent: { agentId: "main", provenance: null },
            identity: { source: "anonymous" },
          },
        },
      };
      let demand: PreparedPoolPresenceDemand | undefined = {
        revision: 1,
        profileId: "development",
        requestedRef: "main",
        preparationKey: PREPARATION_KEY,
        project: repository,
        lastPresentAtMs: 1_000,
        retireAtMs: null,
      };
      fixture.developmentProfile.readyWorkers = 2;
      const seedPresenceReserve = (id: string, preparationKey = PREPARATION_KEY) =>
        fixture.seed(id, {
          reserve: true,
          repository,
          preparationKey,
          expiresAtMs: Number.MAX_SAFE_INTEGER,
        });
      const source = await fixture.ready(
        await seedPresenceReserve(
          "activated-presence",
          activation === "different preparation" ? "e".repeat(64) : PREPARATION_KEY,
        ),
      );
      const active = await fixture.attach(source, "active", 1_100);
      fixture.nowMs = 1_200;
      const kept = await fixture.ready(await seedPresenceReserve("kept-presence"));
      const otherKey = "2".repeat(64);
      await fixture.attach(
        await fixture.ready(await fixture.seed("other-source", { projectKey: otherKey })),
      );
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const otherProgressed = createDeferredCore();
      fixture.releases.push(() => release.resolve());
      const prepareIntent = vi.fn<PoolOptions["prepareIntent"]>(async (_profileId, options) => {
        if (options.repository) {
          entered.resolve();
          if (failure === "held") {
            await release.promise;
          }
          throw new Error("Presence repository resolution unavailable");
        }
        return {
          providerId: fixture.provider.id,
          profileSnapshot: options.projectRepository
            ? fixture.profile(PROJECT_KEY, PREPARATION_KEY, undefined, options.projectRepository)
            : fixture.profile(otherKey),
          preparationKey: PREPARATION_KEY,
        };
      });
      const owner = fixture.pool({
        prepareIntent,
        resolveHumanPresenceDemand: () => ({
          profileId: "development",
          executionMode: "worker-turn",
          repository: { agentId: "main", url: repository.source.url, ref: "main" },
        }),
        presenceDemandStore: {
          read: async () => demand,
          write: async (value, assertCurrent) => {
            assertCurrent();
            demand = value ?? undefined;
            return demand;
          },
        },
        reconcile: async (record, _signal, beforeReconcile) => {
          beforeReconcile();
          if (readWorkerProjectSnapshot(record.profileSnapshot.project)?.key === otherKey) {
            otherProgressed.resolve();
          }
        },
      });
      if (activation === "expired") {
        // The spare's later demand timestamp must not extend the 1,100 activation.
        fixture.nowMs = 2_100;
      }
      const running = owner.setHumanPresence(true);
      const settled = running.catch(() => {});
      fixture.operations.add(settled);
      try {
        await entered.promise;
        // Other-project reconciliation proves the inventory pass reached its effect phase
        // without releasing held presence admission. All planned reserves commit first.
        await awaitGateBeforeSettlement(
          otherProgressed.promise,
          running,
          "Inventory made no progress",
        );
        if (failure === "rejected") {
          await settled;
        }
        const reserves = fixture
          .reserves()
          .filter(
            (record) =>
              record.preparation?.consumedAtMs === null &&
              readWorkerProjectSnapshot(record.profileSnapshot.project)?.key === PROJECT_KEY,
          );
        expect(reserves).toHaveLength(activation === "current" ? 2 : 1);
        expect(reserves.every((record) => record.destroyRequestedAtMs === null)).toBe(true);
        expect(fixture.store.get(kept.environmentId)).toEqual(kept);
        expect(fixture.store.get(active.environmentId)).toEqual(active);
        expect(prepareIntent.mock.calls.filter(([, options]) => options.repository)).toHaveLength(
          1,
        );
        expect(
          prepareIntent.mock.calls.some(
            ([, options]) => options.projectRepository?.key === PROJECT_KEY,
          ),
        ).toBe(activation === "current");
      } finally {
        release.resolve();
        await settled;
      }
    },
  );
});
