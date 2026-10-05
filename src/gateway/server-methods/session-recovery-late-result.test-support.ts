import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { AdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import { NODE_WORKER_ENVIRONMENT_STOP_COMMAND } from "../../infra/node-commands.js";
import { parseNodeWorkerEnvironmentStopInput } from "../../worker/node-supervisor-protocol.js";
import { parseNodeWorkerWorkspaceExecInput } from "../../worker/node-workspace-protocol.js";
import type { NodeWorkerSupervisorTransport } from "../node-registry-private.js";
import { nodeWorkerGatewayNamespace } from "../worker-environments/node-worker-gateway-namespace.js";
import { createNodeWorkerTunnelManager } from "../worker-environments/node-worker-tunnel.js";
import { workspaceTransfer } from "../worker-environments/node-worker-tunnel.test-support.js";
import type { WorkerSessionTurnClaim } from "../worker-environments/placement-record.js";
import type { WorkerSessionPlacementStore } from "../worker-environments/placement-store.js";
import type { createNodeCarrier } from "../worker-environments/skill-resource-transfer.test-support.js";
import type { WorkerEnvironmentStore } from "../worker-environments/store.js";
import { captureWorkspaceSnapshot } from "../worker-environments/workspace-manifest-worker.js";
import { requireWorkspaceResultGit } from "../worker-environments/workspace-result-git.js";

/** Only node delivery is delayed; the read child, tunnel lifetime and claim guards run. */
export function createLateRecoveryResultFixture(params: {
  store: WorkerEnvironmentStore;
  placements: WorkerSessionPlacementStore;
  transport: NodeWorkerSupervisorTransport;
  carrier: Awaited<ReturnType<typeof createNodeCarrier>>;
  originalEnvironmentId: string;
  sessionId: string;
  afterCurrentRead?: () => Promise<void>;
}) {
  const readCompleted = createDeferred();
  const sourceClosed = createDeferred();
  const deliver = createDeferred();
  let originalClaim: WorkerSessionTurnClaim | undefined;
  let outcome: Promise<unknown> | undefined;
  let physicalReadCompleted = false;
  const transport: NodeWorkerSupervisorTransport = {
    ...params.transport,
    invoke: async (request) => {
      expect(params.transport.isCurrent(request.node)).toBe(true);
      expect(request.isDispatchAuthorized?.()).toBe(true);
      request.onDispatchReady?.("synthetic-node-receipt");
      if (request.command === NODE_WORKER_ENVIRONMENT_STOP_COMMAND) {
        const input = parseNodeWorkerEnvironmentStopInput(JSON.stringify(request.params));
        const environment = expectDefined(
          params.store.get(input.environmentId),
          "stop environment",
        );
        expect(input).toEqual({
          gatewayNamespace: nodeWorkerGatewayNamespace("startup-recovery-gateway"),
          environmentId: environment.environmentId,
          ownerEpoch: environment.ownerEpoch,
          sessionId: params.sessionId,
        });
        // Commands use the carrier's synthetic workspace binding; control must settle that same owner.
        const binding = params.carrier.binding;
        await params.carrier.stopEnvironment({
          gatewayNamespace: binding.gatewayNamespace,
          environmentId: binding.environmentId,
          ownerEpoch: binding.generation,
          sessionId: binding.sessionId,
        });
        return { ok: true, payloadJSON: "null" };
      }
      const input = parseNodeWorkerWorkspaceExecInput(JSON.stringify(request.params));
      const isOriginal = input.argv[2]?.includes("original-receipt:") === true;
      if (isOriginal) {
        request.signal?.addEventListener("abort", () => sourceClosed.resolve(), { once: true });
      }
      const result = await params.carrier.runWorkspaceCommand({
        argv: input.argv,
        input: input.input,
        timeoutMs: input.timeoutMs,
        transportRetry: "never",
      });
      if (isOriginal) {
        expect(result).toMatchObject({ code: 0, stdout: "original-receipt:accepted marker" });
        physicalReadCompleted = true;
        readCompleted.resolve();
        await deliver.promise;
      } else if (
        input.argv[0] === "node" &&
        input.argv[2]?.includes("readFileSync('accepted.txt'")
      ) {
        await params.afterCurrentRead?.();
      }
      return { ok: true, payloadJSON: JSON.stringify(result) };
    },
  };
  const manager = createNodeWorkerTunnelManager({
    gatewayDeviceId: "startup-recovery-gateway",
    getEnvironment: (id) => params.store.get(id),
    listEnvironments: () => params.store.list(),
    getTransport: () => transport,
    launchNodeWorker: async () => {
      throw new Error("Remote-exec recovery cannot launch an embedded worker");
    },
    validateWorkerTurn: (claim) => params.placements.validateTurnClaim(claim),
    workspaceTransfer: {
      ...workspaceTransfer(),
      prepareRepository: async (binding) => {
        expect(binding.isAuthorized()).toBe(true);
      },
      closeAll: async () => {},
    },
  });
  manager.bindWorkspaceBindingResolver(async () => {
    const baseCommit = await requireWorkspaceResultGit(params.carrier.workspace, [
      "rev-parse",
      "HEAD",
    ]);
    const base = await captureWorkspaceSnapshot({ root: params.carrier.workspace, baseCommit });
    return {
      source: { kind: "repository", baseCommit, baseManifestRef: base.manifestRef },
      manifestRef: base.manifestRef,
      remoteWorkspaceDir: params.carrier.workspace,
    };
  });
  return {
    manager,
    async beginOriginal(authority: AdmittedRunOperatorAuthority) {
      authority.assertCurrent();
      const active = expectDefined(params.placements.get(params.sessionId), "original placement");
      expect(active.state).toBe("active");
      const environment = expectDefined(
        params.store.get(params.originalEnvironmentId),
        "original environment",
      );
      const claim = await params.placements.claimTurn({
        agentId: active.agentId,
        sessionKey: active.sessionKey,
        sessionId: active.sessionId,
        claimId: "original-read-claim",
        runId: "original-read-run",
        owner: {
          kind: "local",
          environmentId: environment.environmentId,
          ownerEpoch: environment.ownerEpoch,
        },
      });
      originalClaim = claim;
      const assertCurrent = () => {
        authority.assertCurrent();
        if (!params.placements.validateTurnClaim(claim)) {
          throw new Error("Original native read claim closed");
        }
      };
      const tunnel = await manager.start({
        executionMode: "remote-exec",
        environmentId: environment.environmentId,
        ownerEpoch: environment.ownerEpoch,
        deviceId: expectDefined(environment.nodeDeviceId, "original node"),
        sessionId: active.sessionId,
        expectedBuild: expectDefined(environment.bootstrapReceipt, "original build"),
      });
      assertCurrent();
      const operation = tunnel.runWorkspaceCommand({
        argv: [
          "node",
          "-e",
          "process.stdout.write('original-receipt:' + require('node:fs').readFileSync('accepted.txt', 'utf8'))",
        ],
        transportRetry: "never",
        assertCurrent,
      });
      outcome = operation.then(
        (result) => result,
        (error: unknown) => error,
      );
      await Promise.race([
        readCompleted.promise,
        outcome.then((result) => {
          throw result;
        }),
      ]);
      expect(physicalReadCompleted).toBe(true);
      expect(await params.placements.listPendingWorkspaceResultsAsync(active.sessionId)).toEqual(
        [],
      );
      await params.placements.releaseTurn(claim);
    },
    async finishRetirement(retirement: Promise<void>) {
      await sourceClosed.promise;
      expect(physicalReadCompleted).toBe(true);
      expect(params.store.get(params.originalEnvironmentId)?.state).not.toBe("destroyed");
      // Stop joins the already-finished child's pending receipt before replacement is allowed.
      deliver.resolve();
      await retirement;
    },
    async assertLateRejected() {
      const result = await expectDefined(outcome, "delayed original outcome");
      expect(result).toMatchObject({ message: "node worker workspace authority closed" });
      const claim = expectDefined(originalClaim, "original read claim");
      expect(params.placements.validateTurnClaim(claim)).toBe(false);
      expect(params.placements.validateWorkspaceResultClaim(claim)).toBe(false);
      const current = params.placements.get(params.sessionId);
      const pending = await params.placements.listPendingWorkspaceResultsAsync(params.sessionId);
      await expect(params.placements.markWorkspaceResultPending(claim)).rejects.toThrow(
        "Cannot retain stale worker workspace result",
      );
      await expect(params.placements.acceptWorkspaceResult(claim)).rejects.toThrow(
        "Cannot update stale worker workspace result",
      );
      expect(await params.placements.listPendingWorkspaceResultsAsync(params.sessionId)).toEqual(
        pending,
      );
      expect(params.placements.get(params.sessionId)).toEqual(current);
    },
    release: () => deliver.resolve(),
  };
}
