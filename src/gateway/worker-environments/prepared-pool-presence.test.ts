import { afterEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { startWorkerHumanPresence } from "../server/client-human-presence.js";
import { GatewayClientRegistry } from "../server/client-registry.js";
import {
  invalidateGatewayPolicyClient,
  registerGatewayPolicyResponse,
} from "../server/ws-policy-close.js";
import type { GatewayWsClient } from "../server/ws-types.js";
import type { PreparedPoolPresenceDemand } from "./prepared-pool-presence.types.js";
import {
  PREPARATION_KEY,
  PROJECT_KEY,
  usePreparedPoolFixture,
  type PoolOptions,
} from "./prepared-pool.test-support.js";
import { readWorkerProjectSnapshot } from "./project-preparation.js";
import type { RepositoryWorkerProjectSnapshot } from "./repository-project-source.schema.js";

describe("authenticated human prepared-pool demand", () => {
  const fixture = usePreparedPoolFixture();
  afterEach(clearRuntimeConfigSnapshot);
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

  function presencePool(
    initial?: PreparedPoolPresenceDemand,
    executionMode: "worker-turn" | "remote-exec" = "remote-exec",
    overrides: Partial<PoolOptions> = {},
  ) {
    let persisted = initial;
    let currentRepository = repository;
    let sourceEnabled = true;
    const write = vi.fn<NonNullable<PoolOptions["presenceDemandStore"]>["write"]>(
      async (value, assertCurrent) => {
        assertCurrent();
        persisted = value ?? undefined;
        return persisted;
      },
    );
    fixture.config.cloudWorkers!.preparedPool = { maxTotal: 3 };
    fixture.developmentProfile.readyWorkers = 3;
    const prepareIntent = vi.fn<PoolOptions["prepareIntent"]>(async (_profileId, options) => {
      const project = options.projectRepository ?? currentRepository;
      const preparationKey =
        project.baseCommit === repository.baseCommit ? PREPARATION_KEY : "e".repeat(64);
      const { executionMode: _defaultExecutionMode, ...profile } = fixture.profile(
        PROJECT_KEY,
        preparationKey,
        undefined,
        project,
      );
      const profileSnapshot = {
        ...profile,
        ...(options.executionMode ? { executionMode: options.executionMode } : {}),
      };
      return {
        providerId: fixture.provider.id,
        profileSnapshot,
        preparationKey,
      };
    });
    const owner = fixture.pool({
      prepareIntent,
      resolveHumanPresenceDemand: () =>
        sourceEnabled
          ? {
              profileId: "development",
              executionMode,
              repository: { agentId: "main", url: currentRepository.source.url, ref: "main" },
            }
          : undefined,
      presenceDemandStore: { read: async () => persisted, write },
      ...overrides,
    });
    return {
      owner,
      prepareIntent,
      write,
      read: () => persisted,
      setRepository: (project: RepositoryWorkerProjectSnapshot) => {
        currentRepository = project;
      },
      disableSource: () => {
        sourceEnabled = false;
      },
    };
  }

  it.each(["admission", "effect"] as const)(
    "fences presence %s before a held policy response closes the last browser",
    async (boundary) => {
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const effect = vi.fn();
      const close = vi.fn();
      let hold = false;
      const presence = presencePool(undefined, "worker-turn", {
        reconcile: async (record, _signal, beforeReconcile) => {
          if (record.destroyRequestedAtMs !== null || !hold) {
            return;
          }
          entered.resolve();
          await release.promise;
          beforeReconcile();
          effect(record.environmentId);
        },
      });
      const client: GatewayWsClient = {
        connId: "presence-browser",
        usesSharedGatewayAuth: false,
        authenticatedUserId: "presence-person",
        internal: { authenticatedControlUi: true },
        connect: {
          minProtocol: 1,
          maxProtocol: 1,
          role: "operator",
          scopes: ["operator.sessions.write"],
          client: { id: "openclaw-control-ui", version: "test", platform: "test", mode: "webchat" },
        },
        socket: {
          readyState: 1,
          bufferedAmount: 0,
          send: vi.fn(),
          close,
          terminate: vi.fn(),
          on: vi.fn(),
          off: vi.fn(),
          once: vi.fn(),
        },
      };
      const clients = new GatewayClientRegistry([client]);
      const sidecars: Array<{ stop: () => void }> = [];
      await startWorkerHumanPresence({
        clients,
        service: presence.owner,
        log: { warn: vi.fn() },
        registerSidecar: (sidecar) => sidecars.push(sidecar),
      });
      const ready = await Promise.all(fixture.reserves().map((record) => fixture.ready(record)));
      const active = await fixture.attach(ready[0]!);
      // Keep activation authority separate from this presence-only generation.
      fixture.nowMs = 3_000;
      hold = boundary === "effect";
      if (boundary === "admission") {
        const ensure = fixture.store.ensurePreparedIntent.bind(fixture.store);
        vi.spyOn(fixture.store, "ensurePreparedIntent").mockImplementationOnce(async (request) => {
          entered.resolve();
          await release.promise;
          return ensure(request);
        });
      }
      const response = registerGatewayPolicyResponse("config.patch", client, vi.fn())!;
      response.hold();
      const running = fixture.schedule(presence.owner);
      const settled = running.catch(() => {});
      try {
        await entered.promise;
        invalidateGatewayPolicyClient(client, {
          reason: "test revocation",
          code: 1008,
          message: "revoked",
        });
        expect(close).not.toHaveBeenCalled();
        expect(clients.has(client)).toBe(true);
        release.resolve();
        await settled;
        hold = false;
        await fixture.schedule(presence.owner);
        expect(effect).not.toHaveBeenCalled();
        expect(fixture.reserves()).toHaveLength(boundary === "admission" ? 3 : 4);
        expect(presence.read()?.retireAtMs).toBe(903_000);
        expect(fixture.store.get(active.environmentId)).toEqual(active);
        expect(ready.slice(1).map((record) => fixture.store.get(record.environmentId))).toEqual(
          ready.slice(1),
        );
      } finally {
        release.resolve();
        await settled;
        sidecars.forEach((sidecar) => sidecar.stop());
        response.finish();
      }
    },
  );

  it.each(["held"] as const)(
    "cleans unrelated expiry and refills a healthy sibling before %s presence admission",
    async (failure) => {
      const healthyKey = "2".repeat(64);
      const progressed = createDeferredCore();
      const expiredAgain = createDeferredCore();
      const presenceExpired = createDeferredCore();
      const presence = presencePool(undefined, "worker-turn", {
        reconcile: async (record, _signal, beforeReconcile) => {
          beforeReconcile();
          if (readWorkerProjectSnapshot(record.profileSnapshot.project)?.key === healthyKey) {
            progressed.resolve();
          }
          if (record.environmentId === "expired-again" && record.destroyRequestedAtMs !== null) {
            expiredAgain.resolve();
          }
          if (
            readWorkerProjectSnapshot(record.profileSnapshot.project)?.key === PROJECT_KEY &&
            record.destroyRequestedAtMs !== null
          ) {
            presenceExpired.resolve();
          }
        },
      });
      await presence.owner.setHumanPresence(true);
      const ready = await Promise.all(fixture.reserves().map((record) => fixture.ready(record)));
      await fixture.destroy(ready[0]!);
      const expired = await fixture.ready(
        await fixture.seed("expired-other", { reserve: true, projectKey: "1".repeat(64) }),
      );
      fixture.nowMs = 1_500;
      await fixture.attach(
        await fixture.ready(await fixture.seed("healthy-source", { projectKey: healthyKey })),
      );
      fixture.nowMs = 2_000;
      fixture.config.cloudWorkers!.preparedPool!.maxTotal = 8;
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const prepare = presence.prepareIntent.getMockImplementation()!;
      presence.prepareIntent.mockClear();
      fixture.releases.push(() => release.resolve());
      presence.prepareIntent.mockImplementation(async (_profileId, options) => {
        if (options.projectPath) {
          return {
            providerId: fixture.provider.id,
            profileSnapshot: fixture.profile(healthyKey),
            preparationKey: PREPARATION_KEY,
          };
        }
        entered.resolve();
        if (failure === "held") {
          await release.promise;
        }
        throw new Error("Presence repository unavailable");
      });
      const running = fixture.schedule(presence.owner);
      const settled = running.catch(() => {});
      try {
        await entered.promise;
        await awaitGateBeforeSettlement(
          progressed.promise,
          running,
          "Healthy refill did not progress",
        );
        expect(fixture.store.get(expired.environmentId)?.destroyRequestedAtMs).toBe(2_000);
        const healthy = fixture
          .reserves()
          .filter(
            (record) =>
              readWorkerProjectSnapshot(record.profileSnapshot.project)?.key === healthyKey,
          );
        expect(healthy).toHaveLength(3);
        expect(ready.slice(1).map((record) => fixture.store.get(record.environmentId))).toEqual(
          ready.slice(1),
        );
        expect(
          fixture
            .reserves()
            .filter(
              (record) =>
                readWorkerProjectSnapshot(record.profileSnapshot.project)?.key === PROJECT_KEY,
            ),
        ).toHaveLength(3);
        if (failure === "held") {
          await fixture.ready(
            await fixture.seed("expired-again", {
              reserve: true,
              projectKey: "3".repeat(64),
              expiresAtMs: 2_100,
            }),
          );
          fixture.nowMs = 2_100;
          const repeated = fixture.schedule(presence.owner).catch(() => {});
          await awaitGateBeforeSettlement(
            expiredAgain.promise,
            repeated,
            "Later cleanup did not progress",
          );
          expect(
            presence.prepareIntent.mock.calls.filter(([, options]) => !options.projectPath),
          ).toHaveLength(1);
          expect(fixture.store.get("expired-again")?.destroyRequestedAtMs).toBe(2_100);
          const departure = presence.owner.setHumanPresence(false).catch(() => {});
          fixture.operations.add(departure);
          fixture.nowMs = 902_100;
          const retiring = fixture.schedule(presence.owner).catch(() => {});
          await awaitGateBeforeSettlement(
            presenceExpired.promise,
            retiring,
            "Departure grace did not expire during held admission",
          );
          expect(
            ready
              .slice(1)
              .map((record) => fixture.store.get(record.environmentId)?.destroyRequestedAtMs),
          ).toEqual([902_100, 902_100]);
          expect(
            presence.prepareIntent.mock.calls.filter(([, options]) => !options.projectPath),
          ).toHaveLength(1);
        }
      } finally {
        release.resolve();
        await settled;
        presence.prepareIntent.mockImplementation(prepare);
      }
    },
  );

  it.each([
    { change: "repository on the same host", url: "https://github.com/acme/other-repo.git" },
  ])("retires persisted demand after a $change change", async ({ url }) => {
    const oldReserve = await fixture.ready(
      await fixture.seed("previous-repository-reserve", {
        reserve: true,
        repository,
        expiresAtMs: Number.MAX_SAFE_INTEGER,
      }),
    );
    const presence = presencePool({
      revision: 1,
      profileId: "development",
      requestedRef: "main",
      preparationKey: PREPARATION_KEY,
      project: repository,
      lastPresentAtMs: 1_000,
      retireAtMs: null,
    });
    presence.setRepository({
      ...repository,
      source: { ...repository.source, url },
    });
    fixture.config.gateway = { github: { host: new URL(url).hostname } };
    setRuntimeConfigSnapshot(fixture.config);

    await presence.owner.setHumanPresence(false);

    expect(presence.write).toHaveBeenCalledWith(null, expect.any(Function));
    expect(presence.read()).toBeUndefined();
    expect(fixture.store.get(oldReserve.environmentId)?.destroyRequestedAtMs).toBe(1_000);
  });

  it("clears persisted demand when the configured default repository is removed", async () => {
    const presence = presencePool({
      revision: 1,
      profileId: "development",
      requestedRef: "main",
      preparationKey: PREPARATION_KEY,
      project: repository,
      lastPresentAtMs: 1_000,
      retireAtMs: null,
    });
    presence.disableSource();

    await presence.owner.setHumanPresence(false);

    expect(presence.write).toHaveBeenCalledWith(null, expect.any(Function));
    expect(presence.read()).toBeUndefined();
  });

  it("refreshes main with live reserves, retires only unused old workers, and claims the new generation", async () => {
    // Old activation demand is still valid when the ref refreshes. It must not
    // keep unused A reserves occupying capacity for the newly selected B.
    fixture.provider.resolvePreparedIdleTimeoutMs = () => 300_000;
    const presence = presencePool(undefined, "worker-turn");
    await presence.owner.setHumanPresence(true);
    const old = await Promise.all(fixture.reserves().map((record) => fixture.ready(record)));
    const active = await fixture.attach(old[0]!);
    const nextRepository = { ...repository, baseCommit: "f".repeat(40) };
    presence.setRepository(nextRepository);

    fixture.nowMs = 60_999;
    await fixture.schedule(presence.owner);
    expect(presence.read()?.project.baseCommit).toBe(repository.baseCommit);
    expect(
      old
        .slice(1)
        .every((record) => fixture.store.get(record.environmentId)?.destroyRequestedAtMs === null),
    ).toBe(true);

    fixture.nowMs = 61_000;
    await fixture.schedule(presence.owner);
    expect(presence.read()?.project.baseCommit).toBe(nextRepository.baseCommit);
    expect(presence.read()?.preparationKey).toBe("e".repeat(64));
    expect(fixture.store.get(active.environmentId)).toMatchObject({
      state: "attached",
      destroyRequestedAtMs: null,
    });
    // Refill may have admitted another A reserve after the first claim. Every
    // unused A obligation must settle before all three B slots are available.
    const obsolete = fixture
      .reserves()
      .filter((record) => record.preparation?.consumedAtMs === null);
    for (const record of obsolete) {
      expect(record.destroyRequestedAtMs).toBe(61_000);
      if (record.state === "requested") {
        await fixture.store.transition({
          environmentId: record.environmentId,
          from: "requested",
          to: "failed",
          patch: { lastError: "fixture cancelled unused allocation" },
        });
      } else {
        await fixture.destroy(record);
      }
    }
    await fixture.schedule(presence.owner);
    const next = fixture.reserves().filter((record) => record.preparation?.key === "e".repeat(64));
    expect(next).toHaveLength(3);
    const ready = await Promise.all(next.map((record) => fixture.ready(record)));
    const intent = await presence.prepareIntent("development", {
      projectRepository: nextRepository,
      executionMode: "worker-turn",
    });
    expect(presence.owner.candidates(intent).map((record) => record.environmentId)).toEqual(
      ready.map((record) => record.environmentId),
    );
    const claimed = await fixture.attach(ready[0]!);
    expect(claimed.environmentId).toBe(ready[0]!.environmentId);
    expect(claimed.preparation?.consumedAtMs).toBe(61_000);
    expect(presence.owner.candidates(intent).map((record) => record.environmentId)).not.toContain(
      claimed.environmentId,
    );
    const staleIntent = await presence.prepareIntent("development", {
      projectRepository: repository,
    });
    expect(presence.owner.candidates(staleIntent)).toEqual([]);
  });
});
