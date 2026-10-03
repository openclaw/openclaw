import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import type { WorkerProvider as LegacyWorkerProvider } from "../../plugins/capability-provider.types.js";
import { completeWorkerNodeSetupForTest } from "./node-enrollment.test-support.js";
import * as support from "./service.test-support.js";

describe("worker provider invocation ownership", () => {
  support.setupWorkerEnvironmentServiceSuite({ reuseReadWorkers: true });

  it.each(["legacy", "v1"] as const)(
    "closes retained %s preparation and allocation callbacks on host return",
    async (version) => {
      let guard: (() => void) | undefined;
      let allocate: (() => Promise<unknown>) | undefined;
      let effects = 0;
      const prepareProvision: NonNullable<LegacyWorkerProvider["prepareProvision"]> = async (
        _profile,
        _operationId,
        options,
      ) => {
        guard = expectDefined(options?.assertCurrent, "host invocation guard");
        guard();
        const prepared = async () => {
          expectDefined(guard, "retained guard")();
          effects += 1;
          return { leaseId: "guarded-lease", ssh: support.SSH_ENDPOINT };
        };
        allocate = prepared;
        return prepared;
      };
      const modern = support.createProvider({ prepareProvision });
      // A genuinely legacy implementation accepts omitted options; the host still supplies them.
      const legacy: LegacyWorkerProvider = {
        id: modern.id,
        resolveAllocation: modern.resolveAllocation,
        inspect: modern.inspect,
        destroy: modern.destroy,
        prepareProvision,
        provision: async (...args) => (await prepareProvision(...args))(),
      };
      const provider = version === "legacy" ? legacy : modern;
      await expect(
        support.createService(provider).createWithRequest({
          profileId: "development",
          idempotencyKey: "guarded-create",
        }),
      ).resolves.toMatchObject({ state: "ready" });
      expect(effects).toBe(1);
      expect(() => expectDefined(guard, "retained guard")()).toThrow("operation is closed");
      await expect(expectDefined(allocate, "retained allocation")()).rejects.toThrow(
        "operation is closed",
      );
      expect(effects).toBe(1);
    },
  );

  it("keeps its guard live through its own enrolled-node publication, then closes it", async () => {
    const { store } = support.testState;
    const deviceId = "invocation-enrolled-node";
    let guard: (() => void) | undefined;
    const service = support.createService(
      support.createProvider({
        requiresNodeEnrollment: true,
        provisionBeforeInstallation: true,
        provision: async (_profile, _operationId, options) => {
          guard = expectDefined(options?.assertCurrent, "host provisioning guard");
          guard();
          const enrollment = await expectDefined(
            options?.beginNodeEnrollment,
            "enrollment callback",
          )();
          expect(enrollment.mode).toBe("connect");
          const enrolled = await enrollment.waitForDeviceId();
          // Real pairing completion changes nodeDeviceId inside this same operation.
          guard();
          return { leaseId: "enrolled-lease", node: { deviceId: enrolled }, sharedHost: false };
        },
      }),
      {
        prepareNodeEnrollment: async (record) => {
          const current = await store.ensureNodeEnrollment(record.environmentId);
          const setupId = expectDefined(current.nodeSetupId, "persisted enrollment setup");
          return {
            mode: "connect",
            setupId,
            setupCode: "fixture-setup-code",
            openclawVersion: "2026.8.1",
            displayName: "Invocation fixture",
            nodeBootstrap: support.NODE_BOOTSTRAP,
            waitForDeviceId: async () => {
              await completeWorkerNodeSetupForTest({
                baseDir: support.testState.root,
                store,
                setupId,
                deviceId,
                completedAtMs: support.testState.nowMs,
              });
              expect(store.get(record.environmentId)?.nodeDeviceId).toBe(deviceId);
              return deviceId;
            },
          };
        },
        ensureNodeWorkerBundle: async () => support.BOOTSTRAP_RECEIPT,
      },
    );
    await expect(
      service.createWithRequest({
        profileId: "development",
        idempotencyKey: "same-operation-enrollment",
      }),
    ).resolves.toMatchObject({ state: "ready", nodeDeviceId: deviceId });
    expect(() => expectDefined(guard, "closed enrollment guard")()).toThrow("operation is closed");
  });
});
