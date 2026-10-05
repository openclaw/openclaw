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
import { imageReserveProject, readImageReserveProject } from "./image-reserve.js";
import { readWorkerProjectPreparation } from "./preparation-identity.js";
import type { PreparedPoolPresenceDemand } from "./prepared-pool-presence.types.js";
import {
  PREPARATION_KEY,
  PROJECT_KEY,
  usePreparedPoolFixture,
  type PoolOptions,
} from "./prepared-pool.test-support.js";
import { readWorkerProjectSnapshot } from "./project-preparation.js";
import type { RepositoryWorkerProjectSnapshot } from "./repository-project-source.schema.js";
import { requireWorkerProfile } from "./service-validation.js";

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
    standingImage = false,
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
      const preparationKey = PREPARATION_KEY;
      const { executionMode: _defaultExecutionMode, ...profile } = fixture.profile(
        PROJECT_KEY,
        preparationKey,
        undefined,
        project,
      );
      const profileSnapshot = requireWorkerProfile({
        ...profile,
        ...(options.imageReserve
          ? {
              project: {
                ...imageReserveProject("gateway-test"),
                preparation: readWorkerProjectPreparation(profile.project),
              },
            }
          : {}),
        ...(options.executionMode ? { executionMode: options.executionMode } : {}),
      });
      return {
        providerId: fixture.provider.id,
        profileSnapshot,
        preparationKey,
      };
    });
    const owner = fixture.pool({
      prepareIntent,
      ...(standingImage
        ? {
            resolveStandingImageDemand: () =>
              sourceEnabled ? { profileId: "development", executionMode } : undefined,
          }
        : {}),
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

  it("does not infer standing demand from Factory mode without the host input", async () => {
    vi.stubEnv("FACTORY_AUTH_MODE", "github");
    try {
      const presence = presencePool(undefined, "worker-turn");
      await fixture.schedule(presence.owner);
      expect(fixture.reserves()).toEqual([]);
      expect(presence.prepareIntent).not.toHaveBeenCalled();
      expect(presence.write).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("keeps standing image reserves selectable without human presence across restart and a claim", async () => {
    vi.stubEnv("FACTORY_AUTH_MODE", "github");
    try {
      const first = presencePool(undefined, "worker-turn", {}, true);
      await fixture.schedule(first.owner);
      expect(fixture.reserves()).toHaveLength(3);
      expect(first.write).not.toHaveBeenCalled();
      expect(first.read()).toBeUndefined();
      const ready = await Promise.all(fixture.reserves().map((record) => fixture.ready(record)));
      const originalIds = ready.map((record) => record.environmentId);
      fixture.nowMs += 20 * 60_000;
      await fixture.reopenStore();
      const reopened = presencePool(undefined, "worker-turn", {}, true);
      await fixture.schedule(reopened.owner);
      expect(reopened.write).not.toHaveBeenCalled();
      expect(fixture.reserves().map((record) => record.environmentId)).toEqual(originalIds);
      const intent = await reopened.prepareIntent("development", {
        projectRepository: repository,
        executionMode: "worker-turn",
      });
      intent.preparationKey = "c".repeat(64);
      expect(
        reopened.owner.candidates(intent, "development").map((record) => record.environmentId),
      ).toEqual(originalIds);
      expect(
        reopened.owner.canPruneDemand(fixture.store.get(originalIds[0]!)!, fixture.nowMs),
      ).toBe(false);
      const active = await fixture.attach(fixture.store.get(originalIds[0]!)!);
      await Promise.all([fixture.schedule(reopened.owner), fixture.schedule(reopened.owner)]);
      expect(reopened.owner.summary().reservedEnvironmentIds).toHaveLength(3);
      expect(fixture.reserves()).toHaveLength(4);
      expect(fixture.store.get(active.environmentId)).toMatchObject({
        state: "attached",
        destroyRequestedAtMs: null,
      });
      expect(
        reopened.owner.candidates(intent, "development").map((record) => record.environmentId),
      ).not.toContain(active.environmentId);
      expect(reopened.write).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each(["disabled", "cap0", "mode", "shutdown"] as const)(
    "does not admit standing image reserves after %s changes during preparation",
    async (change) => {
      vi.stubEnv("FACTORY_AUTH_MODE", "github");
      try {
        const standing = presencePool(undefined, "worker-turn", {}, true);
        const prepare = standing.prepareIntent.getMockImplementation()!;
        standing.prepareIntent.mockImplementationOnce(async (...args) => {
          const intent = await prepare(...args);
          if (change === "disabled") {
            standing.disableSource();
          } else if (change === "cap0") {
            fixture.config.cloudWorkers!.preparedPool = { maxTotal: 0 };
          } else if (change === "mode") {
            vi.stubEnv("FACTORY_AUTH_MODE", "other");
          } else {
            fixture.abort.abort();
          }
          return intent;
        });
        await expect(fixture.schedule(standing.owner)).rejects.toThrow();
        expect(fixture.reserves()).toHaveLength(0);
        expect(standing.write).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );

  it("stops standing refill at cap zero without retiring an attached worker", async () => {
    vi.stubEnv("FACTORY_AUTH_MODE", "github");
    try {
      const standing = presencePool(undefined, "worker-turn", {}, true);
      await fixture.schedule(standing.owner);
      const ready = await Promise.all(fixture.reserves().map((record) => fixture.ready(record)));
      const active = await fixture.attach(ready[0]!);
      fixture.config.cloudWorkers!.preparedPool = { maxTotal: 0 };
      await fixture.schedule(standing.owner);
      expect(fixture.store.get(active.environmentId)).toMatchObject({
        state: "attached",
        destroyRequestedAtMs: null,
      });
      for (const unused of ready.slice(1)) {
        expect(fixture.store.get(unused.environmentId)?.destroyRequestedAtMs).toBe(fixture.nowMs);
      }
      expect(standing.write).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

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

  it.each(["rejected", "held"] as const)(
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
        if (failure === "rejected") {
          await settled;
        } else {
          await awaitGateBeforeSettlement(
            progressed.promise,
            running,
            "Healthy refill did not progress",
          );
        }
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
  it("clears removed presence policy and invalidates its unused indefinite reserves before the grace period", async () => {
    const presence = presencePool();
    await presence.owner.setHumanPresence(true);
    const original = fixture.reserves();
    expect(original).toHaveLength(3);
    presence.disableSource();
    await fixture.schedule(presence.owner);
    expect(presence.read()).toBeUndefined();
    for (const retired of original) {
      expect(fixture.store.get(retired.environmentId)?.destroyRequestedAtMs).toBe(fixture.nowMs);
    }
    expect(fixture.reserves().filter((record) => record.destroyRequestedAtMs === null)).toEqual([]);
  });

  it("keeps ordinary image activation and consumed image workers when presence policy disappears", async () => {
    vi.stubEnv("FACTORY_AUTH_MODE", "github");
    try {
      const presence = presencePool(undefined, "worker-turn");
      await presence.owner.setHumanPresence(true);
      const original = fixture.reserves();
      const first = original[0]!;
      const active = await fixture.attach(await fixture.ready(first));
      fixture.config.cloudWorkers!.preparedPool = { maxTotal: 4 };
      fixture.developmentProfile.readyWorkers = 4;
      const image = readImageReserveProject(first.profileSnapshot.project);
      if (!image) {
        throw new Error("Factory fixture did not produce an image reserve");
      }
      const independent = await fixture.store.ensurePreparedIntent({
        intent: {
          environmentId: "ordinary-image-reserve",
          providerId: first.providerId,
          profileId: first.profileId,
          provisionOperationId: "provision-ordinary-image",
          profileSnapshot: first.profileSnapshot,
          preparation: {
            purpose: "reserve",
            key: first.preparation!.key,
            demandAtMs: fixture.nowMs,
            expiresAtMs: fixture.nowMs + 300_000,
          },
        },
        projectKey: image.key,
        target: 4,
        maxTotal: 4,
        assertCurrent: () => {},
      });
      if (!independent) {
        throw new Error("Ordinary image fixture lacked capacity");
      }
      const ready = await fixture.ready(independent);
      presence.disableSource();
      await fixture.schedule(presence.owner);
      expect(fixture.store.get(active.environmentId)).toMatchObject({
        state: "attached",
        destroyRequestedAtMs: null,
      });
      expect(fixture.store.get(ready.environmentId)).toMatchObject({
        state: "ready",
        destroyRequestedAtMs: null,
      });
      expect(
        original
          .slice(1)
          .every(
            (record) => fixture.store.get(record.environmentId)?.destroyRequestedAtMs !== null,
          ),
      ).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("fills three repository-free image reserves and offers them to a verified repository claim", async () => {
    vi.stubEnv("FACTORY_AUTH_MODE", "github");
    try {
      const presence = presencePool();
      await presence.owner.setHumanPresence(true);
      const reserved = fixture.reserves();
      expect(reserved).toHaveLength(3);
      expect(
        reserved.every(
          (record) => readImageReserveProject(record.profileSnapshot.project) !== undefined,
        ),
      ).toBe(true);
      expect(presence.prepareIntent).toHaveBeenCalledWith(
        "development",
        expect.objectContaining({ imageReserve: true }),
      );
      const ready = await Promise.all(reserved.map((record) => fixture.ready(record)));
      const repositoryIntent = await presence.prepareIntent("development", {
        projectRepository: repository,
        executionMode: "remote-exec",
      });
      repositoryIntent.preparationKey = "c".repeat(64);
      expect(
        presence.owner
          .candidates(repositoryIntent, "development")
          .map((record) => record.environmentId),
      ).toEqual(ready.map((record) => record.environmentId));
      expect(presence.owner.candidates(repositoryIntent, "another-profile")).toEqual([]);
      const rejected = vi.fn();
      await fixture.store.requestDestroy({
        environmentId: ready[0]!.environmentId,
        state: "ready",
      });
      const expectedIds = ready.slice(1).map((record) => record.environmentId);
      expect(
        presence.owner
          .candidates(repositoryIntent, "development", rejected)
          .map((record) => record.environmentId),
      ).toEqual(expectedIds);
      expect(rejected).toHaveBeenCalledWith(ready[0]!.environmentId, "destroy_requested");
      expect(rejected).toHaveBeenCalledTimes(1);
      expect(
        presence.owner
          .candidates(repositoryIntent, "development", () => {
            throw new Error("synthetic observer failure");
          })
          .map((record) => record.environmentId),
      ).toEqual(expectedIds);
      const otherProfile = vi.fn();
      presence.owner.candidates(repositoryIntent, "another-profile", otherProfile);
      expect(otherProfile).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("fills three exact-repository reserves, stops refill on departure, and retires after 15m", async () => {
    const presence = presencePool();
    await presence.owner.setHumanPresence(true);
    expect(fixture.reserves()).toHaveLength(3);
    expect(fixture.reserves().map((record) => record.profileSnapshot.project)).toEqual([
      expect.objectContaining(repository),
      expect.objectContaining(repository),
      expect.objectContaining(repository),
    ]);
    expect(presence.read()).toMatchObject({
      profileId: "development",
      requestedRef: "main",
      preparationKey: PREPARATION_KEY,
      lastPresentAtMs: 1_000,
      retireAtMs: null,
    });

    await presence.owner.setHumanPresence(false);
    expect(presence.read()?.retireAtMs).toBe(901_000);
    await fixture.destroy(await fixture.ready(fixture.reserves()[0]!));
    fixture.nowMs = 900_999;
    await fixture.schedule(presence.owner);
    expect(fixture.reserves()).toHaveLength(3);
    expect(fixture.reserves().filter((record) => record.state !== "destroyed")).toHaveLength(2);

    fixture.nowMs = 901_000;
    await fixture.schedule(presence.owner);
    expect(
      fixture
        .reserves()
        .filter((record) => record.state !== "destroyed")
        .every((record) => record.destroyRequestedAtMs === 901_000),
    ).toBe(true);
  });

  it.each([
    { change: "GitHub host", url: "https://ghe.example.test/acme/private-repo.git" },
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

  it("closes a crash-left active marker and resolves the ref again on return", async () => {
    const active: PreparedPoolPresenceDemand = {
      revision: 4,
      profileId: "development",
      requestedRef: "main",
      preparationKey: PREPARATION_KEY,
      project: repository,
      lastPresentAtMs: 500,
      retireAtMs: null,
    };
    await fixture.seed("retiring-presence-source", { reserve: true, repository });
    const presence = presencePool(active);

    await presence.owner.setHumanPresence(false);
    expect(presence.read()).toMatchObject({ revision: 5, retireAtMs: 901_000 });

    fixture.nowMs = 901_001;
    await presence.owner.setHumanPresence(true);
    expect(presence.prepareIntent).toHaveBeenCalledWith(
      "development",
      expect.objectContaining({
        repository: { agentId: "main", url: repository.source.url, ref: "main" },
      }),
    );
  });

  it("keeps ready reserves claimable while main advances", async () => {
    fixture.provider.resolvePreparedIdleTimeoutMs = () => 300_000;
    const presence = presencePool(undefined, "worker-turn");
    await presence.owner.setHumanPresence(true);
    const old = await Promise.all(fixture.reserves().map((record) => fixture.ready(record)));
    const active = await fixture.attach(old[0]!);
    const nextRepository = { ...repository, baseCommit: "f".repeat(40) };
    presence.setRepository(nextRepository);

    fixture.nowMs = 60_999;
    await fixture.schedule(presence.owner);
    expect(presence.read()?.project).toMatchObject({ baseCommit: repository.baseCommit });
    expect(
      old
        .slice(1)
        .every((record) => fixture.store.get(record.environmentId)?.destroyRequestedAtMs === null),
    ).toBe(true);

    fixture.nowMs = 61_000;
    await fixture.schedule(presence.owner);
    expect(presence.read()?.project).toMatchObject({ baseCommit: nextRepository.baseCommit });
    expect(presence.read()?.preparationKey).toBe(PREPARATION_KEY);
    expect(fixture.store.get(active.environmentId)).toMatchObject({
      state: "attached",
      destroyRequestedAtMs: null,
    });
    const current = fixture
      .reserves()
      .filter((record) => record.preparation?.consumedAtMs === null);
    expect(current).toHaveLength(3);
    expect(current.every((record) => record.destroyRequestedAtMs === null)).toBe(true);
    const ready = await Promise.all(
      current.map((record) =>
        record.state === "ready" ? Promise.resolve(record) : fixture.ready(record),
      ),
    );
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
    const pinnedOldIntent = await presence.prepareIntent("development", {
      projectRepository: repository,
    });
    expect(presence.owner.candidates(pinnedOldIntent)).toHaveLength(2);
  });

  it("retains and refills current reserves after a newer old-base foreground activation", async () => {
    fixture.provider.resolvePreparedIdleTimeoutMs = () => 300_000;
    const foreground = await fixture.ready(
      await fixture.seed("old-base-foreground", { repository }),
    );
    const presence = presencePool(undefined, "worker-turn");
    const currentRepository = { ...repository, baseCommit: "f".repeat(40) };
    presence.setRepository(currentRepository);
    await presence.owner.setHumanPresence(true);
    const current = await Promise.all(
      fixture
        .reserves()
        .filter((record) => record.preparation?.consumedAtMs === null)
        .map((record) => fixture.ready(record)),
    );
    expect(current).toHaveLength(3);

    fixture.nowMs = 1_100;
    const activated = await fixture.attach(foreground);
    expect(activated.lastActivatedAtMs).toBe(1_100);
    await fixture.schedule(presence.owner);
    expect(current.map((record) => fixture.store.get(record.environmentId))).toEqual(current);

    await fixture.destroy(current[0]!);
    await fixture.schedule(presence.owner);
    const retained = fixture
      .reserves()
      .filter(
        (record) =>
          record.preparation?.consumedAtMs === null && record.destroyRequestedAtMs === null,
      );
    expect(retained).toHaveLength(3);
    expect(retained.every((record) => record.preparation?.key === PREPARATION_KEY)).toBe(true);
    expect(fixture.store.get(activated.environmentId)).toEqual(activated);
  });

  it("keeps later activation demand eligible after the presence grace expires", async () => {
    const source = await fixture.ready(
      await fixture.seed("activated-presence-source", { reserve: true, repository }),
    );
    await fixture.teardown(await fixture.attach(source, "active", 1_400));
    fixture.nowMs = 1_600;
    const presence = presencePool({
      revision: 2,
      profileId: "development",
      requestedRef: "main",
      preparationKey: PREPARATION_KEY,
      project: repository,
      lastPresentAtMs: 500,
      retireAtMs: 1_500,
    });

    await presence.owner.setHumanPresence(false);
    expect(fixture.reserves().filter((record) => record.state !== "destroyed")).toHaveLength(3);
    expect(presence.read()?.retireAtMs).toBe(1_500);
  });

  it.each(["removed", "replaced"] as const)(
    "does not admit a reserve after the default repository is %s during preparation",
    async (change) => {
      const presence = presencePool();
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const prepare = presence.prepareIntent.getMockImplementation()!;
      presence.prepareIntent.mockImplementationOnce(async (...args) => {
        entered.resolve();
        await release.promise;
        return prepare(...args);
      });
      const maintaining = presence.owner.setHumanPresence(true);
      const rejected = expect(maintaining).rejects.toThrow("repository policy changed");
      await entered.promise;
      if (change === "removed") {
        presence.disableSource();
      } else {
        presence.setRepository({
          ...repository,
          source: { ...repository.source, url: "https://github.com/acme/replacement.git" },
        });
      }
      release.resolve();
      await rejected;
      expect(presence.write).not.toHaveBeenCalled();
      expect(presence.read()).toBeUndefined();
      expect(fixture.reserves()).toEqual([]);
    },
  );

  it("rechecks the default policy at the reserve database admission", async () => {
    const presence = presencePool();
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const ensure = fixture.store.ensurePreparedIntent.bind(fixture.store);
    vi.spyOn(fixture.store, "ensurePreparedIntent").mockImplementationOnce(async (request) => {
      entered.resolve();
      await release.promise;
      return ensure(request);
    });
    const maintaining = presence.owner.setHumanPresence(true);
    const rejected = expect(maintaining).rejects.toThrow("repository policy changed");
    await entered.promise;
    presence.disableSource();
    release.resolve();
    await rejected;
    expect(fixture.reserves()).toEqual([]);
  });

  it.each([false, true])(
    "carries current default policy to queued lifecycle effects (removed=%s)",
    async (removed) => {
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const transport = vi.fn();
      const presence = presencePool(undefined, "worker-turn", {
        reconcile: async (record, _signal, beforeReconcile) => {
          if (record.destroyRequestedAtMs !== null) {
            return;
          }
          entered.resolve();
          await release.promise;
          beforeReconcile();
          transport(record.environmentId);
        },
      });
      const maintaining = presence.owner.setHumanPresence(true);
      await entered.promise;
      if (removed) {
        presence.disableSource();
      }
      release.resolve();
      await maintaining;
      expect(transport).toHaveBeenCalledTimes(removed ? 0 : 3);
      expect(fixture.reserves().every((record) => record.destroyRequestedAtMs !== null)).toBe(
        removed,
      );
    },
  );

  it("does not publish a refreshed ref after human presence changes during resolution", async () => {
    const presence = presencePool();
    await presence.owner.setHumanPresence(true);
    presence.setRepository({ ...repository, baseCommit: "f".repeat(40) });
    fixture.nowMs = 61_000;
    const resolveIntent = presence.prepareIntent.getMockImplementation()!;
    let resume!: () => void;
    let started!: () => void;
    const resolving = new Promise<void>((resolve) => {
      started = resolve;
    });
    const released = new Promise<void>((resolve) => {
      resume = resolve;
    });
    presence.prepareIntent.mockImplementationOnce(async (...args) => {
      started();
      await released;
      return resolveIntent(...args);
    });
    const refresh = fixture.schedule(presence.owner);
    const rejected = expect(refresh).rejects.toThrow(
      "Authenticated human presence changed during repository preparation",
    );
    await resolving;
    const departure = presence.owner.setHumanPresence(false);
    const departureRejected = expect(departure).rejects.toThrow();
    resume();
    await Promise.all([rejected, departureRejected]);
    expect(presence.read()?.project).toMatchObject({ baseCommit: repository.baseCommit });
    expect(fixture.reserves().every((record) => record.preparation?.key === PREPARATION_KEY)).toBe(
      true,
    );
    await fixture.schedule(presence.owner);
    expect(presence.read()?.retireAtMs).toBe(961_000);
  });

  it.each([false, true])(
    "refills current demand after confirmed stale cleanup (standing=%s)",
    async (standingImage) => {
      if (standingImage) {
        vi.stubEnv("FACTORY_AUTH_MODE", "github");
      }
      try {
        const staleKey = "e".repeat(64);
        const oldRepository = {
          ...repository,
          key: "c".repeat(64),
          source: {
            ...repository.source,
            url: "https://github.com/acme/old-repo.git",
            repositoryId: "R_acme_old_repo",
          },
        };
        fixture.config.cloudWorkers!.profiles!.legacy = {
          provider: fixture.provider.id,
          settings: {},
        };
        for (const [index, stale] of [
          { profileId: "development", repository },
          { profileId: "development", repository: oldRepository },
          { profileId: "legacy", repository },
        ].entries()) {
          await fixture.seed(`stale-presence-${index}`, {
            reserve: true,
            profileId: stale.profileId,
            repository: stale.repository,
            preparationKey: staleKey,
            expiresAtMs: Number.MAX_SAFE_INTEGER,
          });
        }
        fixture.nowMs = 2_001;
        let cleanupConfirmed = false;
        const reservedCounts: number[] = [];
        const reconcile = vi.fn<PoolOptions["reconcile"]>(
          async (record, _signal, beforeReconcile) => {
            beforeReconcile();
            reservedCounts.push(fixture.store.preparedReservationEnvironmentIds().length);
            if (record.destroyRequestedAtMs !== null && cleanupConfirmed) {
              await fixture.store.transition({
                environmentId: record.environmentId,
                from: "requested",
                to: "failed",
                patch: { lastError: "fixture confirmed allocation cleanup" },
              });
            }
          },
        );
        const presence = presencePool(undefined, "remote-exec", { reconcile }, standingImage);

        if (standingImage) {
          await fixture.schedule(presence.owner);
        } else {
          await presence.owner.setHumanPresence(true);
        }
        const stale = fixture.reserves().filter((record) => record.preparation?.key === staleKey);
        expect(stale).toHaveLength(3);
        expect(stale.every((record) => record.destroyRequestedAtMs === 2_001)).toBe(true);
        expect(
          fixture.reserves().filter((record) => record.preparation?.key === PREPARATION_KEY),
        ).toHaveLength(0);

        cleanupConfirmed = true;
        await fixture.schedule(presence.owner);
        const current = fixture
          .reserves()
          .filter((record) => record.preparation?.key === PREPARATION_KEY);
        expect(current).toHaveLength(3);
        expect(current.every((record) => record.state === "requested")).toBe(true);
        expect(current.map((record) => record.profileSnapshot.project)).toEqual([
          expect.objectContaining(standingImage ? imageReserveProject("gateway-test") : repository),
          expect.objectContaining(standingImage ? imageReserveProject("gateway-test") : repository),
          expect.objectContaining(standingImage ? imageReserveProject("gateway-test") : repository),
        ]);
        expect(fixture.store.preparedReservationEnvironmentIds()).toHaveLength(3);
        expect(Math.max(...reservedCounts)).toBe(3);
        expect(fixture.nowMs).toBe(2_001);
        expect(fixture.provider.notePreparedDemand).not.toHaveBeenCalled();
        if (standingImage) {
          expect(presence.write).not.toHaveBeenCalled();
        }
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );
});
