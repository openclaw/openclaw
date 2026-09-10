// Replay, restart-adoption, and serialization coverage for worker provider provisioning.
// Split from provider-provisioning.test.ts to stay under the max-lines cap.
import { expectDefined } from "@openclaw/normalization-core";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { describe, expect, it, vi } from "vitest";
import { WorkerProviderError, type WorkerProvider } from "../../plugins/types.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import * as support from "./service.test-support.js";
import { createWorkerEnvironmentStore } from "./store.js";

type WorkerEnvironmentServiceError = support.WorkerEnvironmentServiceError;

describe("worker environment service provision replay", () => {
  support.setupWorkerEnvironmentServiceSuite();

  it("retains an indeterminate node lease when runtime preflight fails after restart", async () => {
    const provision = vi.fn<WorkerProvider["provision"]>(async () => {
      throw new Error("node allocation response was lost");
    });
    const destroy = vi.fn(async () => {});
    const provider = support.createProvider({
      requiresNodeEnrollment: true,
      provisionBeforeInstallation: true,
      provision,
      destroy,
    });
    const enrollment = async () => {
      throw new Error("enrollment must not run");
    };
    const first = support.createService(provider, { prepareNodeEnrollment: enrollment });
    await expect(first.create("development", "preflight-replay")).rejects.toMatchObject({
      code: "provider_failure",
    });
    const original = support.testState.store.list()[0]!;
    expect(original.state).toBe("provisioning");
    await support.reopenWorkerEnvironmentStore();
    const restarted = support.createService(provider, {
      prepareNodeEnrollment: enrollment,
      prepareNodeBootstrap: async () => {
        throw new Error("runtime preparation unavailable");
      },
    });
    restarted.start();
    await support.waitForFast(() =>
      expect(support.testState.store.get(original.environmentId)?.lastError).toContain(
        "runtime preparation unavailable",
      ),
    );
    expect(support.testState.store.get(original.environmentId)).toMatchObject({
      state: "provisioning",
      provisionOperationId: original.provisionOperationId,
      leaseId: null,
    });
    expect(provision).toHaveBeenCalledOnce();
    expect(destroy).not.toHaveBeenCalled();
    await expect(restarted.destroy(original.environmentId)).resolves.toMatchObject({
      state: "destroyed",
    });
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("adopts one committed provision across a service and store restart", async () => {
    const physicalLeases = new Set<string>();
    const operationIds: string[] = [];
    const machineClasses: Array<string | undefined> = [];
    const operatingSystems: Array<string | undefined> = [];
    const destroyed: string[] = [];
    let creates = 0;
    let loseFirstReply = true;
    const provider = () =>
      support.createProvider({
        provision: async (_profile, operationId, options) => {
          operationIds.push(operationId);
          machineClasses.push(options?.machineClass);
          operatingSystems.push(options?.os);
          if (!physicalLeases.has("lease-restarted")) {
            creates += 1;
            physicalLeases.add("lease-restarted");
          }
          if (loseFirstReply) {
            loseFirstReply = false;
            throw new Error("provider response was lost after commit");
          }
          return { leaseId: "lease-restarted", ssh: support.SSH_ENDPOINT };
        },
        destroy: async ({ leaseId }) => {
          destroyed.push(leaseId);
          physicalLeases.delete(leaseId);
        },
      });
    const first = support.createService(provider());

    await expect(
      first.create(
        "development",
        "request-restart-replay",
        "large",
        undefined,
        undefined,
        undefined,
        "os-a",
      ),
    ).rejects.toMatchObject({
      code: "provider_failure",
    } satisfies Partial<WorkerEnvironmentServiceError>);
    const environmentId = expectDefined(
      support.testState.store.list()[0],
      "persisted provision intent",
    ).environmentId;
    const operationId = expectDefined(
      support.testState.store.get(environmentId),
      "persisted provision record",
    ).provisionOperationId;
    expect(operationId).toMatch(/^provision:v2:[a-f0-9]{64}$/u);
    expect(support.testState.store.get(environmentId)).toMatchObject({
      state: "provisioning",
      leaseId: null,
    });

    await first.stop();
    support.testState.service = undefined;
    closeOpenClawStateDatabaseForTest();
    support.testState.stateDb = openOpenClawStateDatabase({
      env: { OPENCLAW_STATE_DIR: support.testState.root },
    });
    support.testState.store = createWorkerEnvironmentStore({
      database: support.testState.stateDb,
      now: () => support.testState.nowMs,
    });

    const restarted = support.createService(provider());
    restarted.start();
    await support.waitForFast(() =>
      expect(support.testState.store.get(environmentId)).toMatchObject({
        state: "ready",
        leaseId: "lease-restarted",
        lastError: null,
      }),
    );
    await restarted.destroy(environmentId);

    expect(creates).toBe(1);
    expect(operationIds).toEqual([operationId, operationId]);
    expect(machineClasses).toEqual(["large", "large"]);
    expect(operatingSystems).toEqual(["os-a", "os-a"]);
    expect(destroyed).toEqual(["lease-restarted"]);
    expect(physicalLeases.size).toBe(0);
    expect(support.testState.store.get(environmentId)).toMatchObject({
      state: "destroyed",
      leaseId: "lease-restarted",
    });
  });

  it.each([
    { released: true, verbose: false },
    { released: false, verbose: false },
    { released: true, verbose: true },
    { released: false, verbose: true },
  ])(
    "recovers indeterminate cleanup (released: $released, verbose: $verbose)",
    async ({ released, verbose }) => {
      const leaseId = "lease:worker-provision-cleanup";
      const provisionDiagnosis = "worker enrollment failed: tar: Unexpected EOF in archive";
      const cleanupDiagnosis = "provider stop timed out after release was requested";
      const secret = `synthetic-worker-auth-${"x".repeat(48)}`;
      const progress = String.fromCodePoint(0x1f9ea).repeat(200);
      const provisionDetail = verbose
        ? `Crabbox worker bootstrap failed with exit code 1: ... ${progress} --provider aws --type worker\nAuthorization: Bearer ${secret}\n${provisionDiagnosis}`
        : provisionDiagnosis;
      const cleanupDetail = verbose
        ? `Crabbox stop did not exit normally (timeout): ... ${progress} --provider aws --type worker\nAuthorization: Bearer ${secret}\n${cleanupDiagnosis}`
        : cleanupDiagnosis;
      const provision = vi.fn(async () => {
        throw WorkerProviderError.cleanupIndeterminate(
          leaseId,
          new Error(provisionDetail),
          new Error(cleanupDetail),
        );
      });
      const inspect = vi.fn(async () => ({
        status: released ? ("destroyed" as const) : ("active" as const),
      }));
      const destroy = vi.fn(async () => {});
      const provider = support.createProvider({ provision, inspect, destroy });
      const workerService = support.createService(provider);

      const failure = await workerService
        .create("development", "request-provision-cleanup")
        .catch((error: unknown) => error);
      expect(failure).toMatchObject({
        code: "provider_failure",
      } satisfies Partial<WorkerEnvironmentServiceError>);
      if (!(failure instanceof Error)) {
        throw new Error("expected worker creation to fail");
      }
      const pending = expectDefined(
        support.testState.store.list()[0],
        "persisted provision cleanup",
      );
      const diagnostic = expectDefined(pending.lastError, "persisted cleanup diagnostic");
      for (const detail of [failure.message, diagnostic]) {
        expect(detail).toContain(provisionDiagnosis);
        expect(detail).toContain(cleanupDiagnosis);
        expect(detail).not.toContain(secret);
        expect(detail).not.toContain("x".repeat(40));
        expect(detail).not.toMatch(/\s{2,}/u);
        expect(Buffer.from(detail, "utf8").toString("utf8")).toBe(detail);
        if (verbose) {
          expect(detail).toContain("Crabbox worker bootstrap failed with exit code 1");
          expect(detail).toContain("Crabbox stop did not exit normally (timeout)");
        }
      }
      expect(diagnostic.length).toBeLessThanOrEqual(1_024);
      expect(failure.message).toBe(
        `Worker provider operation failed; teardown is pending: ${diagnostic}`,
      );
      expect(pending).toMatchObject({
        state: "destroying",
        leaseId,
        destroyRequestedAtMs: expect.any(Number),
        teardownTerminalState: "failed",
        lastError: diagnostic,
      });

      await workerService.stop();
      support.testState.service = undefined;
      closeOpenClawStateDatabaseForTest();
      support.testState.stateDb = openOpenClawStateDatabase({
        env: { OPENCLAW_STATE_DIR: support.testState.root },
      });
      support.testState.store = createWorkerEnvironmentStore({
        database: support.testState.stateDb,
        now: () => support.testState.nowMs,
      });
      const restarted = support.createService(provider);
      restarted.start();
      await support.waitForFast(() =>
        expect(support.testState.store.get(pending.environmentId)).toMatchObject({
          state: "failed",
          leaseId: null,
        }),
      );

      expect(provision).toHaveBeenCalledTimes(1);
      expect(inspect).toHaveBeenCalledWith({ leaseId, profile: { region: "test" } });
      expect(destroy).toHaveBeenCalledTimes(released ? 0 : 1);
      if (!released) {
        expect(destroy).toHaveBeenCalledWith({ leaseId, profile: { region: "test" } });
      }
      expect(support.testState.store.get(pending.environmentId)).toMatchObject({
        state: "failed",
        leaseId: null,
        teardownTerminalState: "failed",
        lastError: diagnostic,
      });
    },
  );

  it("does not resolve a provider provision timeout when the service override is set", async () => {
    const resolveProvisionTimeoutMs = vi.fn(() => {
      throw new Error("provider timeout hook must not run");
    });
    const workerService = support.createService(
      support.createProvider({ resolveProvisionTimeoutMs }),
      {
        providerCallTimeoutMs: 1_000,
      },
    );

    await expect(
      workerService.create("development", "request-provider-timeout-override"),
    ).resolves.toMatchObject({ state: "ready" });
    expect(resolveProvisionTimeoutMs).not.toHaveBeenCalled();
  });

  it.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
    ["non-finite", Number.NaN],
    ["timer overflow", MAX_TIMER_TIMEOUT_MS + 1],
  ])("rejects a %s provider provision timeout before allocation", async (_label, timeoutMs) => {
    const provision = vi.fn(async () => ({
      leaseId: "lease-invalid-timeout",
      ssh: support.SSH_ENDPOINT,
    }));
    const workerService = support.createService(
      support.createProvider({
        provision,
        resolveProvisionTimeoutMs: () => timeoutMs,
      }),
    );

    await expect(
      workerService.create("development", `request-invalid-provider-timeout-${String(timeoutMs)}`),
    ).rejects.toMatchObject({
      code: "provider_failure",
      message: expect.stringContaining("Worker provider provision timeout must be an integer"),
    } satisfies Partial<WorkerEnvironmentServiceError>);
    expect(provision).not.toHaveBeenCalled();
    expect(support.testState.store.list()[0]).toMatchObject({
      state: "failed",
      leaseId: null,
    });
  });

  it("serializes allocation resolution and destroy behind a timed-out provider operation", async () => {
    const events: string[] = [];
    const operationIds: string[] = [];
    let active = 0;
    let maxActive = 0;
    let originalProvisionCalls = 0;
    let finishFirstProvision: (() => void) | undefined;
    const firstProvisionPending = new Promise<void>((resolve) => {
      finishFirstProvision = resolve;
    });
    const destroy = vi.fn(async () => {
      events.push("destroy:start");
      active += 1;
      maxActive = Math.max(maxActive, active);
      active -= 1;
      events.push("destroy:end");
    });
    const provider = support.createProvider({
      resolveAllocation: async () => {
        events.push("resolve");
        expect(active).toBe(0);
        return { leaseId: "lease-timeout-replay", sharedHost: false };
      },
      provision: async (_profile, operationId) => {
        originalProvisionCalls += 1;
        const call = originalProvisionCalls;
        operationIds.push(operationId);
        events.push(`provision:${call}:start`);
        active += 1;
        maxActive = Math.max(maxActive, active);
        if (call === 1) {
          await firstProvisionPending;
        }
        active -= 1;
        events.push(`provision:${call}:end`);
        return { leaseId: "lease-timeout-replay", ssh: support.SSH_ENDPOINT };
      },
      destroy,
      resolveProvisionTimeoutMs: () => 20,
    });
    const workerService = support.createService(provider);
    const creation = workerService.create("development", "request-provider-timeout-race");
    const creationResult = expect(creation).rejects.toMatchObject({
      code: "provider_failure",
    } satisfies Partial<WorkerEnvironmentServiceError>);
    let environmentId: string | undefined;
    let teardownResult: Promise<void> | undefined;
    try {
      await support.waitForFast(() => expect(events).toEqual(["provision:1:start"]));
      const queuedEnvironmentId = expectDefined(
        support.testState.store.list()[0],
        "timed-out provision row",
      ).environmentId;
      environmentId = queuedEnvironmentId;
      const teardown = workerService.destroy(queuedEnvironmentId);
      teardownResult = expect(teardown).resolves.toMatchObject({ state: "destroyed" });
      await creationResult;
      await support.waitForFast(() =>
        expect(
          support.testState.store.get(queuedEnvironmentId)?.destroyRequestedAtMs,
        ).not.toBeNull(),
      );
      expect(originalProvisionCalls).toBe(1);
      expect(destroy).not.toHaveBeenCalled();
      expect(maxActive).toBe(1);
    } finally {
      finishFirstProvision?.();
    }

    await teardownResult;
    const finalEnvironmentId = expectDefined(environmentId, "timed-out provision environment id");
    expect(operationIds).toHaveLength(1);
    expect(new Set(operationIds).size).toBe(1);
    expect(maxActive).toBe(1);
    expect(events).toEqual([
      "provision:1:start",
      "provision:1:end",
      "resolve",
      "destroy:start",
      "destroy:end",
    ]);
    expect(support.testState.store.get(finalEnvironmentId)).toMatchObject({ state: "destroyed" });
  });

  it("adopts an indeterminate allocation before a replay preparation failure", async () => {
    const events: string[] = [];
    let preparationFails = false;
    support.testState.prepareInstallation = vi.fn(async () => {
      events.push("prepare");
      if (preparationFails) {
        throw new Error("persisted bundle is unavailable");
      }
      return support.BUNDLE_ARTIFACT;
    });
    let provisionCalls = 0;
    const operationIds: string[] = [];
    const provider = support.createProvider({
      provision: async (_profile, operationId) => {
        events.push("provision");
        provisionCalls += 1;
        operationIds.push(operationId);
        if (provisionCalls === 1) {
          throw new Error("provision response was lost");
        }
        return { leaseId: "lease-replayed", ssh: support.SSH_ENDPOINT };
      },
      destroy: async () => void events.push("destroy"),
    });
    const workerService = support.createService(provider);

    await expect(
      workerService.create("development", "request-lost-provision"),
    ).rejects.toMatchObject({
      code: "provider_failure",
    } satisfies Partial<WorkerEnvironmentServiceError>);
    preparationFails = true;
    await workerService.reconcileOnce();

    expect(events).toEqual(["prepare", "provision", "provision", "prepare", "destroy"]);
    expect(new Set(operationIds).size).toBe(1);
    expect(support.testState.store.list()[0]).toMatchObject({
      state: "failed",
      leaseId: null,
      sshEndpoint: null,
      teardownTerminalState: "failed",
      lastError: "persisted bundle is unavailable",
    });
  });

  it.each([
    ["missing result", null, "invalid provision result"],
    ["missing transport", { leaseId: "lease-invalid" }, "invalid provision result"],
    [
      "ambiguous transport",
      { leaseId: "lease-invalid", ssh: support.SSH_ENDPOINT, node: { deviceId: "device-1" } },
      "invalid provision result",
    ],
    [
      "blank node device id",
      { leaseId: "lease-invalid", node: { deviceId: " " } },
      "invalid node device id",
    ],
    [
      "malformed SSH endpoint",
      { leaseId: "lease-invalid", ssh: { ...support.SSH_ENDPOINT, keyRef: "not-a-secret-ref" } },
      "SSH key must be a canonical SecretRef",
    ],
    [
      "excessive SSH fallback ports",
      {
        leaseId: "lease-invalid",
        ssh: {
          ...support.SSH_ENDPOINT,
          fallbackPorts: Array.from({ length: 11 }, (_, index) => 2300 + index),
        },
      },
      "SSH fallback ports cannot exceed 10",
    ],
    [
      "invalid shared-host declaration",
      { leaseId: "lease-invalid", ssh: support.SSH_ENDPOINT, sharedHost: "yes" },
      "invalid provision result",
    ],
    [
      "unsupported desktop protocol",
      {
        leaseId: "lease-invalid",
        ssh: support.SSH_ENDPOINT,
        desktop: { protocol: "rdp", port: 5900 },
      },
      'desktop protocol must be "rfb"',
    ],
    [
      "invalid desktop port",
      {
        leaseId: "lease-invalid",
        ssh: support.SSH_ENDPOINT,
        desktop: { protocol: "rfb", port: 0 },
      },
      "desktop port must be an integer",
    ],
    [
      "relative desktop password path",
      {
        leaseId: "lease-invalid",
        ssh: support.SSH_ENDPOINT,
        desktop: { protocol: "rfb", port: 5900, passwordFilePath: "vnc.password" },
      },
      "desktop password file path must be absolute",
    ],
    [
      "unrecognized desktop app metadata",
      {
        leaseId: "lease-invalid",
        ssh: support.SSH_ENDPOINT,
        desktop: {
          protocol: "rfb",
          port: 5900,
          apps: [
            {
              id: "browser",
              executablePath: "/usr/local/bin/openclaw-worker-browser",
              cdpPort: 9222,
              command: "chromium",
            },
          ],
        },
      },
      "browser desktop app contains unknown fields",
    ],
  ])("keeps %s from a provider retryable", async (_name, result, error) => {
    const workerService = support.createService(
      support.createProvider({ provision: async () => result as never }),
    );

    await expect(workerService.create("development", "request-malformed")).rejects.toMatchObject({
      code: "provider_failure",
      message: expect.stringContaining(error),
    } satisfies Partial<WorkerEnvironmentServiceError>);
    expect(support.testState.store.list()[0]).toMatchObject({
      state: "provisioning",
      lastError: expect.stringContaining(error),
    });
  });
});
