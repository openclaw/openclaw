import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, vi } from "vitest";
import type { CloudWorkerProfileConfig } from "../../config/types.cloud-workers.js";
import type { OpenClawConfig } from "../../config/types.js";
import type { WorkerProfile, WorkerProvider } from "../../plugins/types.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { hashWorkerCredential } from "./credential.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { createPreparedWorkerPool } from "./prepared-pool.js";
import type { WorkerEnvironmentService } from "./service.js";
import type { WorkerEnvironmentRecord } from "./store.js";
import { createWorkerEnvironmentStore } from "./store.js";

export const PROJECT_KEY = "a".repeat(64);
export const PREPARATION_KEY = "b".repeat(64);
const BUNDLE_HASH = "c".repeat(64);
export const IDLE_TIMEOUT_MS = 1_000;
export const RECEIPT = {
  bundleHash: BUNDLE_HASH,
  openclawVersion: "2026.8.1",
  protocolFeatures: [],
};
export type PoolOptions = Parameters<typeof createPreparedWorkerPool>[0];

export function usePreparedPoolFixture() {
  let root: string;
  let database: OpenClawStateDatabase;
  let store: ReturnType<typeof createWorkerEnvironmentStore>;
  let config: OpenClawConfig;
  let developmentProfile: CloudWorkerProfileConfig;
  let nowMs: number;
  let abort: AbortController;
  let provider: WorkerProvider;
  let service: WorkerEnvironmentService | undefined;
  let releases: Array<() => void>;
  let operations: Set<Promise<void>>;
  const openStore = () => {
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    store = createWorkerEnvironmentStore({ database, now: () => nowMs });
  };
  const reopenStore = () => {
    closeOpenClawStateDatabaseForTest();
    openStore();
  };

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "openclaw-prepared-pool-"));
    nowMs = 1_000;
    abort = new AbortController();
    releases = [];
    operations = new Set();
    service = undefined;
    developmentProfile = { provider: "test-provider", settings: {} };
    config = { cloudWorkers: { profiles: { development: developmentProfile } } };
    provider = {
      id: "test-provider",
      resolvePreparedIdleTimeoutMs: () => IDLE_TIMEOUT_MS,
      resolveAllocation: vi.fn(async () => ({ leaseId: "resolved-lease", sharedHost: false })),
      provision: vi.fn(async () => ({ leaseId: "new-lease", node: { deviceId: "new-node" } })),
      inspect: vi.fn(async () => ({ status: "active" as const })),
      destroy: vi.fn(async () => {}),
      notePreparedDemand: vi.fn(async () => {}),
    };
    openStore();
  });

  afterEach(async () => {
    abort.abort();
    for (const release of releases) {
      release();
    }
    await Promise.allSettled(operations);
    await service?.stop();
    closeOpenClawStateDatabaseForTest();
    await fs.rm(root, { recursive: true, force: true });
  });

  function profile(
    projectKey = PROJECT_KEY,
    preparationKey = PREPARATION_KEY,
    runSetupScript?: boolean,
  ): WorkerProfile {
    return {
      settings: {},
      executionMode: "worker-turn",
      project: {
        key: projectKey,
        root: path.join(root, projectKey),
        baseCommit: "d".repeat(40),
        preparation: {
          key: preparationKey,
          cacheKey: "9".repeat(64),
          contractVersion: 1,
          ...(runSetupScript === false ? { runSetupScript: false } : {}),
          target: { machineClass: "standard", platform: "linux", arch: "x64" },
          artifacts: {
            nodeBootstrapSha256: "e".repeat(64),
            enabledPluginIds: [],
            workerBundleHash: BUNDLE_HASH,
            workerArchiveSha256: "f".repeat(64),
            openclawVersion: "2026.8.1",
            protocolFeatures: [],
          },
        },
      },
    };
  }

  function seed(
    environmentId: string,
    options: {
      projectKey?: string;
      preparationKey?: string;
      reserve?: boolean;
      runSetupScript?: boolean;
    } = {},
  ) {
    return store.createIntent({
      environmentId,
      providerId: provider.id,
      profileId: "development",
      provisionOperationId: `provision:${environmentId}`,
      profileSnapshot: profile(options.projectKey, options.preparationKey, options.runSetupScript),
      preparation: options.reserve
        ? {
            key: options.preparationKey ?? PREPARATION_KEY,
            demandAtMs: nowMs,
            expiresAtMs: nowMs + IDLE_TIMEOUT_MS,
          }
        : undefined,
    });
  }

  function credential(value: string, sessionId: string | null = value) {
    return {
      credentialHash: hashWorkerCredential(value),
      sessionId,
      rpcSetVersion: 1,
      expiresAtMs: nowMs + 10_000,
    };
  }

  function ready({ environmentId }: WorkerEnvironmentRecord) {
    store.transition({ environmentId, from: "requested", to: "provisioning" });
    return store.transition({
      environmentId,
      from: "provisioning",
      to: "ready",
      patch: {
        leaseId: `lease:${environmentId}`,
        nodeDeviceId: `node:${environmentId}`,
        sharedHost: false,
        bootstrapReceipt: RECEIPT,
        credential: credential(environmentId, null),
      },
    });
  }

  function attach(
    record: WorkerEnvironmentRecord,
    stage: "provisioning" | "syncing" | "active" = "active",
    activatedAtMs = nowMs,
  ) {
    const sessionId = `session:${record.environmentId}`;
    const sessionKey = `agent:main:${sessionId}`;
    const executionMode = "worker-turn";
    const identity = { sessionId, sessionKey, agentId: "main", executionMode } as const;
    const placements = createWorkerSessionPlacementStore({ database, now: () => nowMs });
    const requested = placements.startDispatch(identity);
    const assigned = record.preparation
      ? placements.bindPreparedEnvironment({
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
        })!
      : placements.transition({
          sessionId,
          from: "requested",
          to: "provisioning",
          expectedGeneration: requested.generation,
          patch: { environmentId: record.environmentId },
        });
    if (stage === "provisioning") {
      return store.get(record.environmentId)!;
    }
    const syncing = placements.transition({
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
    const attached = store.transition({
      environmentId: record.environmentId,
      from: "ready",
      to: "attached",
      placementBinding,
      patch: {
        attachedSessionIds: [sessionId],
        credential: credential(sessionId),
      },
    });
    if (stage === "active") {
      const starting = placements.transition({
        sessionId,
        from: "syncing",
        to: "starting",
        expectedGeneration: syncing.generation,
        patch: { workspaceBaseManifestRef: "manifest", remoteWorkspaceDir: "/workspace" },
      });
      nowMs = activatedAtMs;
      placements.transition({
        sessionId,
        from: "starting",
        to: "active",
        expectedGeneration: starting.generation,
        patch: { activeOwnerEpoch: attached.ownerEpoch },
      });
    }
    return store.get(attached.environmentId)!;
  }

  function teardown(record: WorkerEnvironmentRecord) {
    const environmentId = record.environmentId;
    const sessionId = `session:${environmentId}`;
    const placements = createWorkerSessionPlacementStore({ database, now: () => nowMs });
    const placement = placements.get(sessionId)!;
    if (placement.state === "active") {
      const ownerEpoch = placement.activeOwnerEpoch;
      const owner = { sessionId, environmentId, ownerEpoch };
      const expectedGeneration = placement.generation;
      const draining = placements.startDrain({ ...owner, expectedGeneration });
      placements.startReconcile({ ...owner, expectedGeneration: draining.generation });
    }
    placements.fail({ sessionId, recoveryError: "session teardown" });
    destroy(record);
  }

  function destroy(record: WorkerEnvironmentRecord) {
    const environmentId = record.environmentId;
    store.requestDestroy({ environmentId, state: record.state });
    store.transition({ environmentId, from: record.state, to: "draining" });
    store.transition({ environmentId, from: "draining", to: "destroying" });
    store.transition({ environmentId, from: "destroying", to: "destroyed" });
  }

  function pool(overrides: Partial<PoolOptions> = {}) {
    return createPreparedWorkerPool({
      store,
      getConfig: () => config,
      resolveProvider: () => provider,
      prepareRetention: async () => ({ assertCurrent: () => {} }),
      prepareIntent: async (_profileId, { projectPath }) => ({
        providerId: provider.id,
        profileSnapshot: profile(path.basename(projectPath!)),
        preparationKey: PREPARATION_KEY,
      }),
      assertIntentCurrent: () => {},
      reconcile: async () => {},
      signal: abort.signal,
      now: () => nowMs,
      warn: vi.fn(),
      ...overrides,
    });
  }

  function schedule(owner: ReturnType<typeof pool>) {
    const operation = owner.schedule();
    operations.add(operation);
    const release = () => operations.delete(operation);
    void operation.then(release, release);
    return operation;
  }

  const reserves = () => store.list().filter((record) => record.preparation !== null);

  return {
    get root() {
      return root;
    },
    get database() {
      return database;
    },
    get store() {
      return store;
    },
    get config() {
      return config;
    },
    get developmentProfile() {
      return developmentProfile;
    },
    get nowMs() {
      return nowMs;
    },
    set nowMs(value: typeof nowMs) {
      nowMs = value;
    },
    get abort() {
      return abort;
    },
    get provider() {
      return provider;
    },
    set provider(value: typeof provider) {
      provider = value;
    },
    get service() {
      return service;
    },
    set service(value: typeof service) {
      service = value;
    },
    get releases() {
      return releases;
    },
    get operations() {
      return operations;
    },
    reopenStore,
    profile,
    seed,
    credential,
    ready,
    attach,
    teardown,
    destroy,
    pool,
    schedule,
    reserves,
  };
}
