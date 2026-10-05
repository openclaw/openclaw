import path from "node:path";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import { invokeNodeWorkerSupervisorCommand } from "../../node-host/node-worker-supervisor-commands.js";
import { NodeWorkerWorkspaceRuntime } from "../../node-host/node-worker-workspace.js";
import { getSessionRepositoryWorkspaceStore } from "../../state/session-repository-workspaces.js";
import { createNodeWorkerPreparedWorkspaceTransport } from "./node-worker-prepared-workspace-transport.js";
import {
  preparedHarness,
  presencePreparedReserves,
} from "./placement-dispatch-prepared.harness.js";
import { PreparedEnvironmentBindingIndeterminateError } from "./placement-dispatch-store.js";
import { MANIFEST_REF, REQUEST } from "./placement-dispatch-test-fixtures.js";
import { deriveEnvironmentIntent } from "./service-contract.js";
import * as support from "./service.test-support.js";

const selected = vi.hoisted(() => ({ prepare: vi.fn() }));
vi.mock("./worker-github-binding.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./worker-github-binding.js")>()),
  prepareWorkerRepositoryGitHubIdentity: selected.prepare,
  prepareWorkerGitHubBindingGrant: vi.fn(),
}));
vi.mock("../../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/config.js")>()),
  getRuntimeConfig: () => ({
    gateway: { nodes: { commands: { allow: ["codex.exec-server.stdio.v1"] } } },
  }),
}));

describe("Factory warm-first worker dispatch", () => {
  support.setupWorkerEnvironmentServiceSuite();
  beforeEach(() => {
    selected.prepare.mockClear();
  });
  it("claims an image-only Factory reserve and uses the selected checkout credential", async () => {
    vi.stubEnv("FACTORY_AUTH_MODE", "github");
    vi.stubEnv("OPENCLAW_STATE_DIR", support.testState.root);
    onTestFinished(() => {
      vi.unstubAllEnvs();
      selected.prepare.mockReset();
    });
    selected.prepare.mockResolvedValue({
      token: "synthetic-selected-token",
      expiresAtMs: Date.now() + 60_000,
      assertSelected: () => {},
      revalidate: async () => {},
    });
    const repository = await getSessionRepositoryWorkspaceStore().create({
      agentId: REQUEST.agentId,
      sessionKey: REQUEST.sessionKey,
      url: "https://github.com/example/project.git",
      requestedRef: "main",
      runSetupScript: false,
      assertCurrent: () => {},
    });
    const { harness, request, ready } = await preparedHarness({ repository, imageReserve: true });

    const active = await harness.service.dispatch(request);

    expect(active.environmentId).toBe(ready.environmentId);
    expect(harness.environments.createWithRequest).not.toHaveBeenCalled();
    expect(harness.environments.bindPreparedWorkspace).not.toHaveBeenCalled();
    expect(selected.prepare).toHaveBeenCalledOnce();
  });

  it("claims an image reserve when hosted Codex prepares its repository asynchronously", async () => {
    vi.stubEnv("FACTORY_AUTH_MODE", "github");
    vi.stubEnv("OPENCLAW_STATE_DIR", support.testState.root);
    onTestFinished(() => vi.unstubAllEnvs());
    const repository = await getSessionRepositoryWorkspaceStore().create({
      agentId: REQUEST.agentId,
      sessionKey: REQUEST.sessionKey,
      url: "https://github.com/example/project.git",
      requestedRef: "main",
      runSetupScript: false,
      assertCurrent: () => {},
    });
    const { harness, request, ready } = await preparedHarness({
      repository,
      imageReserve: true,
      executionMode: "remote-exec",
    });
    const active = await harness.service.dispatch({
      ...request,
      operatorAuthority: createAdmittedRunOperatorAuthority({
        profileId: REQUEST.profileId,
        scopes: ["operator.write"],
        assertCurrent: () => {},
        retain: () => () => {},
      }),
      trackRepositoryPreparation: () => {},
    });

    expect(active.environmentId).toBe(ready.environmentId);
    expect(harness.environments.createWithRequest).not.toHaveBeenCalled();
    expect(harness.environments.prepareProjectIntent).toHaveBeenCalledWith(
      REQUEST.profileId,
      expect.objectContaining({ imageReserve: true }),
    );
  });

  it("cold provisions without prepared custody when async Codex has no image reserve", async () => {
    vi.stubEnv("FACTORY_AUTH_MODE", "github");
    vi.stubEnv("OPENCLAW_STATE_DIR", support.testState.root);
    onTestFinished(() => vi.unstubAllEnvs());
    const repository = await getSessionRepositoryWorkspaceStore().create({
      agentId: REQUEST.agentId,
      sessionKey: REQUEST.sessionKey,
      url: "https://github.com/example/project.git",
      requestedRef: "main",
      runSetupScript: false,
      assertCurrent: () => {},
    });
    const { harness, request } = await preparedHarness({
      repository,
      imageReserve: true,
      reserve: false,
      executionMode: "remote-exec",
    });
    const active = await harness.service.dispatch({
      ...request,
      operatorAuthority: createAdmittedRunOperatorAuthority({
        profileId: REQUEST.profileId,
        scopes: ["operator.write"],
        assertCurrent: () => {},
        retain: () => () => {},
      }),
      trackRepositoryPreparation: () => {},
    });

    expect(active.state).toBe("active");
    expect(harness.environments.createWithRequest).toHaveBeenCalledOnce();
    expect(harness.environments.prepareProjectIntent).toHaveBeenCalledTimes(2);
    expect(harness.environments.prepareProjectIntent).toHaveBeenNthCalledWith(
      1,
      REQUEST.profileId,
      expect.objectContaining({ imageReserve: true }),
    );
    expect(harness.environments.prepareProjectIntent).toHaveBeenNthCalledWith(
      2,
      REQUEST.profileId,
      expect.not.objectContaining({ imageReserve: true }),
    );
  });

  it.each([false, true])(
    "claims a presence-prepared reserve with browser defaults (image=%s)",
    async (imageReserve) => {
      vi.stubEnv("OPENCLAW_STATE_DIR", support.testState.root);
      onTestFinished(() => {
        vi.unstubAllEnvs();
      });
      if (imageReserve) {
        vi.stubEnv("FACTORY_AUTH_MODE", "github");
        selected.prepare.mockResolvedValue({
          token: "synthetic-selected-token",
          expiresAtMs: Date.now() + 60_000,
          assertSelected: () => {},
          revalidate: async () => {},
        });
        onTestFinished(() => {
          selected.prepare.mockReset();
        });
      }
      const repositoryStore = getSessionRepositoryWorkspaceStore();
      const repository = await repositoryStore.create({
        agentId: REQUEST.agentId,
        sessionKey: REQUEST.sessionKey,
        url: "https://github.com/example/project.git",
        requestedRef: "main",
        runSetupScript: false,
        assertCurrent: () => {},
      });
      const {
        intentOwner,
        intent,
        pool,
        ready,
        artifacts,
        repositoryProject,
        admittedRepository,
        admission,
      } = await presencePreparedReserves(repository);
      expect(ready).toHaveLength(3);
      expect(ready.every((record) => record.profileSnapshot.executionMode === "remote-exec")).toBe(
        true,
      );

      if (imageReserve) {
        const source = { agentId: REQUEST.agentId, url: repository.url, ref: "main" };
        for (const override of [
          { machineClass: "large" },
          { os: "darwin" },
          { executionMode: "worker-turn" as const },
        ]) {
          const incompatible = await intentOwner.prepareIntent(REQUEST.profileId, {
            repository: source,
            executionMode: "remote-exec",
            ...override,
          });
          expect(pool.candidates(incompatible, REQUEST.profileId)).toEqual([]);
        }
        artifacts.nodeBootstrapSha256 = "3".repeat(64);
        const changedRuntime = await intentOwner.prepareIntent(REQUEST.profileId, {
          repository: source,
          executionMode: "remote-exec",
        });
        expect(pool.candidates(changedRuntime, REQUEST.profileId)).toEqual([]);
        artifacts.nodeBootstrapSha256 = "f".repeat(64);
        admission.mockResolvedValue({ ...admittedRepository, setupRecipe: "a".repeat(40) });
        const unauthorizedSetup = await intentOwner.prepareIntent(REQUEST.profileId, {
          repository: source,
          executionMode: "remote-exec",
        });
        expect(unauthorizedSetup.preparationKey).toBeUndefined();
        expect(pool.candidates(unauthorizedSetup, REQUEST.profileId)).toEqual([]);
        admission.mockResolvedValue(admittedRepository);
      }

      const boundWorkspace = {
        workspaceDir: "/worker/prepared/project",
        sourceManifestRef: MANIFEST_REF,
        preparedManifestRef: MANIFEST_REF,
      };
      const selectedHead = "f".repeat(40);
      const prepared = await preparedHarness({
        executionMode: "remote-exec",
        repository,
        boundWorkspace,
        seeded: {
          intent,
          ready,
          candidates: (candidate) => pool.candidates(candidate, REQUEST.profileId),
        },
      });
      vi.mocked(prepared.harness.environments.prepareProjectIntent).mockImplementation(
        intentOwner.prepareIntent,
      );
      vi.mocked(prepared.harness.environments.assertPreparedIntentCurrent).mockImplementation(
        intentOwner.assertPreparedIntentCurrent,
      );
      const wrongMode = {
        sessionId: "wrong-mode",
        sessionKey: "agent:main:dashboard:wrong-mode",
        agentId: REQUEST.agentId,
        executionMode: "worker-turn" as const,
      };
      const wrongPlacement = await prepared.placements.startDispatch(wrongMode);
      expect(
        await prepared.placements.bindPreparedEnvironment({
          ...wrongMode,
          expectedGeneration: wrongPlacement.generation,
          environmentId: ready[0]!.environmentId,
          ownerEpoch: ready[0]!.ownerEpoch,
          providerId: intent.providerId,
          profileId: REQUEST.profileId,
          preparationKey: intent.preparationKey!,
          nodeDeviceId: ready[0]!.nodeDeviceId!,
          leaseId: ready[0]!.leaseId!,
          bundleHash: ready[0]!.bootstrapReceipt!.bundleHash,
          assertCurrent: () => {},
        }),
      ).toBeUndefined();
      const startTunnel = vi.mocked(prepared.harness.environments.startTunnel);
      const ordinaryTunnel = startTunnel.getMockImplementation()!;
      startTunnel.mockImplementation(async (params) => {
        const tunnel = await ordinaryTunnel(params);
        return {
          ...tunnel,
          syncWorkspace: vi.fn(async ({ source }) => {
            expect(source).toMatchObject({
              kind: "repository",
              url: repository.url,
              ...(imageReserve
                ? { gitToken: "synthetic-selected-token" }
                : {
                    preparedRefMode: "fetch",
                    prepared: { ...boundWorkspace, baseCommit: repositoryProject.baseCommit },
                  }),
            });
            expect(source.baseCommit).toBeUndefined();
            return {
              mode: "repository" as const,
              remoteWorkspaceDir: boundWorkspace.workspaceDir,
              baseCommit: selectedHead,
              baseManifestRef: MANIFEST_REF,
              manifestRef: MANIFEST_REF,
            };
          }),
          reconcileWorkspace: vi.fn(async () => ({
            manifestRef: MANIFEST_REF,
            changed: false,
            verifyStable: async () => {},
            verifyLocalStable: async () => {},
            publishStagedResult: async () => {},
            discardPreparedStagedResult: async () => {},
          })),
        };
      });

      const active = await prepared.harness.service.dispatch({
        ...prepared.request,
        os: "linux",
        machineClass: "small",
        runSetupScript: false,
      });
      const selectedIntent = await vi.mocked(prepared.harness.environments.prepareProjectIntent)
        .mock.results[0]!.value;
      expect(selectedIntent.profileSnapshot.executionMode).toBe("remote-exec");
      expect(selectedIntent.preparationKey).toBe(intent.preparationKey);
      const reserveKey = ready[0]!.preparation!.key;
      expect(ready.every((record) => record.preparation?.key === reserveKey)).toBe(true);
      if (imageReserve) {
        expect(reserveKey).not.toBe(selectedIntent.preparationKey);
      } else {
        expect(reserveKey).toBe(selectedIntent.preparationKey);
      }

      expect(active).toMatchObject({
        state: "active",
        executionMode: "remote-exec",
        environmentId: ready[0]!.environmentId,
      });
      expect((await repositoryStore.get(repository.workspaceId))?.baseCommit).toBe(selectedHead);
      expect(prepared.harness.environments.createWithRequest).not.toHaveBeenCalled();
      if (imageReserve) {
        expect(prepared.harness.environments.bindPreparedWorkspace).not.toHaveBeenCalled();
        expect(selected.prepare).toHaveBeenCalledOnce();
      } else {
        expect(prepared.harness.environments.bindPreparedWorkspace).toHaveBeenCalledOnce();
      }
      expect(
        support.testState.store
          .list()
          .filter((record) => record.preparation?.consumedAtMs !== null),
      ).toHaveLength(1);
      expect(
        support.testState.store
          .list()
          .filter((record) => record.preparation?.consumedAtMs === null),
      ).toHaveLength(2);

      await pool.schedule();
      expect(
        support.testState.store
          .list()
          .filter(
            (record) =>
              record.preparation?.consumedAtMs === null && record.destroyRequestedAtMs === null,
          ),
      ).toHaveLength(3);
    },
  );
  async function factoryColdFixture(
    executionMode: "worker-turn" | "remote-exec" = "worker-turn",
    repositoryReserve = false,
  ) {
    vi.stubEnv("FACTORY_AUTH_MODE", "github");
    vi.stubEnv("OPENCLAW_STATE_DIR", support.testState.root);
    onTestFinished(() => {
      vi.unstubAllEnvs();
      selected.prepare.mockReset();
    });
    selected.prepare.mockResolvedValue({
      token: "synthetic-selected-token",
      expiresAtMs: Date.now() + 60_000,
      assertSelected: () => {},
      revalidate: async () => {},
    });
    const repository = await getSessionRepositoryWorkspaceStore().create({
      agentId: REQUEST.agentId,
      sessionKey: REQUEST.sessionKey,
      url: "https://github.com/example/project.git",
      requestedRef: "main",
      runSetupScript: false,
      assertCurrent: () => {},
    });
    if (repositoryReserve) {
      vi.stubEnv("FACTORY_AUTH_MODE", "");
    }
    const presence = await presencePreparedReserves(repository);
    vi.stubEnv("FACTORY_AUTH_MODE", "github");
    const prepared = await preparedHarness({
      repository,
      imageReserve: true,
      reserve: false,
      executionMode,
    });
    vi.mocked(prepared.harness.environments.prepareProjectIntent).mockImplementation(
      presence.intentOwner.prepareIntent,
    );
    vi.mocked(prepared.harness.environments.assertPreparedIntentCurrent).mockImplementation(
      presence.intentOwner.assertPreparedIntentCurrent,
    );
    vi.mocked(prepared.harness.environments.revalidatePreparedIntentRepository).mockImplementation(
      presence.intentOwner.revalidatePreparedIntentRepository,
    );
    vi.mocked(prepared.harness.environments.getPreparedCandidates).mockImplementation(
      (intent, profileId) =>
        presence.pool
          .candidates(intent, profileId)
          .map((record) => prepared.workerService.get(record.environmentId))
          .filter((record) => record !== undefined),
    );
    return { ...prepared, presence, repository };
  }

  it.each([
    "settled",
    "cleanup-unknown",
    "caller-revoked",
    "node-changed",
    "registration-changed",
  ] as const)(
    "settles a real first-bind missing registration before cold allocation (%s)",
    async (scenario) => {
      const f = await factoryColdFixture("remote-exec", true);
      const native = new NodeWorkerWorkspaceRuntime({
        root: path.join(support.testState.root, "bind-node"),
        env: {
          ...process.env,
          HOME: support.testState.root,
          OPENCLAW_STATE_DIR: path.join(support.testState.root, "bind-state"),
        },
        ephemeral: true,
      });
      let nodeCurrent = true;
      const nodeTransport = {
        ...f.transport,
        isCurrent: () => nodeCurrent,
        invoke: async (input: Parameters<typeof f.transport.invoke>[0]) => {
          const response = await invokeNodeWorkerSupervisorCommand({
            command: input.command,
            paramsJSON: JSON.stringify(input.params),
            workspace: native,
          });
          if (!response.handled || response.ok) {
            throw new Error("Expected native missing-registration refusal");
          }
          expect(response).toMatchObject({
            code: "INVALID_REQUEST",
            message: "INVALID_REQUEST: prepared workspace registration is missing",
          });
          if (scenario === "node-changed") {
            nodeCurrent = false;
          }
          return {
            ok: false as const,
            error: {
              code: response.code,
              message:
                scenario === "registration-changed"
                  ? "INVALID_REQUEST: prepared workspace registration does not match this environment"
                  : response.message,
            },
          };
        },
      };
      const binding = createNodeWorkerPreparedWorkspaceTransport({
        store: f.store,
        placementStore: f.placements,
        getNodeTransport: () => nodeTransport,
        gatewayNamespace: "dispatch-fixture",
      });
      vi.mocked(f.harness.environments.bindPreparedWorkspace).mockImplementation(
        binding.bindPreparedWorkspace,
      );
      let callerCurrent = true;
      const destroy = vi.mocked(f.harness.environments.destroy);
      const canonicalDestroy = destroy.getMockImplementation()!;
      destroy.mockImplementation(async (id) => {
        if (scenario === "cleanup-unknown") {
          throw new Error("warm cleanup unconfirmed");
        }
        const destroyed = await canonicalDestroy(id);
        if (scenario === "caller-revoked") {
          callerCurrent = false;
        }
        return destroyed;
      });
      vi.mocked(f.harness.environments.createWithRequest).mockImplementation(async (request) => {
        expect(f.store.get(f.presence.ready[0]!.environmentId)?.state).toBe("destroyed");
        const environmentId = deriveEnvironmentIntent(request.idempotencyKey!).environmentId;
        await f.store.createIntent({
          environmentId,
          profileId: REQUEST.profileId,
          providerId: "fake",
          profileSnapshot: request.admittedIntent!.profileSnapshot,
          provisionOperationId: `cold:${environmentId}`,
        });
        await f.store.transition({ environmentId, from: "requested", to: "provisioning" });
        await f.store.transition({
          environmentId,
          from: "provisioning",
          to: "ready",
          patch: {
            leaseId: `lease:${environmentId}`,
            nodeDeviceId: "prepared-node",
            sharedHost: false,
            ...support.readyPatch(environmentId, f.ready.bootstrapReceipt!),
          },
        });
        return f.workerService.get(environmentId)!;
      });
      const operation = f.harness.service.dispatch(f.request, undefined, () => {
        if (!callerCurrent) {
          throw new Error("caller revoked");
        }
      });
      if (scenario === "settled") {
        await expect(operation).resolves.toMatchObject({ state: "active" });
        expect(f.harness.environments.createWithRequest).toHaveBeenCalledOnce();
        expect(f.harness.environments.bindPreparedWorkspace).toHaveBeenCalledOnce();
        expect(selected.prepare).toHaveBeenCalledOnce();
      } else {
        await expect(operation).rejects.toThrow();
        expect(f.harness.environments.createWithRequest).not.toHaveBeenCalled();
        expect(selected.prepare).not.toHaveBeenCalled();
      }
      expect(
        f.store.get(f.presence.ready[0]!.environmentId)?.preparation?.consumedAtMs,
      ).not.toBeNull();
      if (scenario === "cleanup-unknown") {
        expect(f.store.get(f.presence.ready[0]!.environmentId)?.state).not.toBe("destroyed");
      }
    },
  );

  it.each([
    "no-match",
    "settled-claim-miss",
    "host-preparation-failure",
    "checkout-failure",
  ] as const)(
    "uses canonical cold host allocation after %s without Gateway repository preparation",
    async (scenario) => {
      const f = await factoryColdFixture(
        scenario === "settled-claim-miss" ? "remote-exec" : "worker-turn",
      );
      if (scenario === "settled-claim-miss") {
        const bind = f.placements.bindPreparedEnvironment.bind(f.placements);
        vi.spyOn(f.placements, "bindPreparedEnvironment").mockImplementation((input) =>
          bind({ ...input, nodeDeviceId: "stale-node-identity" }),
        );
      }
      if (scenario === "host-preparation-failure") {
        vi.mocked(f.harness.environments.prepareProjectIntent).mockImplementation(
          async (...args) => {
            if (!args[1]?.repository) {
              throw new Error("cold host preparation rejected");
            }
            return f.presence.intentOwner.prepareIntent(...args);
          },
        );
      }
      if (scenario === "checkout-failure") {
        selected.prepare.mockRejectedValue(
          new Error("The selected GitHub credential is unavailable"),
        );
      }
      const operation = f.harness.service.dispatch(f.request);
      if (scenario === "host-preparation-failure") {
        await expect(operation).rejects.toThrow("cold host preparation rejected");
        expect(f.harness.environments.createWithRequest).not.toHaveBeenCalled();
      } else {
        if (scenario === "checkout-failure") {
          await expect(operation).rejects.toThrow("selected GitHub credential is unavailable");
          expect(
            (await getSessionRepositoryWorkspaceStore().get(f.repository.workspaceId))?.baseCommit,
          ).toBeNull();
        } else {
          const active = await operation;
          expect(active).toMatchObject({ state: "active", environmentId: f.ready.environmentId });
          expect(selected.prepare).toHaveBeenCalledOnce();
        }
        expect(f.harness.environments.createWithRequest).toHaveBeenCalledOnce();
        const request = vi.mocked(f.harness.environments.createWithRequest).mock.calls[0]![0];
        expect(request.admittedIntent?.profileSnapshot.project).toBeUndefined();
        expect(request.admittedIntent?.profileSnapshot.executionMode).toBe(f.request.executionMode);
        expect(f.harness.environments.bindPreparedWorkspace).not.toHaveBeenCalled();
      }
      expect(
        f.presence.ready.every(
          (record) => f.store.get(record.environmentId)?.preparation?.consumedAtMs === null,
        ),
      ).toBe(true);
    },
  );

  it.each(["cleanup-unknown", "binding-indeterminate"] as const)(
    "does not cold allocate after a committed warm claim has an unconfirmed reply (%s)",
    async (outcome) => {
      const f = await factoryColdFixture("remote-exec");
      const bind = f.placements.bindPreparedEnvironment.bind(f.placements);
      vi.spyOn(f.placements, "bindPreparedEnvironment").mockImplementation(async (input) => {
        const committed = await bind(input);
        if (!committed) {
          throw new Error("Fixture did not commit the warm claim");
        }
        if (outcome === "binding-indeterminate") {
          throw new PreparedEnvironmentBindingIndeterminateError(
            new Error("warm claim reply unconfirmed"),
          );
        }
        throw new Error("warm claim reply unconfirmed");
      });
      vi.mocked(f.harness.environments.destroy).mockRejectedValue(
        new Error("warm cleanup remains unconfirmed"),
      );
      await expect(f.harness.service.dispatch(f.request)).rejects.toThrow(
        outcome === "binding-indeterminate"
          ? "Prepared worker binding is indeterminate"
          : "warm claim reply unconfirmed",
      );
      if (outcome === "binding-indeterminate") {
        expect(f.harness.environments.destroy).not.toHaveBeenCalled();
      }
      expect(f.harness.environments.createWithRequest).not.toHaveBeenCalled();
      const retained = f.store.get(f.presence.ready[0]!.environmentId)!;
      expect(retained.preparation?.consumedAtMs).not.toBeNull();
      expect(retained.leaseId).toBe(f.presence.ready[0]!.leaseId);
      expect(retained.state).not.toBe("destroyed");
    },
  );
});
