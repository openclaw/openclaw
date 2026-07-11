import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.js";
import {
  WorkerProviderError,
  type WorkerProvider,
  type WorkerSshEndpoint,
} from "../../plugins/types.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import {
  createWorkerEnvironmentService,
  WorkerEnvironmentServiceError,
  type WorkerEnvironmentService,
} from "./service.js";
import { createWorkerEnvironmentStore, type WorkerEnvironmentStore } from "./store.js";

const SSH_ENDPOINT: WorkerSshEndpoint = {
  host: "worker.example.test",
  port: 22,
  user: "openclaw",
  keyRef: { source: "file", provider: "worker-keys", id: "/development-key" },
};

type WorkerLifecycleLease = Parameters<WorkerProvider["inspect"]>[0];

describe("worker environment service", () => {
  let root: string;
  let store: WorkerEnvironmentStore;
  let service: WorkerEnvironmentService | undefined;
  let config: OpenClawConfig;
  let nowMs: number;
  let providersEnabled: boolean;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "openclaw-worker-service-"));
    const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    nowMs = 1_000;
    providersEnabled = true;
    store = createWorkerEnvironmentStore({ database, now: () => nowMs });
    config = {
      cloudWorkers: {
        profiles: {
          development: {
            provider: "fake",
            settings: { region: "test" },
            lifetime: { idleTimeoutMinutes: 10 },
          },
        },
      },
    };
  });

  afterEach(async () => {
    await service?.stop();
    vi.useRealTimers();
    closeOpenClawStateDatabaseForTest();
    await fs.rm(root, { recursive: true, force: true });
  });

  function createService(provider: WorkerProvider) {
    service = createWorkerEnvironmentService({
      store,
      getConfig: () => config,
      resolveProvider: (providerId) =>
        providersEnabled && providerId === "fake" ? provider : undefined,
      reconcileIntervalMs: 25,
    });
    return service;
  }

  function createProvider(
    overrides: Partial<Pick<WorkerProvider, "provision" | "inspect" | "destroy">> = {},
  ): WorkerProvider {
    return {
      id: "fake",
      provision: async () => ({ leaseId: "lease-1", ssh: SSH_ENDPOINT }),
      inspect: async () => ({ status: "active" }),
      destroy: async () => {},
      ...overrides,
    };
  }

  function seedBootstrapping(environmentId: string) {
    const intent = store.createIntent({
      environmentId,
      providerId: "fake",
      profileId: "development",
      profileSnapshot: { settings: { region: "test" } },
      provisionOperationId: `provision:${environmentId}`,
    });
    const provisioning = store.transition({
      environmentId,
      from: intent.state,
      to: "provisioning",
    });
    return store.transition({
      environmentId,
      from: provisioning.state,
      to: "bootstrapping",
      patch: { leaseId: `lease:${environmentId}`, sshEndpoint: SSH_ENDPOINT },
    });
  }

  function seedReady(environmentId: string) {
    const bootstrapping = seedBootstrapping(environmentId);
    return store.transition({
      environmentId,
      from: bootstrapping.state,
      to: "ready",
    });
  }

  it("persists intent and an immutable profile snapshot before provisioning", async () => {
    const operationIds: string[] = [];
    const provider = createProvider({
      provision: async (profile, operationId) => {
        operationIds.push(operationId);
        expect(store.list()[0]).toMatchObject({
          state: "provisioning",
          provisionOperationId: operationId,
          profileSnapshot: {
            settings: { region: "test" },
            lifetime: { idleTimeoutMinutes: 10 },
          },
        });
        config.cloudWorkers!.profiles!.development.settings = { region: "mutated" };
        expect(profile).toEqual({ region: "test" });
        return { leaseId: "lease-1", ssh: SSH_ENDPOINT };
      },
    });

    const workerService = createService(provider);
    const result = await workerService.create("development", "request-1");
    const repeated = await workerService.create("development", "request-1");

    expect(result).toMatchObject({ state: "ready", leaseId: "lease-1" });
    expect(repeated.environmentId).toBe(result.environmentId);
    expect(operationIds).toHaveLength(1);
    expect(operationIds[0]).toMatch(/^provision:[a-f0-9]{64}$/u);
    expect(result.profileSnapshot).toMatchObject({ settings: { region: "test" } });
  });

  it("replays an indeterminate provision failure with the same operation id", async () => {
    const calls: string[] = [];
    let fail = true;
    const secret = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789";
    const provider = createProvider({
      provision: async (_profile, operationId) => {
        calls.push(operationId);
        if (fail) {
          throw new Error(`provider timeout ${secret}`);
        }
        return { leaseId: "lease-1", ssh: SSH_ENDPOINT };
      },
    });
    const workerService = createService(provider);

    await expect(workerService.create("development", "request-1")).rejects.toMatchObject({
      code: "provider_failure",
    } satisfies Partial<WorkerEnvironmentServiceError>);
    const environmentId = store.list()[0]?.environmentId;
    expect(environmentId).toBeTruthy();
    expect(store.get(environmentId!)).toMatchObject({
      state: "provisioning",
      leaseId: null,
    });
    expect(store.get(environmentId!)?.lastError).not.toContain(secret);

    fail = false;
    await workerService.reconcileOnce();

    expect(store.get(environmentId!)).toMatchObject({
      state: "ready",
      leaseId: "lease-1",
      lastError: null,
    });
    expect(calls).toHaveLength(2);
    expect(new Set(calls).size).toBe(1);
  });

  it.each([
    ["missing result", null, "invalid provision result"],
    [
      "malformed SSH endpoint",
      { leaseId: "lease-invalid", ssh: { ...SSH_ENDPOINT, keyRef: "not-a-secret-ref" } },
      "SSH key must be a canonical SecretRef",
    ],
  ])("keeps %s from a provider retryable", async (_name, result, error) => {
    const workerService = createService(createProvider({ provision: async () => result as never }));

    await expect(workerService.create("development", "request-malformed")).rejects.toMatchObject({
      code: "provider_failure",
    } satisfies Partial<WorkerEnvironmentServiceError>);
    expect(store.list()[0]).toMatchObject({
      state: "provisioning",
      lastError: expect.stringContaining(error),
    });
  });

  it("rejects plaintext secret fields before persisting intent", async () => {
    config.cloudWorkers!.profiles!.development.settings = { keyRef: "not-a-secret-ref" };
    const provision = vi.fn(createProvider().provision);

    await expect(
      createService(createProvider({ provision })).create("development", "request-secret"),
    ).rejects.toMatchObject({ code: "invalid_profile" });
    expect(provision).not.toHaveBeenCalled();
    expect(store.list()).toEqual([]);
  });

  it("records permanent provider profile rejection as terminal", async () => {
    let provisionCalls = 0;
    const provider = createProvider({
      provision: async () => {
        provisionCalls += 1;
        throw new WorkerProviderError("region is required");
      },
    });
    const workerService = createService(provider);

    await expect(workerService.create("development", "request-invalid")).rejects.toMatchObject({
      code: "invalid_profile",
    } satisfies Partial<WorkerEnvironmentServiceError>);
    const record = store.list()[0];
    expect(record).toMatchObject({ state: "failed", lastError: "region is required" });

    await workerService.reconcileOnce();
    await expect(workerService.destroy(record.environmentId)).resolves.toMatchObject({
      state: "failed",
    });
    expect(provisionCalls).toBe(1);
  });

  it("rejects non-canonical profile ids before persistence", async () => {
    const workerService = createService(createProvider());

    await expect(workerService.create(" development ", "request-spaced")).rejects.toMatchObject({
      code: "invalid_profile",
    } satisfies Partial<WorkerEnvironmentServiceError>);
    expect(store.list()).toEqual([]);
  });

  it.each(["direct destroy", "restart reconcile"] as const)(
    "cancels a requested intent without allocating on %s",
    async (mode) => {
      const intent = store.createIntent({
        environmentId: `worker-cancel-${mode}`,
        providerId: "fake",
        profileId: "development",
        profileSnapshot: { settings: { region: "test" } },
        provisionOperationId: `provision:cancel-${mode}`,
      });
      const provision = vi.fn(createProvider().provision);
      const workerService = createService(createProvider({ provision }));

      if (mode === "direct destroy") {
        await workerService.destroy(intent.environmentId);
      } else {
        store.requestDestroy({ environmentId: intent.environmentId, state: "requested" });
        providersEnabled = false;
        await workerService.reconcileOnce();
      }

      expect(provision).not.toHaveBeenCalled();
      expect(store.get(intent.environmentId)).toMatchObject({
        state: "failed",
        lastError: "Provisioning canceled before provider allocation",
        destroyRequestedAtMs: expect.any(Number),
      });
    },
  );

  it("inspects a persisted lease with its profile snapshot after profile removal", async () => {
    seedBootstrapping("worker-crash");
    config.cloudWorkers!.profiles = {};
    const inspected: WorkerLifecycleLease[] = [];
    const provider = createProvider({
      inspect: async (lease) => {
        inspected.push(lease);
        return { status: "active" };
      },
      provision: async () => {
        throw new Error("provision must not run for a known lease");
      },
    });

    await createService(provider).reconcileOnce();

    expect(inspected).toEqual([{ leaseId: "lease:worker-crash", profile: { region: "test" } }]);
    expect(store.get("worker-crash")).toMatchObject({
      state: "ready",
    });
  });

  it("orphans unknown active leases and adopts unknown expected teardown", async () => {
    seedReady("worker-unknown");
    seedReady("worker-transient");
    seedReady("worker-destroyed-unknown");
    store.requestDestroy({ environmentId: "worker-destroyed-unknown", state: "ready" });
    store.transition({
      environmentId: "worker-destroyed-unknown",
      from: "ready",
      to: "draining",
    });
    store.transition({
      environmentId: "worker-destroyed-unknown",
      from: "draining",
      to: "destroying",
    });
    const provider = createProvider({
      inspect: async ({ leaseId }) => {
        if (leaseId !== "lease:worker-transient") {
          return { status: "unknown" };
        }
        throw new Error("provider temporarily unavailable");
      },
    });

    await createService(provider).reconcileOnce();

    expect(store.get("worker-unknown")).toMatchObject({
      state: "orphaned",
    });
    expect(store.get("worker-transient")).toMatchObject({
      state: "ready",
      lastError: "provider temporarily unavailable",
    });
    expect(store.get("worker-destroyed-unknown")).toMatchObject({ state: "destroyed" });
  });

  it.each([null, { status: "future" }])(
    "retains retryable state for malformed inspection result %#",
    async (inspection) => {
      seedReady("worker-malformed");
      const provider = createProvider({ inspect: async () => inspection as never });

      await createService(provider).reconcileOnce();

      expect(store.get("worker-malformed")).toMatchObject({
        state: "ready",
        lastError: expect.stringContaining("invalid inspection"),
      });
    },
  );

  it("adopts provider-proven teardown through legal terminal transitions", async () => {
    seedReady("worker-destroyed-ready");
    seedReady("worker-destroyed-attached");
    store.transition({
      environmentId: "worker-destroyed-attached",
      from: "ready",
      to: "attached",
      patch: { attachedSessionIds: ["session-1"] },
    });
    seedReady("worker-destroyed-draining");
    store.transition({
      environmentId: "worker-destroyed-draining",
      from: "ready",
      to: "draining",
    });
    const provider = createProvider({
      inspect: async () => ({ status: "destroyed" }),
      destroy: async () => {
        throw new Error("destroy must not run for provider-proven teardown");
      },
    });

    await createService(provider).reconcileOnce();

    for (const environmentId of [
      "worker-destroyed-ready",
      "worker-destroyed-attached",
      "worker-destroyed-draining",
    ]) {
      expect(store.get(environmentId)).toMatchObject({
        state: "destroyed",
        attachedSessionIds: [],
      });
    }
  });

  it("keeps a failed destroy retryable and makes completed destroy idempotent", async () => {
    seedReady("worker-destroy");
    config.cloudWorkers!.profiles = {};
    let fail = true;
    const destroyed: WorkerLifecycleLease[] = [];
    const provider = createProvider({
      destroy: async (lease) => {
        destroyed.push(lease);
        if (fail) {
          throw new Error("destroy timeout");
        }
      },
    });
    const workerService = createService(provider);

    await expect(workerService.destroy("worker-destroy")).rejects.toMatchObject({
      code: "provider_failure",
    } satisfies Partial<WorkerEnvironmentServiceError>);
    expect(store.get("worker-destroy")).toMatchObject({
      state: "destroying",
      lastError: "destroy timeout",
    });

    fail = false;
    await workerService.reconcileOnce();
    expect(store.get("worker-destroy")).toMatchObject({ state: "destroyed" });
    await workerService.destroy("worker-destroy");
    expect(destroyed).toEqual([
      { leaseId: "lease:worker-destroy", profile: { region: "test" } },
      { leaseId: "lease:worker-destroy", profile: { region: "test" } },
    ]);
  });

  it("adopts an unpersisted provision result before destroying", async () => {
    const intent = store.createIntent({
      environmentId: "worker-pending-destroy",
      providerId: "fake",
      profileId: "development",
      profileSnapshot: { settings: { region: "test" } },
      provisionOperationId: "provision:pending-destroy",
    });
    store.transition({
      environmentId: intent.environmentId,
      from: "requested",
      to: "provisioning",
    });
    const destroyed: WorkerLifecycleLease[] = [];
    const provider = createProvider({
      provision: async () => {
        expect(store.get(intent.environmentId)?.destroyRequestedAtMs).not.toBeNull();
        return { leaseId: "lease-1", ssh: SSH_ENDPOINT };
      },
      destroy: async (lease) => void destroyed.push(lease),
    });

    const result = await createService(provider).destroy(intent.environmentId);

    expect(result.state).toBe("destroyed");
    expect(destroyed).toEqual([{ leaseId: "lease-1", profile: { region: "test" } }]);
  });

  it("retains teardown intent across an indeterminate provision failure", async () => {
    const intent = store.createIntent({
      environmentId: "worker-pending-destroy-retry",
      providerId: "fake",
      profileId: "development",
      profileSnapshot: { settings: { region: "test" } },
      provisionOperationId: "provision:pending-destroy-retry",
    });
    store.transition({
      environmentId: intent.environmentId,
      from: "requested",
      to: "provisioning",
    });
    let provisionFails = true;
    const destroyed: WorkerLifecycleLease[] = [];
    const provider = createProvider({
      provision: async () => {
        if (provisionFails) {
          throw new Error("provision outcome unknown");
        }
        return { leaseId: "lease-retried", ssh: SSH_ENDPOINT };
      },
      destroy: async (lease) => void destroyed.push(lease),
    });
    const workerService = createService(provider);

    providersEnabled = false;
    await expect(workerService.destroy(intent.environmentId)).rejects.toMatchObject({
      code: "provider_not_found",
    } satisfies Partial<WorkerEnvironmentServiceError>);
    expect(store.get(intent.environmentId)?.destroyRequestedAtMs).not.toBeNull();

    providersEnabled = true;
    await expect(workerService.destroy(intent.environmentId)).rejects.toMatchObject({
      code: "provider_failure",
    } satisfies Partial<WorkerEnvironmentServiceError>);
    expect(store.get(intent.environmentId)).toMatchObject({
      state: "provisioning",
      destroyRequestedAtMs: expect.any(Number),
    });

    provisionFails = false;
    await workerService.reconcileOnce();
    expect(store.get(intent.environmentId)?.state).toBe("destroyed");
    expect(destroyed).toEqual([{ leaseId: "lease-retried", profile: { region: "test" } }]);
  });

  it("reconciles unrelated leases concurrently", async () => {
    seedReady("worker-concurrent-a");
    seedReady("worker-concurrent-b");
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inspected: WorkerLifecycleLease[] = [];
    const provider = createProvider({
      inspect: async (lease) => {
        inspected.push(lease);
        await blocked;
        return { status: "active" };
      },
    });

    const reconciliation = createService(provider).reconcileOnce();
    try {
      await vi.waitFor(() => expect(inspected).toHaveLength(2));
    } finally {
      release?.();
    }
    await reconciliation;

    expect(new Set(inspected.map(({ leaseId }) => leaseId))).toEqual(
      new Set(["lease:worker-concurrent-a", "lease:worker-concurrent-b"]),
    );
  });

  it("owns and clears one periodic reconciliation timer", async () => {
    vi.useFakeTimers();
    const workerService = createService(createProvider());

    workerService.start();
    workerService.start();
    expect(vi.getTimerCount()).toBe(1);
    await workerService.stop();

    expect(vi.getTimerCount()).toBe(0);
  });

  it("starts without blocking gateway startup and drains reconciliation on stop", async () => {
    seedReady("worker-slow-inspection");
    let finishInspection: (() => void) | undefined;
    const inspectionPending = new Promise<void>((resolve) => {
      finishInspection = resolve;
    });
    const inspect = vi.fn(async () => {
      await inspectionPending;
      return { status: "active" as const };
    });
    const workerService = createService(createProvider({ inspect }));

    workerService.start();
    await vi.waitFor(() => expect(inspect).toHaveBeenCalledTimes(1));
    let stopped = false;
    const stopping = workerService.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    finishInspection?.();
    await stopping;
    expect(stopped).toBe(true);
  });
});
