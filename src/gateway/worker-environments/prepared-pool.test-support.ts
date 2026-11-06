import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { CloudWorkerProfileConfig } from "../../config/types.cloud-workers.js";
import type { OpenClawConfig } from "../../config/types.js";
import type { WorkerProvider } from "../../plugins/types.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { hashWorkerCredential } from "./credential.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import type { WorkerProviderPreparedIntent } from "./preparation-identity.js";
import type { PreparedPoolPresenceDemand } from "./prepared-pool-presence.types.js";
import { createPreparedWorkerPool } from "./prepared-pool.js";
import type { createWorkerProviderIntent } from "./provider-intent.js";
import type { RepositoryWorkerProjectSnapshot } from "./repository-project-source.schema.js";
import type { WorkerEnvironmentService } from "./service.js";
import type { WorkerEnvironmentRecord } from "./store.js";
import { createWorkerEnvironmentStore } from "./store.js";

export const PROJECT_KEY = "a".repeat(64);
export const PREPARATION_KEY = "b".repeat(64);
const BUNDLE_HASH = "c".repeat(64);
export const IDLE_TIMEOUT_MS = 1_000;
export const PRESENCE_REPOSITORY: RepositoryWorkerProjectSnapshot = {
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
export const presenceDemand = (): PreparedPoolPresenceDemand => ({
  revision: 1,
  profileId: "development",
  requestedRef: "main",
  preparationKey: PREPARATION_KEY,
  project: PRESENCE_REPOSITORY,
  lastPresentAtMs: 1_000,
  retireAtMs: null,
});
export const RECEIPT = {
  bundleHash: BUNDLE_HASH,
  openclawVersion: "2026.8.1",
  protocolFeatures: [],
};
export type PoolOptions = Parameters<typeof createPreparedWorkerPool>[0];
export const PREPARATION_TARGET = {
  machineClass: "standard",
  platform: "linux",
  arch: "x64",
} as const;
export const createPreparationArtifacts = () => ({
  nodeBootstrapSha256: "e".repeat(64),
  enabledPluginIds: [],
  workerBundleHash: BUNDLE_HASH,
  workerArchiveSha256: "f".repeat(64),
  openclawVersion: "2026.8.1",
  protocolFeatures: [],
});

class PreparedPoolFixture {
  root!: string;
  database!: OpenClawStateDatabase;
  store!: Awaited<ReturnType<typeof createWorkerEnvironmentStore>>;
  config!: OpenClawConfig;
  developmentProfile!: CloudWorkerProfileConfig;
  nowMs!: number;
  abort!: AbortController;
  provider!: WorkerProvider;
  service!: WorkerEnvironmentService | undefined;
  releases!: Array<() => void>;
  operations!: Set<Promise<void>>;
  constructor() {
    beforeEach(async () => {
      this.root = await fs.mkdtemp(
        path.join(await fs.realpath(os.tmpdir()), "openclaw-prepared-pool-"),
      );
      this.nowMs = 1_000;
      this.abort = new AbortController();
      this.releases = [];
      this.operations = new Set();
      this.service = undefined;
      this.developmentProfile = { provider: "test-provider", settings: {} };
      this.config = { cloudWorkers: { profiles: { development: this.developmentProfile } } };
      this.provider = {
        id: "test-provider",
        resolvePreparedIdleTimeoutMs: () => IDLE_TIMEOUT_MS,
        resolveAllocation: vi.fn(async () => ({ leaseId: "resolved-lease", sharedHost: false })),
        provision: vi.fn(async () => ({ leaseId: "new-lease", node: { deviceId: "new-node" } })),
        inspect: vi.fn(async () => ({ status: "active" as const })),
        destroy: vi.fn(async () => {}),
        notePreparedDemand: vi.fn(async () => {}),
      };
      await this.openStore();
    });
    afterEach(async () => {
      this.abort.abort();
      for (const release of this.releases) {
        release();
      }
      await Promise.allSettled(this.operations);
      await this.service?.stop();
      await closeOpenClawStateDatabaseAsync();
      closeOpenClawStateDatabaseForTest();
      await fs.rm(this.root, { recursive: true, force: true });
    });
  }
  private openStore = async () => {
    this.database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: this.root } });
    this.store = await createWorkerEnvironmentStore({
      database: this.database,
      now: () => this.nowMs,
    });
  };

  reopenStore = async () => {
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    await this.openStore();
  };

  gate = () => {
    const entered = createDeferred();
    const release = createDeferred();
    this.releases.push(() => release.resolve());
    return { entered, release };
  };

  intentOwnerOptions = (
    projectNamespace: string,
  ): Parameters<typeof createWorkerProviderIntent>[0] => {
    Object.assign(this.provider, {
      requiresNodeEnrollment: true,
      supportsProjectPreparation: () => true,
      resolvePreparationTarget: () => PREPARATION_TARGET,
    });
    return {
      store: this.store,
      getConfig: () => this.config,
      projectNamespace,
      providerFor: () => this.provider,
      prepareNodeArtifacts: async () => ({
        artifacts: createPreparationArtifacts(),
        assertCurrent: () => {},
      }),
      resumeProvision: async (record) => await this.ready(record),
      isStopping: () => false,
      withLock: async (_environmentId, task) => task(),
    };
  };

  profile = (
    projectKey = PROJECT_KEY,
    preparationKey = PREPARATION_KEY,
    runSetupScript?: boolean,
    repository?: RepositoryWorkerProjectSnapshot,
  ) =>
    ({
      settings: {},
      executionMode: "worker-turn",
      project: {
        ...(repository ?? {
          key: projectKey,
          root: path.join(this.root, projectKey),
          baseCommit: "d".repeat(40),
        }),
        preparation: {
          key: preparationKey,
          cacheKey: "9".repeat(64),
          contractVersion: 1,
          ...(runSetupScript === false ? { runSetupScript: false } : {}),
          target: { ...PREPARATION_TARGET },
          artifacts: createPreparationArtifacts(),
        },
      },
    }) satisfies WorkerProviderPreparedIntent["profileSnapshot"];

  intent = (projectKey = PROJECT_KEY) => ({
    providerId: this.provider.id,
    profileSnapshot: this.profile(projectKey),
  });

  seed = (
    environmentId: string,
    options: {
      projectKey?: string;
      preparationKey?: string;
      reserve?: boolean;
      purpose?: "reserve" | "build";
      runSetupScript?: boolean;
      repository?: RepositoryWorkerProjectSnapshot;
      profileId?: string;
      expiresAtMs?: number;
    } = {},
  ) =>
    this.store.createIntent({
      environmentId,
      providerId: this.provider.id,
      profileId: options.profileId ?? "development",
      provisionOperationId: `provision:${environmentId}`,
      profileSnapshot: this.profile(
        options.projectKey,
        options.preparationKey,
        options.runSetupScript,
        options.repository,
      ),
      preparation:
        options.reserve || options.purpose
          ? {
              purpose: options.purpose ?? "reserve",
              key: options.preparationKey ?? PREPARATION_KEY,
              demandAtMs: this.nowMs,
              expiresAtMs: options.expiresAtMs ?? this.nowMs + IDLE_TIMEOUT_MS,
            }
          : undefined,
    });

  credential = (value: string, sessionId: string | null = value) => ({
    credentialHash: hashWorkerCredential(value),
    sessionId,
    rpcSetVersion: 1,
    expiresAtMs: this.nowMs + 10_000,
  });

  ready = async ({ environmentId }: WorkerEnvironmentRecord) => {
    await this.store.transition({ environmentId, from: "requested", to: "provisioning" });
    return await this.store.transition({
      environmentId,
      from: "provisioning",
      to: "ready",
      patch: {
        leaseId: `lease:${environmentId}`,
        nodeDeviceId: `node:${environmentId}`,
        sharedHost: false,
        bootstrapReceipt: RECEIPT,
        credential: this.credential(environmentId, null),
      },
    });
  };

  attach = async (
    record: WorkerEnvironmentRecord,
    stage: "provisioning" | "syncing" | "active" = "active",
    activatedAtMs = this.nowMs,
  ) => {
    const sessionId = `session:${record.environmentId}`;
    const sessionKey = `agent:main:${sessionId}`;
    const executionMode = "worker-turn";
    const identity = { sessionId, sessionKey, agentId: "main", executionMode } as const;
    const placements = createWorkerSessionPlacementStore({
      database: this.database,
      now: () => this.nowMs,
    });
    const requested = await placements.startDispatch(identity);
    const assigned = record.preparation
      ? (await placements.bindPreparedEnvironment({
          ...identity,
          expectedGeneration: requested.generation,
          environmentId: record.environmentId,
          ownerEpoch: record.ownerEpoch,
          providerId: record.providerId,
          profileId: record.profileId,
          preparationKey: record.preparation.key,
          nodeDeviceId: record.nodeDeviceId!,
          leaseId: record.leaseId!,
          bundleHash: BUNDLE_HASH,
          assertCurrent: () => {},
        }))!
      : await placements.transition({
          sessionId,
          from: "requested",
          to: "provisioning",
          expectedGeneration: requested.generation,
          patch: { environmentId: record.environmentId },
        });
    if (stage === "provisioning") {
      return this.store.get(record.environmentId)!;
    }
    const syncing = await placements.transition({
      sessionId,
      from: "provisioning",
      to: "syncing",
      expectedGeneration: assigned.generation,
      patch: { workerBundleHash: BUNDLE_HASH },
    });
    const placementBinding = record.preparation
      ? {
          ...identity,
          generation: syncing.generation,
          preparationKey: record.preparation.key,
          assertCurrent: () => {},
        }
      : undefined;
    const attached = await this.store.transition({
      environmentId: record.environmentId,
      from: "ready",
      to: "attached",
      placementBinding,
      patch: {
        attachedSessionIds: [sessionId],
        credential: this.credential(sessionId),
      },
    });
    if (stage === "active") {
      const starting = await placements.transition({
        sessionId,
        from: "syncing",
        to: "starting",
        expectedGeneration: syncing.generation,
        patch: { workspaceBaseManifestRef: "manifest", remoteWorkspaceDir: "/workspace" },
      });
      this.nowMs = activatedAtMs;
      await placements.transition({
        sessionId,
        from: "starting",
        to: "active",
        expectedGeneration: starting.generation,
        patch: { activeOwnerEpoch: attached.ownerEpoch },
      });
    }
    return this.store.get(attached.environmentId)!;
  };

  teardown = async (record: WorkerEnvironmentRecord) => {
    const environmentId = record.environmentId;
    const sessionId = `session:${environmentId}`;
    const placements = createWorkerSessionPlacementStore({
      database: this.database,
      now: () => this.nowMs,
    });
    const placement = placements.get(sessionId)!;
    if (placement.state === "active") {
      const ownerEpoch = placement.activeOwnerEpoch;
      const owner = { sessionId, environmentId, ownerEpoch };
      const expectedGeneration = placement.generation;
      const draining = await placements.startDrain({ ...owner, expectedGeneration });
      await placements.startReconcile({ ...owner, expectedGeneration: draining.generation });
    }
    await placements.fail({ sessionId, recoveryError: "session teardown" });
    await this.destroy(record);
  };

  destroy = async (record: WorkerEnvironmentRecord) => {
    const environmentId = record.environmentId;
    await this.store.requestDestroy({ environmentId, state: record.state });
    await this.store.transition({ environmentId, from: record.state, to: "draining" });
    await this.store.transition({ environmentId, from: "draining", to: "destroying" });
    await this.store.transition({ environmentId, from: "destroying", to: "destroyed" });
  };

  pool = (overrides: Partial<PoolOptions> = {}) =>
    createPreparedWorkerPool({
      store: this.store,
      getConfig: () => this.config,
      resolveProvider: () => this.provider,
      prepareRetention: async () => ({ isCurrent: () => true }),
      prepareIntent: async (_profileId, { projectPath }) =>
        this.intent(path.basename(projectPath!)),
      assertIntentCurrent: () => {},
      reconcile: async () => {},
      signal: this.abort.signal,
      now: () => this.nowMs,
      warn: vi.fn(),
      ...overrides,
    });

  schedule = (owner: ReturnType<PreparedPoolFixture["pool"]>) => {
    const operation = owner.schedule();
    this.operations.add(operation);
    const release = () => this.operations.delete(operation);
    void operation.then(release, release);
    return operation;
  };

  reserves = () => this.store.list().filter((record) => record.preparation !== null);

  readySeed = async (id: string, options?: Parameters<PreparedPoolFixture["seed"]>[1]) =>
    this.ready(await this.seed(id, options));

  attachSeed = async (id: string, options?: Parameters<PreparedPoolFixture["seed"]>[1]) =>
    this.attach(await this.readySeed(id, options));

  readyReserves = () => Promise.all(this.reserves().map(this.ready));
}

export function usePreparedPoolFixture() {
  return new PreparedPoolFixture();
}
