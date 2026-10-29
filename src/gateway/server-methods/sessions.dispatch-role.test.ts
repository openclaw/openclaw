import { afterEach, expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.sqlite-entry.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  getActivePluginRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import {
  prepareUserProfileIdentity,
  readResidentUserProfileIdentity,
} from "../../state/user-profile-list.js";
import {
  ensureCanonicalUserProfileForEmail,
  setCanonicalUserProfileRole,
} from "../../state/user-profile-writes.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { handleGatewayRequest } from "../server-methods.js";
import { resolveGatewaySessionStoreTargetInWorker } from "../session-utils-store-worker.js";
import { bindDeviceWorkerAvailability } from "../worker-environments/device-provider.js";
import { createNodeWorkerBundleTestNode } from "../worker-environments/node-worker-bundle.test-support.js";
import { createDispatchEnvironmentFixtures } from "../worker-environments/placement-dispatch-test-fixtures.js";
import { createHarness } from "../worker-environments/placement-dispatch-test-harness.js";
import { createWorkerSessionPlacementStore } from "../worker-environments/placement-store.js";
import { createWorkerEnvironmentService } from "../worker-environments/service.js";
import { BUNDLE_ARTIFACT, createProvider } from "../worker-environments/service.test-support.js";
import { createWorkerEnvironmentStore } from "../worker-environments/store.js";
import { environmentsHandlers } from "./environments.js";
import {
  dispatchTestSessionId as sessionId,
  dispatchTestSessionKey as sessionKey,
  getDispatchTestMocks,
  getSessionDispatchHandler,
  makeDispatchTestContext,
} from "./sessions-dispatch.test-support.js";

const mocks = getDispatchTestMocks();
const originalPluginRegistry = getActivePluginRegistry();
afterEach(() => {
  if (originalPluginRegistry) {
    setActivePluginRegistry(
      originalPluginRegistry,
      "dispatch-provider-authority-restore",
      "default",
    );
  } else {
    resetPluginRuntimeStateForTest();
  }
});

// Keep the RPC, profile/session admission, dispatch, intent, and allocation owners real.
// Only installation artifacts, provider allocation, and remote worker I/O are synthetic.
it.each([
  "allowed",
  "legacy writer",
  "legacy admin",
  "read-only",
  "ungranted",
  "foreign creator",
  "installation",
  "provider preparation",
] as const)(
  "checks the writer's live worker-profile grant before allocation: %s",
  async (scenario) => {
    setActivePluginRegistry(createEmptyPluginRegistry(), "dispatch-provider-authority", "default");
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const person = await ensureCanonicalUserProfileForEmail("engineer@example.test");
      await setCanonicalUserProfileRole(person.id, "engineer");
      const identity = await prepareUserProfileIdentity(person.id);
      using _ = { [Symbol.dispose]: () => identity.release() };
      let cfg: OpenClawConfig = {
        session: { store: state.statePath("sessions.json") },
        cloudWorkers: {
          profiles: { test: { provider: "fake" }, other: { provider: "fake" } },
        },
        gateway: {
          roles: {
            default: "observer",
            definitions: {
              observer: { sessions: { others: "view" }, agents: [], scopes: ["operator.read"] },
              engineer: {
                sessions: { others: "write" },
                agents: ["main"],
                scopes:
                  scenario === "legacy admin"
                    ? ["operator.admin"]
                    : ["operator.read", "operator.write"],
                ...(!scenario.startsWith("legacy") ? { workerProfiles: ["test"] } : {}),
              },
            },
          },
        },
      };
      setRuntimeConfigSnapshot(cfg);
      const creator =
        scenario === "foreign creator"
          ? await ensureCanonicalUserProfileForEmail("other@example.test")
          : person;
      await replaceSessionEntry(
        { agentId: "main", sessionKey, storePath: cfg.session!.store! },
        {
          sessionId,
          updatedAt: 1,
          providerOverride: "anthropic",
          modelOverride: "claude-test",
          createdActor: { type: "human", source: "profile", id: creator.id },
          worktree: { id: "worktree-cloud-test", branch: "openclaw/cloud-test", repoRoot: "/repo" },
        },
      );
      mocks.resolveTarget.mockImplementation(resolveGatewaySessionStoreTargetInWorker);
      mocks.findLiveByOwner.mockResolvedValue({
        id: "worktree-cloud-test",
        ownerKind: "session",
        ownerId: sessionKey,
        path: state.workspaceDir,
      });
      const database = openOpenClawStateDatabase({ env: state.env });
      const store = await createWorkerEnvironmentStore({ database });
      const placements = createWorkerSessionPlacementStore({ database });
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const pause = async () => {
        entered.resolve();
        await release.promise;
      };
      const node = createNodeWorkerBundleTestNode({
        workerHost: { capturedExecPolicy: true, promptContext: 1 },
      });
      const allocate = vi.fn(async () => ({
        leaseId: "synthetic-lease",
        node: { deviceId: node.nodeId },
      }));
      const destroy = vi.fn(async () => {});
      const provider = createProvider({
        supportedExecutionModes: ["worker-turn"],
        prepareProvision: async () => {
          if (scenario === "provider preparation") {
            await pause();
          }
          return allocate;
        },
        provision: allocate,
        destroy,
      });
      const receipt = createDispatchEnvironmentFixtures().ready.bootstrapReceipt;
      const environmentService = createWorkerEnvironmentService({
        scheduler: createTestGatewayScheduler(),
        store,
        getConfig: () => cfg,
        resolveProvider: (id) => (id === provider.id ? provider : undefined),
        prepareInstallation: async () => {
          if (scenario === "installation") {
            await pause();
          }
          return { ...BUNDLE_ARTIFACT, ...receipt };
        },
        bootstrapWorker: async () => receipt,
        ensureNodeWorkerBundle: async () => receipt,
        nodeTunnelManager: {
          status: () => "connected",
          start: async ({ environmentId, ownerEpoch }) => ({
            ...harness.tunnelHandle(ownerEpoch),
            environmentId,
          }),
          stop: async () => {},
          stopAll: async () => {},
          beginClose: () => {},
          observeProcesses: async () => {
            throw new Error("Process observation is outside dispatch allocation proof");
          },
        },
      });
      // A pass-through observation verifies setup authority without replacing the owner.
      const createEnvironment = vi.spyOn(environmentService, "createWithRequest");
      const harness: Awaited<ReturnType<typeof createHarness>> = await createHarness(
        database,
        placements,
        {
          environmentService,
          workspacePath: state.workspaceDir,
        },
      );
      bindDeviceWorkerAvailability(environmentService, async () => ({ available: true, node }));
      bindDeviceWorkerAvailability(harness.environments, async () => ({ available: true, node }));
      const context = makeDispatchTestContext({
        getRuntimeConfig: () => cfg,
        workerEnvironmentService: environmentService,
        workerPlacementDispatchService: harness.service,
        workerSessionPlacementService: placements,
      });
      const request = async (
        scope: "operator.read" | "operator.write" | "operator.admin",
        method = "sessions.dispatch",
      ) => {
        const respond = vi.fn();
        await handleGatewayRequest({
          req: {
            type: "req",
            id: "dispatch-provider-authority",
            method,
            params:
              method === "environments.list"
                ? { projection: "profiles" }
                : { key: sessionKey, profileId: scenario === "ungranted" ? "other" : "test" },
          },
          respond,
          client: {
            connId: "writer-connection",
            authenticatedUserProfile: {
              profileId: person.id,
              displayName: null,
              hasAvatar: false,
              updatedAt: person.updatedAt,
            },
            preparedSessionProfile: readResidentUserProfileIdentity(person.id),
            connect: {
              role: "operator",
              scopes: [scope],
              client: { id: "test", version: "1", platform: "test", mode: "test" },
              minProtocol: 1,
              maxProtocol: 1,
            },
          },
          isWebchatConnect: () => false,
          context,
          extraHandlers: {
            ...environmentsHandlers,
            "sessions.dispatch": getSessionDispatchHandler(),
          },
        });
        return respond;
      };
      const dispatch = request(
        scenario === "legacy admin"
          ? "operator.admin"
          : scenario === "read-only"
            ? "operator.read"
            : "operator.write",
      );
      try {
        if (scenario === "installation" || scenario === "provider preparation") {
          await awaitGateBeforeSettlement(
            entered.promise,
            dispatch,
            "dispatch never reached preparation",
          );
          expect(allocate).not.toHaveBeenCalled();
          // Revoke only the role's profile grant; connection scopes, session ownership,
          // provider settings, and the synthetic node's transport authority stay valid.
          cfg = {
            ...cfg,
            gateway: {
              ...cfg.gateway,
              roles: {
                ...cfg.gateway!.roles!,
                definitions: {
                  ...cfg.gateway!.roles!.definitions,
                  engineer: { ...cfg.gateway!.roles!.definitions.engineer!, workerProfiles: [] },
                },
              },
            },
          };
          setRuntimeConfigSnapshot(cfg);
          release.resolve();
        }
        const respond = await dispatch;
        if (scenario === "allowed" || scenario === "legacy admin") {
          expect(respond).toHaveBeenCalledWith(
            true,
            expect.objectContaining({ ok: true }),
            undefined,
          );
          expect(allocate).toHaveBeenCalledOnce();
          expect(await placements.getAsync(sessionId)).toMatchObject({ state: "active" });
          if (scenario === "allowed") {
            for (const [scope, dispatchableProfileIds] of [
              ["operator.write", ["test"]],
              ["operator.read", []],
            ] as const) {
              expect(await request(scope, "environments.list")).toHaveBeenCalledWith(
                true,
                expect.objectContaining({ dispatchableProfileIds }),
                undefined,
              );
            }
          }
        } else {
          // Cleanup after an unauthorized allocation is too late: no provider effect is allowed.
          expect(allocate).not.toHaveBeenCalled();
          expect(destroy).not.toHaveBeenCalled();
          expect(respond).toHaveBeenCalledWith(
            false,
            undefined,
            expect.objectContaining({ code: ErrorCodes.FORBIDDEN }),
          );
        }
        if (
          scenario !== "ungranted" &&
          scenario !== "foreign creator" &&
          scenario !== "read-only" &&
          scenario !== "legacy writer"
        ) {
          expect(createEnvironment).toHaveBeenCalledWith(
            expect.objectContaining({ runSetupScript: scenario === "legacy admin" }),
          );
        } else {
          expect(createEnvironment).not.toHaveBeenCalled();
          expect(store.list()).toEqual([]);
        }
      } finally {
        release.resolve();
        await dispatch;
        await environmentService.stop();
      }
    });
  },
);
