import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { createNodeRepositoryReadiness } from "./node-worker-repository-readiness.js";
import * as diagnostics from "./placement-diagnostics.js";
import { createPlacementFailureActions } from "./placement-dispatch-failure.js";
import { createWorkerPlacementDispatchStartup } from "./placement-dispatch-startup.js";
import { REQUEST } from "./placement-dispatch-test-fixtures.js";
import { createHarness } from "./placement-dispatch-test-harness.js";
import { canPrepareRepositoryConcurrently } from "./placement-repository-preparation.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import type { WorkerSessionWorkspace } from "./session-workspace.js";
import type { WorkerTunnelHandle } from "./tunnel-contract.js";

it("selects background repository preparation for the hosted Codex exec-server command", () => {
  vi.stubEnv("FACTORY_AUTH_MODE", "github");
  const workspace: WorkerSessionWorkspace = {
    kind: "repository",
    repository: {
      workspaceId: "fixture-workspace",
      agentId: REQUEST.agentId,
      sessionKey: REQUEST.sessionKey,
      url: "https://microsoft.ghe.com/bic/lobster.git",
      requestedRef: null,
      branch: "main",
      baseCommit: null,
      baseManifestHash: null,
      checkpointRef: null,
      manifestHash: null,
      revision: 0,
      runSetupScript: false,
      createdAtMs: 1,
      updatedAtMs: 1,
    },
  };
  const request = {
    ...REQUEST,
    executionMode: "remote-exec" as const,
    devicePlacement: {
      consumesWorkerSlot: true,
      requiredNodeCommands: ["codex.exec-server.stdio.v1"],
    },
    operatorAuthority: createAdmittedRunOperatorAuthority({
      profileId: "fixture",
      scopes: ["operator.write"],
      assertCurrent: () => {},
      retain: () => () => {},
    }),
    trackRepositoryPreparation: () => {},
  };
  expect(canPrepareRepositoryConcurrently(request, workspace)).toBe(true);
  expect(
    canPrepareRepositoryConcurrently({ ...request, executionMode: "worker-turn" }, workspace),
  ).toBe(false);
});
it.each(["failed", "revoked", "retired"] as const)(
  "activates hosted Codex before delayed repository admission and settles %s preparation",
  async (outcome) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "placement-async-repository-"));
    const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    const placementStore = createWorkerSessionPlacementStore({ database });
    const harness = createHarness(database, placementStore, {
      workspacePath: path.join(root, "workspace"),
    });
    try {
      const requested = await placementStore.startDispatch({
        ...REQUEST,
        executionMode: "remote-exec",
      });
      const provisioning = await placementStore.transition({
        sessionId: REQUEST.sessionId,
        from: "requested",
        to: "provisioning",
        expectedGeneration: requested.generation,
        patch: { environmentId: harness.ready.environmentId },
      });
      const delayed = createDeferred();
      const entered = createDeferred();
      const background: Promise<void>[] = [];
      const release = vi.fn();
      const stage = vi.spyOn(diagnostics, "recordWorkerPlacementStage");
      let current = true;
      const retired = new AbortController();
      const settleRepository = placementStore.settleRepository.bind(placementStore);
      vi.spyOn(placementStore, "settleRepository").mockImplementation(async (...args) => {
        const receipt = await settleRepository(...args);
        if (outcome === "retired") {
          await placementStore.startDrain({
            sessionId: receipt.sessionId,
            environmentId: harness.ready.environmentId,
            ownerEpoch: 2,
            expectedGeneration: receipt.generation,
          });
          retired.abort(new Error("fixture placement retired"));
        }
        return receipt;
      });
      const authority = createAdmittedRunOperatorAuthority({
        profileId: "fixture",
        scopes: ["operator.write"],
        assertCurrent: () => {
          if (!current) {
            throw new Error("fixture original authority revoked");
          }
        },
        retain: () => release,
      });
      const baseTunnel = harness.tunnelHandle(2);
      const repositoryCommand = vi.fn(baseTunnel.runWorkspaceCommand);
      const readiness = createNodeRepositoryReadiness({
        signal: retired.signal,
        assertCurrent: () => {},
        run: async (command) => ({
          ...(await baseTunnel.runWorkspaceCommand(command)),
          stdout: command.repositoryPreparation?.status ?? "",
          workspaceDir: "/worker/workspace",
        }),
      });
      const tunnel: WorkerTunnelHandle = {
        ...baseTunnel,
        prepareRepositoryWorkspace: readiness.prepare,
        settleRepositoryWorkspace: vi.fn(readiness.settle),
        runWorkspaceCommand: (command) => readiness.execute(command, repositoryCommand),
      };
      vi.mocked(harness.environments.startTunnel).mockImplementation(async () => tunnel);
      const prepareIntent = vi
        .mocked(harness.environments.prepareProjectIntent)
        .getMockImplementation();
      if (!prepareIntent) {
        throw new Error("Repository intent fixture is unavailable");
      }
      vi.mocked(harness.environments.prepareProjectIntent).mockImplementation(async (...args) => {
        entered.resolve();
        await delayed.promise;
        if (outcome !== "revoked") {
          throw new Error("fixture repository admission failed");
        }
        return await prepareIntent(...args);
      });
      const startup = createWorkerPlacementDispatchStartup({
        placements: placementStore,
        environments: harness.environments,
        failure: createPlacementFailureActions({
          placements: placementStore,
          environments: harness.environments,
        }),
        runRecoveryBarrier: async () => {},
        runActivationBarrier: async ({ activate }) => activate(),
        isCurrentNodePlacement: () => true,
      });
      const workspace = {
        kind: "repository" as const,
        repository: {
          workspaceId: "fixture-workspace",
          agentId: REQUEST.agentId,
          sessionKey: REQUEST.sessionKey,
          url: "https://github.com/fixture/source.git",
          requestedRef: "refs/heads/topic",
          branch: "topic",
          baseCommit: null,
          baseManifestHash: null,
          checkpointRef: null,
          manifestHash: null,
          revision: 0,
          runSetupScript: false,
          createdAtMs: 1,
          updatedAtMs: 1,
        },
      };
      const active = await startup.continueProvisionedDispatch({
        request: {
          ...REQUEST,
          executionMode: "remote-exec",
          operatorAuthority: authority,
          trackRepositoryPreparation: (operation) => {
            background.push(operation);
            void operation.catch(() => undefined);
          },
          assertRepositoryPreparationCurrent: () => {},
          assertRepositoryCleanupCurrent: () => {
            if (placementStore.get(REQUEST.sessionId)?.state !== "active") {
              throw new Error("fixture placement retired");
            }
          },
        },
        placement: provisioning,
        environment: harness.ready,
        expectedEnvironmentId: harness.ready.environmentId,
        workspace,
        asynchronousRepository: true,
        admittedNode: {
          node: {
            nodeId: "fixture",
            connId: "fixture",
            pairingIdentity: "fixture",
            pairingGeneration: "fixture",
            clientId: "node-host",
            clientMode: "node",
            protocolFeature: "node-worker-supervisor-v6",
            workerHost: {
              enabled: true,
              capacity: { total: 1, available: 1 },
              repositoryReadiness: 1,
            },
            commands: [],
          },
          requirement: { consumesWorkerSlot: false, requiredNodeCommands: [] },
        },
      });
      await entered.promise;
      expect(active).toMatchObject({
        state: "active",
        workspaceBaseManifestRef: null,
        repositoryPreparation: "pending",
        remoteWorkspaceDir: "/worker/workspace",
      });
      // The readiness handshake itself uses this transport; only a subsequent
      // repository command must remain withheld.
      const pendingCommand = tunnel.runWorkspaceCommand({
        argv: ["git", "status"],
        transportRetry: "never",
      });
      void pendingCommand.catch(() => undefined);
      expect(repositoryCommand.mock.calls.some(([command]) => command.argv[0] === "git")).toBe(
        false,
      );
      expect(release).not.toHaveBeenCalled();
      if (outcome === "revoked") {
        current = false;
      }
      delayed.resolve();
      await expect(background[0]).rejects.toThrow(
        outcome === "revoked"
          ? "fixture original authority revoked"
          : "fixture repository admission failed",
      );
      await expect(pendingCommand).rejects.toThrow(
        outcome === "retired"
          ? "Operation aborted"
          : "Repository preparation failed; this operation did not run",
      );
      expect(repositoryCommand.mock.calls.some(([command]) => command.argv[0] === "git")).toBe(
        false,
      );
      expect(placementStore.get(REQUEST.sessionId)).toMatchObject({
        state: outcome === "retired" ? "draining" : "active",
        generation: active.generation + (outcome === "retired" ? 1 : 0),
        repositoryPreparation: "failed",
        workspaceBaseManifestRef: null,
      });
      expect(release).toHaveBeenCalledOnce();
      expect(tunnel.settleRepositoryWorkspace).toHaveBeenCalledTimes(outcome === "retired" ? 0 : 1);
      expect(stage).toHaveBeenCalledWith(
        REQUEST.sessionId,
        "workspace_sync_failed",
        expect.objectContaining({
          preparationPhase: "intent",
          preparationSignalAborted: false,
          operatorSignalAborted: false,
        }),
      );
      stage.mockRestore();
    } finally {
      await closeStateDatabaseForTest();
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);
