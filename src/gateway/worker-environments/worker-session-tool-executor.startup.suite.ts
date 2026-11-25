import { describe, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { coordinateWorkerPlacementDispatch } from "./placement-dispatch-coordinator.js";
import { createCoordinatorTestService } from "./placement-dispatch-coordinator.test-support.js";
import { writePlacementEnvironmentFixture } from "./placement-test-fixtures.js";
import * as environmentServiceModule from "./service.js";
import {
  CHILD,
  installWorkerSessionToolTestFixture,
  resolveGatewayContext,
  SOURCE,
  workerSessionToolTestMocks,
} from "./worker-session-tool-executor.test-support.js";

export function registerWorkerSpawnStartupTests(
  mocks: ReturnType<typeof workerSessionToolTestMocks>,
) {
  const { gatewayCreate, gatewayRequest } = mocks;
  describe("worker spawn startup composition", () => {
    const getFixture = installWorkerSessionToolTestFixture(mocks);

    it.for([false, true])(
      "joins child setup started by creation while retaining parent authority (closed=%s)",
      async (closed, { signal }) => {
        const { root, database, placements, identity, setEntry, closeSourceRun } = getFixture();
        setEntry(SOURCE.sessionKey, SOURCE.sessionId);
        const { createDesktopSessionRegistry } = await import("../desktop/session-registry.js");
        const { createGatewayWorkerEnvironmentRuntime, loadGatewayWorkerEnvironmentStartupState } =
          await import("../server-worker-environment-startup.js");
        const factory = vi.spyOn(environmentServiceModule, "createWorkerEnvironmentService");
        try {
          await withEnvAsync({ OPENCLAW_STATE_DIR: root }, async () => {
            const startup = await loadGatewayWorkerEnvironmentStartupState();
            const registry = createEmptyPluginRegistry();
            const runtime = await createGatewayWorkerEnvironmentRuntime({
              scheduler: createTestGatewayScheduler(),
              getPluginRegistry: () => registry,
              getPortalRuntime: () => undefined,
              resolveGatewayContext,
              desktopSessionRegistry: createDesktopSessionRegistry(),
              startup: { ...startup, placementStore: placements },
              log: { child: () => ({ info: () => {}, warn: () => {} }) },
            });
            const service = runtime.workerEnvironmentService;
            const createTools = factory.mock.calls.at(-1)?.[0].createGatewayTools;
            if (!service || !createTools || !runtime.bindWorkerSessionDispatch) {
              throw new Error("worker session-tool runtime was not composed");
            }
            const base = service.get(SOURCE.environmentId);
            if (!base) {
              throw new Error("source environment fixture was not created");
            }
            const getEnvironment = vi.spyOn(service, "get").mockImplementation((environmentId) => {
              const owner = environmentId === SOURCE.environmentId ? SOURCE : CHILD;
              return {
                ...base,
                environmentId,
                providerId: "fake",
                profileId: "cloud-profile",
                profileSnapshot: { install: "bundle", settings: { region: "source" } },
                state: "attached",
                leaseId: `lease-${environmentId}`,
                ownerEpoch: owner.ownerEpoch,
                attachedSessionIds: [owner.sessionId],
              };
            });
            const provisioning = createDeferred();
            const finishProvisioning = createDeferred();
            const waiting = createDeferred();
            const provisionChild = vi.fn<
              ReturnType<typeof createCoordinatorTestService>["dispatch"]
            >(async (request, onTransition, authorize) => {
              let placement = await placements.startDispatch(request);
              onTransition?.(placement);
              placement = await placements.transition({
                sessionId: request.sessionId,
                from: "requested",
                to: "provisioning",
                expectedGeneration: placement.generation,
                patch: { environmentId: CHILD.environmentId },
              });
              onTransition?.(placement);
              provisioning.resolve();
              await finishProvisioning.promise;
              authorize?.();
              writePlacementEnvironmentFixture(database, {
                environmentId: CHILD.environmentId,
                state: "attached",
                ownerEpoch: CHILD.ownerEpoch,
                attachedSessionIds: [CHILD.sessionId],
                profileId: "cloud-profile",
                providerId: "fake",
                profileSnapshot: { install: "bundle", settings: { region: "source" } },
              });
              for (const transition of [
                { to: "syncing", patch: { workerBundleHash: "a".repeat(64) } },
                {
                  to: "starting",
                  patch: {
                    workspaceBaseManifestRef: "child-manifest",
                    remoteWorkspaceDir: "/worker/child",
                  },
                },
                { to: "active", patch: { activeOwnerEpoch: CHILD.ownerEpoch } },
              ] as const) {
                placement = await placements.transition({
                  sessionId: request.sessionId,
                  from: placement.state,
                  expectedGeneration: placement.generation,
                  ...transition,
                });
                onTransition?.(placement);
              }
              if (placement.state !== "active") {
                throw new Error("child fixture did not activate");
              }
              return placement;
            });
            const coordinator = coordinateWorkerPlacementDispatch(
              createCoordinatorTestService({ dispatch: provisionChild }),
              (_request, run) => run(),
            );
            runtime.bindWorkerSessionDispatch(coordinator.dispatch, (...args) => {
              waiting.resolve();
              return coordinator.waitForInitialPlacement(...args);
            });
            const create = gatewayCreate.getMockImplementation();
            if (!create) {
              throw new Error("missing session creation fixture");
            }
            let setup: Promise<unknown> | undefined;
            let pending: Promise<unknown> | undefined;
            gatewayCreate.mockImplementation(
              async (request: {
                method: string;
                params: Record<string, unknown>;
                options?: { sessionMutationCommitGuard?: () => void };
              }) => {
                const created = await create(request);
                // Required session creation acknowledges setup before the child is ready.
                setup = coordinator.dispatch(
                  {
                    sessionId: CHILD.sessionId,
                    sessionKey: String(request.params.key),
                    agentId: CHILD.agentId,
                    profileId: "cloud-profile",
                    executionMode: "worker-turn",
                    requiredProfile: "cloud-profile",
                    runSetupScript: false,
                    devicePlacement: { requiredNodeCommands: [], consumesWorkerSlot: true },
                  },
                  undefined,
                  request.options?.sessionMutationCommitGuard,
                );
                void setup.catch(() => undefined);
                await withinTest(
                  awaitGateBeforeSettlement(
                    provisioning.promise,
                    setup,
                    "session creation skipped pending child setup",
                  ),
                  signal,
                );
                return created;
              },
            );
            try {
              const tools = await createTools({ identity });
              const spawnTool = tools.find((tool) => tool.name === "sessions_spawn");
              if (!spawnTool) {
                throw new Error("Worker spawn tool was not composed");
              }
              pending = spawnTool.execute("startup-parent-closure", {
                task: "start the child",
              });
              await withinTest(
                awaitGateBeforeSettlement(
                  waiting.promise,
                  pending,
                  "worker spawn did not join the existing setup owner",
                ),
                signal,
              );
              expect(placements.get(CHILD.sessionId)?.state).toBe("provisioning");
              expect(gatewayRequest).not.toHaveBeenCalled();
              if (closed) {
                closeSourceRun();
              }
              finishProvisioning.resolve();
              if (closed) {
                await expect(pending).rejects.toThrow();
              } else {
                expect(await pending).toMatchObject({
                  details: {
                    status: "accepted",
                    runStarted: true,
                    runId: "spawned-child-run",
                  },
                });
              }
              expect(placements.get(CHILD.sessionId)?.state).toBe(
                closed ? "provisioning" : "active",
              );
              expect(gatewayCreate).toHaveBeenCalledOnce();
              expect(provisionChild).toHaveBeenCalledOnce();
              expect(gatewayRequest).toHaveBeenCalledTimes(closed ? 0 : 1);
              if (!closed) {
                expect(gatewayRequest).toHaveBeenCalledWith(
                  expect.objectContaining({
                    method: "agent",
                    params: expect.objectContaining({
                      sessionId: CHILD.sessionId,
                      message: "start the child",
                    }),
                  }),
                );
              }
            } finally {
              finishProvisioning.resolve();
              await Promise.allSettled([setup, pending]);
              getEnvironment.mockRestore();
              await service.stop();
            }
          });
        } finally {
          factory.mockRestore();
        }
      },
    );
  });
}
