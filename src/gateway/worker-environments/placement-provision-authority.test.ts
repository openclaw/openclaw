import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { MANIFEST_REF, REQUEST } from "./placement-dispatch-test-fixtures.js";
import { createHarness } from "./placement-dispatch-test-harness.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { bindWorkerSourceAuthorization } from "./service-contract.js";
import * as support from "./service.test-support.js";
import { createWorkerTunnelManager } from "./tunnel.js";
import { fakeRunner, success, workspaceSetup } from "./tunnel.test-support.js";

describe("placement initiating authority at provider allocation", () => {
  support.setupWorkerEnvironmentServiceSuite();

  it.each([false, true])(
    "gates allocation after preparation (source revoked=%s)",
    async (revoke) => {
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const controller = new AbortController();
      let current = true;
      const marker = path.join(support.testState.root, "allocation-effect");
      const allocate = vi.fn(async () => {
        await fs.writeFile(marker, "allocated");
        throw new Error("allocation boundary observed");
      });
      const environmentService = support.createService(
        support.createProvider({
          prepareProvision: async (_profile, _operationId, options) => {
            expect(options?.os).toBe("os-a");
            expect(options?.machineClass).toBe("large");
            entered.resolve();
            await release.promise;
            return allocate;
          },
        }),
      );
      const placements = createWorkerSessionPlacementStore({ database: support.testState.stateDb });
      const harness = createHarness(support.testState.stateDb, placements, {
        environmentService,
        workspacePath: path.join(support.testState.root, "workspace"),
      });
      const dispatch = harness.service
        .dispatch(
          {
            ...REQUEST,
            profileId: "development",
            executionMode: "remote-exec",
            machineClass: "large",
            os: "os-a",
          },
          undefined,
          bindWorkerSourceAuthorization(() => {
            if (!current) {
              throw new Error("initiating claim closed");
            }
          }),
          controller.signal,
        )
        .catch((error: unknown) => error);
      try {
        await Promise.race([
          entered.promise,
          dispatch.then((error) => {
            throw error;
          }),
        ]);
        current = !revoke;
      } finally {
        release.resolve();
      }
      await dispatch;
      expect(controller.signal.aborted).toBe(false);
      expect(allocate).toHaveBeenCalledTimes(revoke ? 0 : 1);
      if (revoke) {
        await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        await expect(fs.readFile(marker, "utf8")).resolves.toBe("allocated");
      }
    },
  );

  it("refuses new legacy provisioning but preserves direct lifecycle and reuse", async () => {
    const provision = vi.fn(support.createLegacyProvider().provision);
    const service = support.createService(support.createLegacyProvider({ provision }));
    const context = { assertCurrent: bindWorkerSourceAuthorization(() => {}) };
    await expect(
      service.create(
        "development",
        "unsupported",
        undefined,
        "remote-exec",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        context,
      ),
    ).rejects.toThrow("live authority version 1");
    expect(provision).not.toHaveBeenCalled();
    const existing = await service.create("development", "existing", undefined, "remote-exec");
    expect(service.supportsProviderExecutionMode("fake", "remote-exec")).toBe(true);
    await expect(
      service.create(
        "development",
        "existing",
        undefined,
        "remote-exec",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        context,
      ),
    ).resolves.toMatchObject({ environmentId: existing.environmentId });
    expect(provision).toHaveBeenCalledOnce();
    await expect(service.destroy(existing.environmentId)).resolves.toMatchObject({
      state: "destroyed",
    });
  });

  it.each([false, true])(
    "keeps ordinary dispatch compatible with legacy providers (guard present=%s)",
    async (guarded) => {
      // The provider API can be legacy; its installed worker still speaks the current dialect.
      support.testState.prepareInstallation = vi.fn(async () => ({
        ...support.BUNDLE_ARTIFACT,
        protocolFeatures: [WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE],
      }));
      const placements = createWorkerSessionPlacementStore({ database: support.testState.stateDb });
      const workspacePath = path.join(support.testState.root, "workspace");
      await fs.mkdir(workspacePath);
      const fake = fakeRunner((argv, options) => {
        if (
          typeof options.input === "string" &&
          options.input.includes("unsafe worker workspace directory")
        ) {
          const placement = placements.get(REQUEST.sessionId);
          if (!placement?.environmentId) {
            throw new Error("Workspace setup requires its current placement owner");
          }
          return success(
            workspaceSetup(
              "/home/worker",
              placement.environmentId,
              placement.sessionId,
              placement.generation,
            ).stdout,
          );
        }
        if (argv[0] === "rsync") {
          return success();
        }
        if (argv[0] === "ssh" && argv.at(-1)?.includes("worker workspace symlink escapes")) {
          return success(MANIFEST_REF);
        }
        throw new Error(`Unexpected legacy dispatch command: ${argv[0]}`);
      });
      const tunnelManager = createWorkerTunnelManager({ runner: fake.runner });
      const provision = vi.fn(support.createLegacyProvider().provision);
      const environmentService = support.createService(
        support.createLegacyProvider({ provision }),
        {
          tunnelManager,
        },
      );
      const harness = createHarness(support.testState.stateDb, placements, {
        environmentService,
        workspacePath,
      });
      const authorize = vi.fn();
      await expect(
        harness.service.dispatch(
          { ...REQUEST, profileId: "development", executionMode: "remote-exec" },
          undefined,
          guarded ? authorize : undefined,
        ),
      ).resolves.toMatchObject({ state: "active" });
      expect(provision).toHaveBeenCalledOnce();
      expect(fake.runs.some(({ argv }) => argv[0] === "rsync")).toBe(true);
      expect(placements.get(REQUEST.sessionId)?.workspaceBaseManifestRef).toBe(MANIFEST_REF);
      if (guarded) {
        expect(authorize).toHaveBeenCalled();
      }
    },
  );

  it("closes retained provider assertions after the invocation settles", async () => {
    let retained: (() => void) | undefined;
    const service = support.createService(
      support.createProvider({
        provision: async (_profile, _id, options) => {
          retained = options?.assertCurrent;
          retained?.();
          return { leaseId: "lease-retained", ssh: support.SSH_ENDPOINT };
        },
      }),
    );
    await service.create("development", "retained");
    expect(retained).toBeTypeOf("function");
    expect(() => retained?.()).toThrow();
  });

  it("fences a provider's next effect after its own await with the signal live", async () => {
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const controller = new AbortController();
    let current = true;
    const effect = vi.fn();
    const service = support.createService(
      support.createProvider({
        provision: async (_profile, _id, options) => {
          entered.resolve();
          await release.promise;
          options?.assertCurrent?.();
          effect();
          return { leaseId: "lease-setup", ssh: support.SSH_ENDPOINT };
        },
      }),
    );
    const creation = service
      .create(
        "development",
        "setup",
        undefined,
        "remote-exec",
        undefined,
        controller.signal,
        undefined,
        undefined,
        undefined,
        {
          assertCurrent: bindWorkerSourceAuthorization(() => {
            if (!current) {
              throw new Error("source closed");
            }
          }),
        },
      )
      .catch((error: unknown) => error);
    await entered.promise;
    current = false;
    release.resolve();
    expect(await creation).toBeInstanceOf(Error);
    expect(controller.signal.aborted).toBe(false);
    expect(effect).not.toHaveBeenCalled();
  });
  it("preserves ordinary lifecycle provisioning recovery without delegated provenance", async () => {
    const provision = vi.fn(support.createLegacyProvider().provision);
    provision.mockRejectedValueOnce(new Error("allocation reply lost"));
    const destroy = vi.fn(async () => {});
    const first = support.createService(support.createProvider({ provision, destroy }));
    await expect(
      first.create(
        "development",
        "interrupted",
        undefined,
        "remote-exec",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { assertCurrent: () => {} },
      ),
    ).rejects.toThrow("allocation reply lost");
    const record = support.testState.store.list()[0];
    if (!record) {
      throw new Error("Expected durable allocation intent");
    }
    expect(record.state).toBe("provisioning");
    await support.reopenWorkerEnvironmentStore();
    const restarted = support.createService(support.createLegacyProvider({ provision, destroy }));
    restarted.start();
    await support.waitForFast(() =>
      expect(support.testState.store.get(record.environmentId)).toMatchObject({
        state: "ready",
      }),
    );
    expect(provision).toHaveBeenCalledTimes(2);
    expect(destroy).not.toHaveBeenCalled();
  });

  it("fences a retained provider effect after timeout without aborting its signal", async () => {
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const settled = createDeferredCore();
    const effect = vi.fn();
    const controller = new AbortController();
    const service = support.createService(
      support.createProvider({
        provision: async (_profile, _operationId, options) => {
          entered.resolve();
          try {
            await release.promise;
            options?.assertCurrent?.();
            effect();
            return { leaseId: "late-lease", ssh: support.SSH_ENDPOINT };
          } finally {
            settled.resolve();
          }
        },
      }),
      { providerCallTimeoutMs: 25 },
    );
    const creation = service
      .create(
        "development",
        "late-provider",
        undefined,
        "remote-exec",
        undefined,
        controller.signal,
        undefined,
        undefined,
        undefined,
        { assertCurrent: () => {} },
      )
      .catch((error: unknown) => error);
    await entered.promise;
    expect(await creation).toBeInstanceOf(Error);
    expect(controller.signal.aborted).toBe(false);
    release.resolve();
    await settled.promise;
    expect(effect).not.toHaveBeenCalled();
    expect(controller.signal.aborted).toBe(false);
  });
});
