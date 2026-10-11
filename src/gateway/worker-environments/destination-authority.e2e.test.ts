import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.js";
import { managedWorktrees } from "../../agents/worktrees/service.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { sha256HexPrefixCore } from "../../infra/crypto-digest.js";
import {
  NODE_WORKER_ENVIRONMENT_STOP_COMMAND,
  NODE_WORKER_WORKSPACE_EXEC_COMMAND,
} from "../../infra/node-commands.js";
import * as operationAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { NodeWorkerWorkspaceRuntime } from "../../node-host/node-worker-workspace.js";
import type { WorkerProvider } from "../../plugins/types.js";
import * as projectClones from "../../projects/project-clone.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { withOpenClawStateLease } from "../../state/openclaw-state-lease.js";
import { getSessionRepositoryWorkspaceStore } from "../../state/session-repository-workspaces.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { reserveTestPortListener } from "../../test-utils/port-claims.js";
import { parseNodeWorkerEnvironmentStopInput } from "../../worker/node-supervisor-protocol.js";
import { parseNodeWorkerWorkspaceExecInput } from "../../worker/node-workspace-protocol.js";
import { createGatewayWorkerPlacementRuntime } from "../server-worker-placement-startup.js";
import * as materialization from "../session-repository-materialization.js";
import { hashWorkerCredential } from "./credential.js";
import { bindDeviceWorkerAvailability } from "./device-provider.js";
import { createNodeWorkerTunnelManager } from "./node-worker-tunnel.js";
import { BUILD, transport } from "./node-worker-tunnel.test-support.js";
import {
  createNodeWorkspaceTransferHttpCallback,
  handleNodeWorkspaceTransferHttpRequest,
} from "./node-workspace-transfer-http.js";
import { createNodeWorkspaceTransferService } from "./node-workspace-transfer-service.js";
import { placementTurnOwner } from "./placement-record.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { createWorkerSessionPlacementGate } from "./placement-worker-gate.js";
import { deriveEnvironmentIntent } from "./service-contract.js";
import { createWorkerEnvironmentService } from "./service.js";
import { stageSessionRepositoryCheckpoint } from "./session-repository-checkpoints.js";
import { createWorkerEnvironmentStore } from "./store.js";
import { captureWorkspaceManifest } from "./workspace-manifest-worker.js";
import { serializeWorkerWorkspaceManifest } from "./workspace-manifest.js";
import { workerWorkspaceResultRef } from "./workspace-result-staging.js";

const exec = promisify(execFile);
const git = async (root: string, args: string[]) =>
  (await exec("git", ["-C", root, ...args])).stdout.trim();

// Release-only composition: the normal PR lane does not pay for node transfer,
// Git cloning, checkpoint restoration, managed worktrees, and session writers.
const authorityCases = [
  {
    contract: "destination preparation",
    modes: ["allowed", "policy-activated", "accepted-stop", "accepted-attached-stop"],
  },
  {
    contract: "pending-result settlement",
    modes: [
      "accepted-allowed",
      "accepted-policy-destroy",
      "accepted-policy-transaction",
      "accepted-policy-commit",
    ],
  },
  {
    contract: "failed-placement recovery",
    modes: ["failed-allowed", "failed-policy-transaction", "failed-policy-commit"],
  },
] as const;
it.for(authorityCases)("enforces $contract", async ({ contract, modes }, { signal }) => {
  await withOpenClawTestState(
    {
      label: "destination-authority",
      env: {
        GH_TOKEN: undefined,
        GITHUB_TOKEN: undefined,
        GH_ENTERPRISE_TOKEN: undefined,
        GITHUB_ENTERPRISE_TOKEN: undefined,
        GH_HOST: undefined,
      },
    },
    async (state) => {
      const source = state.path("source");
      await fs.mkdir(source);
      await git(source, ["init", "-b", "main"]);
      await git(source, ["config", "user.name", "OpenClaw Test"]);
      await git(source, ["config", "user.email", "test@example.invalid"]);
      await fs.writeFile(path.join(source, "result.txt"), "base\n");
      await git(source, ["add", "."]);
      await git(source, ["commit", "-m", "synthetic source"]);
      const baseCommit = await git(source, ["rev-parse", "HEAD"]);
      const base = await captureWorkspaceManifest({ root: source, baseCommit });
      const remotes = state.path("remotes");
      await fs.mkdir(remotes);
      // Git itself handles the fixture transport; production clone/ls-remote commands
      // and guards are unchanged, and never contact public GitHub or use credentials.
      await withEnvAsync(
        {
          GIT_CONFIG_COUNT: "2",
          GIT_CONFIG_KEY_0: `url.file://${remotes}/.insteadOf`,
          GIT_CONFIG_VALUE_0: "https://github.com/openclaw/",
          GIT_CONFIG_KEY_1: "protocol.file.allow",
          GIT_CONFIG_VALUE_1: "always",
        },
        async () => {
          let ownedNode: NodeWorkerWorkspaceRuntime | undefined;
          let ownedTransfer: ReturnType<typeof createNodeWorkspaceTransferService> | undefined;
          let ownedServer: http.Server | undefined;
          let ownedListener: Awaited<ReturnType<typeof reserveTestPortListener>> | undefined;
          let ownedEnvironments: ReturnType<typeof createWorkerEnvironmentService> | undefined;
          await runQaGatewayFixture(
            async () => {
              const database = openOpenClawStateDatabase();
              const placements = createWorkerSessionPlacementStore({ database });
              const store = await createWorkerEnvironmentStore({ database });
              const scheduler = createTestGatewayScheduler();
              const realGit = (await exec("which", ["git"])).stdout.trim();
              const gitBin = state.path("git-transport");
              await fs.mkdir(gitBin);
              // Node workers intentionally discard GIT_CONFIG_*; this executable adapter
              // changes only transport and delegates every operation to the real Git owner.
              await fs.writeFile(
                path.join(gitBin, "git"),
                `#!${process.execPath}
const { execFile } = require("node:child_process");
const child = execFile(${JSON.stringify(realGit)}, [
  "-c", ${JSON.stringify(`url.file://${remotes}/.insteadOf=https://github.com/openclaw/`)},
  "-c", "protocol.file.allow=always", ...process.argv.slice(2),
], { encoding: "buffer", maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  process.exitCode = error ? 1 : 0;
});
process.stdin.pipe(child.stdin);
`,
                { mode: 0o700 },
              );
              const node = new NodeWorkerWorkspaceRuntime({
                root: state.path("node"),
                env: { ...state.env, PATH: `${gitBin}${path.delimiter}${state.env.PATH}` },
                ephemeral: true,
              });
              ownedNode = node;
              const transfer = createNodeWorkspaceTransferService({
                getOwner: store.getTransferOwner,
                temporaryRoot: state.path("transfer"),
              });
              ownedTransfer = transfer;
              const callback = createNodeWorkspaceTransferHttpCallback(transfer);
              const server = http.createServer((req, res) => {
                void handleNodeWorkspaceTransferHttpRequest({
                  req,
                  res,
                  callback,
                  clientIp: "127.0.0.1",
                })
                  .then((handled) => {
                    if (!handled) {
                      res.writeHead(404);
                      res.end();
                    }
                  })
                  .catch((error: unknown) =>
                    res.destroy(error instanceof Error ? error : new Error("Transfer failed")),
                  );
              });
              ownedServer = server;
              const listener = await reserveTestPortListener({
                offsets: [0],
                createListener: () => server,
              });
              ownedListener = listener;
              const address = server.address();
              if (!address || typeof address === "string") {
                throw new Error("Transfer listener missing");
              }
              const gateway = { url: `ws://127.0.0.1:${address.port}` };
              const adapter = transport();
              const listNodes = adapter.listCurrentNodes.bind(adapter);
              adapter.listCurrentNodes = async () => {
                const nodes = await listNodes();
                for (const current of nodes) {
                  Object.assign(current.workerHost, {
                    capturedExecPolicy: true,
                    promptContext: 1,
                  });
                }
                return nodes;
              };
              adapter.invoke = async (request) => {
                request.signal?.throwIfAborted();
                if (request.isDispatchAuthorized && !request.isDispatchAuthorized()) {
                  throw new Error("Synthetic transport admission closed");
                }
                if (request.command === NODE_WORKER_WORKSPACE_EXEC_COMMAND) {
                  request.onDispatchReady?.(`destination-${request.command}`);
                  const result = await node.exec(
                    parseNodeWorkerWorkspaceExecInput(JSON.stringify(request.params)),
                    request.signal,
                    gateway,
                  );
                  return { ok: true, payloadJSON: JSON.stringify(result) };
                }
                if (request.command === NODE_WORKER_ENVIRONMENT_STOP_COMMAND) {
                  await node.processes.stopEnvironment(
                    parseNodeWorkerEnvironmentStopInput(JSON.stringify(request.params)),
                  );
                  return { ok: true, payloadJSON: "null" };
                }
                throw new Error(`Unexpected synthetic transport command: ${request.command}`);
              };
              const tunnels = createNodeWorkerTunnelManager({
                gatewayDeviceId: "destination-proof-gateway",
                getEnvironment: store.get,
                listEnvironments: store.list,
                getTransport: () => adapter,
                workspaceTransfer: transfer,
                validateWorkerTurn: placements.validateTurnClaim,
                launchNodeWorker: async () => {
                  throw new Error("No model turn belongs in destination proof");
                },
              });
              let config: OpenClawConfig = {
                agents: {
                  defaults: { workspace: source },
                  entries: { main: { workspace: source } },
                },
                cloudWorkers: {
                  requiredProfile: "development",
                  profiles: { development: { provider: "synthetic", settings: {} } },
                },
              };
              const publishConfig = (requiredProfile?: string) => {
                config = { ...config, cloudWorkers: { ...config.cloudWorkers, requiredProfile } };
                setRuntimeConfigSnapshot(config);
              };
              await state.writeConfig(config);
              publishConfig("development");
              let activateDuringDestroy = false;
              const provider: WorkerProvider = {
                id: "synthetic",
                requiresNodeEnrollment: true,
                supportedExecutionModes: ["worker-turn"],
                resolveAllocation: async () => {
                  throw new Error("Expected an existing warm allocation");
                },
                provision: async () => {
                  throw new Error("Expected an existing warm allocation");
                },
                inspect: async () => ({ status: "active" }),
                destroy: async ({ leaseId }) => {
                  await fs.rm(leaseId, { recursive: true, force: true });
                  if (activateDuringDestroy) {
                    publishConfig("development");
                    activateDuringDestroy = false;
                  }
                },
              };
              const environments = createWorkerEnvironmentService({
                scheduler,
                store,
                getConfig: () => config,
                resolveProvider: () => provider,
                prepareInstallation: async () => ({
                  install: "bundle",
                  ...BUILD,
                  tarballBytes: 1,
                  tarballSha256: "b".repeat(64),
                  tarballPath: state.path("unused-bundle"),
                }),
                bootstrapWorker: async () => {
                  throw new Error("Warm allocation already bootstrapped");
                },
                executeInference: async () => {
                  throw new Error("No inference belongs in destination proof");
                },
                nodeTunnelManager: tunnels,
                placementStore: createWorkerSessionPlacementGate(placements),
              });
              ownedEnvironments = environments;
              bindDeviceWorkerAvailability(environments, async (deviceId) => ({
                available: true,
                node: await adapter.getCurrentNode(deviceId),
              }));
              const runtime = createGatewayWorkerPlacementRuntime({
                scheduler,
                environments,
                placements,
                getCommittedRuntimeConfig: () => config,
                gatewayNamespace: "destination-proof",
                cancelSessionWork: async ({ assertCurrent }) => assertCurrent(),
                revokeSessionAuthority: () => {},
                warn: () => {},
              });
              runtime.bindNodeWorkerSupervisorTransport(adapter);
              await fs.mkdir(state.statePath("projects"), { recursive: true });
              const lateSettlements: string[] = [];
              const failedRecoveries: string[] = [];
              for (const mode of modes) {
                publishConfig("development");
                const url = `https://github.com/openclaw/destination-${mode}.git`;
                await exec("git", [
                  "clone",
                  "--bare",
                  "--",
                  source,
                  path.join(remotes, `destination-${mode}.git`),
                ]);
                const identity = {
                  sessionId: `destination-${mode}`,
                  sessionKey: `agent:main:destination-${mode}`,
                  agentId: "main",
                };
                await upsertSessionEntryCore(identity, {
                  sessionId: identity.sessionId,
                  updatedAt: 1,
                });
                const repositories = getSessionRepositoryWorkspaceStore();
                let repository = await repositories.create({
                  ...identity,
                  url,
                  runSetupScript: false,
                  assertCurrent: () => {},
                });
                repository = await repositories.bindBase({
                  workspaceId: repository.workspaceId,
                  expectedRevision: repository.revision,
                  baseCommit,
                  baseManifestHash: base.manifestRef,
                  assertCurrent: () => {},
                });
                const checkpointRoot = state.path(`checkpoint-${mode}`);
                await exec("git", ["clone", "--", source, checkpointRoot]);
                await fs.writeFile(path.join(checkpointRoot, "result.txt"), "accepted\n");
                const current = await captureWorkspaceManifest({
                  root: checkpointRoot,
                  baseCommit,
                });
                const checkpoint = await stageSessionRepositoryCheckpoint({
                  workspaceId: repository.workspaceId,
                  expectedRevision: repository.revision,
                  stagingRoot: checkpointRoot,
                  baseManifestRaw: serializeWorkerWorkspaceManifest(base.manifest),
                  currentManifestRaw: serializeWorkerWorkspaceManifest(current.manifest),
                  baseManifestRef: base.manifestRef,
                  currentManifestRef: current.manifestRef,
                  assertCurrent: () => {},
                });
                repository = await checkpoint.publish();
                await upsertSessionEntryCore(identity, {
                  sessionId: identity.sessionId,
                  repositoryWorkspaceId: repository.workspaceId,
                  worktree: undefined,
                  spawnedCwd: undefined,
                });
                const idempotencyKey = `destination-proof:${mode}`;
                const intent = deriveEnvironmentIntent(idempotencyKey);
                const leaseId = state.path(`lease-${mode}`);
                await fs.mkdir(leaseId);
                await fs.writeFile(path.join(leaseId, "allocation"), "live\n");
                let environment = await store.createIntent({
                  ...intent,
                  providerId: provider.id,
                  profileId: "development",
                  profileSnapshot: { settings: {}, executionMode: "worker-turn" },
                });
                environment = await store.transition({
                  environmentId: environment.environmentId,
                  from: "requested",
                  to: "provisioning",
                });
                await store.transition({
                  environmentId: environment.environmentId,
                  from: "provisioning",
                  to: "ready",
                  patch: {
                    leaseId,
                    nodeDeviceId: "node-1",
                    sharedHost: false,
                    bootstrapReceipt: { ...BUILD, installKind: "bundle" },
                    credential: {
                      credentialHash: hashWorkerCredential(`synthetic-${mode}`),
                      sessionId: null,
                      rpcSetVersion: 1,
                      expiresAtMs: Date.now() + 60_000,
                    },
                  },
                });
                const active = await runtime.dispatchService.dispatch(
                  {
                    ...identity,
                    profileId: "development",
                    requiredProfile: "development",
                    executionMode: "worker-turn",
                    idempotencyKey,
                  },
                  undefined,
                  undefined,
                  signal,
                );
                expect(active.state).toBe("active");
                expect(environments.get(active.environmentId)).toMatchObject({
                  state: "attached",
                  profileId: "development",
                  attachedSessionIds: [identity.sessionId],
                });
                expect(
                  await fs.readFile(path.join(active.remoteWorkspaceDir, "result.txt"), "utf8"),
                ).toBe("accepted\n");
                publishConfig();
                if (mode.startsWith("failed-")) {
                  const draining = await placements.startDrain({
                    sessionId: identity.sessionId,
                    environmentId: active.environmentId,
                    ownerEpoch: active.activeOwnerEpoch,
                    expectedGeneration: active.generation,
                  });
                  await environments.destroy(active.environmentId);
                  const reconciling = await placements.startReconcile({
                    sessionId: identity.sessionId,
                    environmentId: active.environmentId,
                    ownerEpoch: active.activeOwnerEpoch,
                    expectedGeneration: draining.generation,
                  });
                  const failed = await placements.fail({
                    sessionId: identity.sessionId,
                    expectedGeneration: reconciling.generation,
                    recoveryError: "Production proof worker disappeared",
                  });
                  const createAdmission = operationAdmission.createSqliteWorkerOperationAdmission;
                  let policyActivated = false;
                  const admission = vi.spyOn(
                    operationAdmission,
                    "createSqliteWorkerOperationAdmission",
                  );
                  const transition = placements.transition.bind(placements);
                  const observation = vi
                    .spyOn(placements, "transition")
                    .mockImplementation((...args) => {
                      if (
                        args[0].sessionId === identity.sessionId &&
                        args[0].from === "failed" &&
                        args[0].to === "local" &&
                        mode !== "failed-allowed"
                      ) {
                        const stage =
                          mode === "failed-policy-transaction" ? "transaction" : "commit";
                        admission.mockImplementationOnce((admit, attachment) =>
                          createAdmission((request, grant) => {
                            if (request.stage === stage) {
                              publishConfig("development");
                              policyActivated = true;
                            }
                            admit(request, grant);
                          }, attachment),
                        );
                      }
                      return transition(...args);
                    });
                  let refused = false;
                  try {
                    await runtime.dispatchService.reclaim({
                      ...identity,
                      recoverToGateway: { expectedGeneration: failed.generation },
                    });
                  } catch (error) {
                    expect(String(error)).toContain("required worker profile policy");
                    refused = true;
                  } finally {
                    observation.mockRestore();
                    admission.mockRestore();
                  }
                  expect(policyActivated).toBe(mode !== "failed-allowed");
                  const placement = placements.get(identity.sessionId);
                  failedRecoveries.push(
                    `${mode}:${refused ? "refused" : "allowed"}:${placement?.state}`,
                  );
                  const worktree = await managedWorktrees.findLiveByOwner(
                    "session",
                    identity.sessionKey,
                  );
                  if (!worktree) {
                    throw new Error("Gateway recovery did not restore its managed worktree");
                  }
                  expect(await fs.readFile(path.join(worktree.path, "result.txt"), "utf8")).toBe(
                    "accepted\n",
                  );
                  expect(await repositories.get(repository.workspaceId)).toMatchObject({
                    manifestHash: current.manifestRef,
                  });
                  if (refused) {
                    expect(placement).toMatchObject({
                      state: "failed",
                      generation: failed.generation,
                    });
                    await expect(
                      placements.claimTurn({
                        ...identity,
                        owner: { kind: "local" },
                        claimId: `failed-${mode}`,
                        runId: `failed-${mode}`,
                      }),
                    ).rejects.toThrow();
                  }
                  expect(environments.get(active.environmentId)?.state).toBe("destroyed");
                  console.info(
                    `failed-recovery-boundary ${mode}: policy-activated=${policyActivated} refused=${refused} placement=${placement?.state} accepted-file=retained source=destroyed`,
                  );
                  continue;
                }
                const begun = await placements.beginPlacementMove({
                  sessionId: active.sessionId,
                  source: {
                    generation: active.generation,
                    environmentId: active.environmentId,
                    ownerEpoch: active.activeOwnerEpoch,
                  },
                  target: { kind: "gateway" },
                });
                const cloneFilesBefore = await fs.readdir(state.statePath("projects"), {
                  recursive: true,
                });
                expect(cloneFilesBefore).not.toContain(sha256HexPrefixCore(url, 16));
                const latePolicy = mode.startsWith("accepted-policy-");
                if (mode.startsWith("accepted-")) {
                  const claim = await placements.claimReclaimWorkspaceResult({
                    ...identity,
                    claimId: "reclaim-accepted-stop",
                    runId: "reclaim-accepted-stop",
                    owner: placementTurnOwner(active),
                  });
                  if (mode === "accepted-attached-stop") {
                    await fs.writeFile(
                      path.join(active.remoteWorkspaceDir, "result.txt"),
                      "accepted\n",
                    );
                  }
                  const resultCheckpoint = await stageSessionRepositoryCheckpoint({
                    workspaceId: repository.workspaceId,
                    expectedRevision: repository.revision,
                    checkpointRef: workerWorkspaceResultRef(claim.claimId),
                    stagingRoot: checkpointRoot,
                    baseManifestRaw: serializeWorkerWorkspaceManifest(base.manifest),
                    currentManifestRaw: serializeWorkerWorkspaceManifest(current.manifest),
                    baseManifestRef: base.manifestRef,
                    currentManifestRef: current.manifestRef,
                    assertCurrent: () => {
                      if (!placements.validateWorkspaceResultClaim(claim)) {
                        throw new Error("Synthetic result lost its real placement claim");
                      }
                    },
                  });
                  repository = await resultCheckpoint.publish();
                  await placements.recordStagedWorkspaceResult(
                    claim,
                    resultCheckpoint.checkpointRef,
                    repository.workspaceId,
                  );
                  await placements.acceptWorkspaceResult(claim);
                  await placements.handoffWorkspaceResultRecovery(claim);
                  if (mode === "accepted-stop") {
                    await environments.destroy(active.environmentId);
                  }
                  const originalComplete =
                    placements.completePlacementMoveSourceToLocal.bind(placements);
                  const createAdmission = operationAdmission.createSqliteWorkerOperationAdmission;
                  let policyActivated = false;
                  const admission = vi.spyOn(
                    operationAdmission,
                    "createSqliteWorkerOperationAdmission",
                  );
                  const completion = vi
                    .spyOn(placements, "completePlacementMoveSourceToLocal")
                    .mockImplementation((...args) => {
                      if (
                        mode === "accepted-policy-transaction" ||
                        mode === "accepted-policy-commit"
                      ) {
                        const stage =
                          mode === "accepted-policy-transaction" ? "transaction" : "commit";
                        admission.mockImplementationOnce((admit, attachment) =>
                          createAdmission((request, grant) => {
                            if (request.stage === stage) {
                              publishConfig("development");
                              policyActivated = true;
                            }
                            admit(request, grant);
                          }, attachment),
                        );
                      }
                      return originalComplete(...args);
                    });
                  activateDuringDestroy = mode === "accepted-policy-destroy";
                  if (!latePolicy && mode !== "accepted-allowed") {
                    publishConfig("development");
                  }
                  try {
                    await runtime.dispatchService.reconcileActive(active.environmentId);
                  } finally {
                    completion.mockRestore();
                    admission.mockRestore();
                  }
                  if (mode === "accepted-policy-transaction" || mode === "accepted-policy-commit") {
                    expect(policyActivated).toBe(true);
                  }
                  if (mode === "accepted-policy-destroy") {
                    expect(activateDuringDestroy).toBe(false);
                    expect(config.cloudWorkers?.requiredProfile).toBe("development");
                  }
                  if (latePolicy) {
                    lateSettlements.push(`${mode}:${placements.get(identity.sessionId)?.state}`);
                    expect(placements.get(identity.sessionId)?.turnClaim).toBeNull();
                  } else if (mode === "accepted-allowed") {
                    expect(placements.get(identity.sessionId)).toMatchObject({
                      state: "local",
                      turnClaim: null,
                    });
                  }
                  expect(await loadTranscriptEvents(identity)).not.toEqual(
                    expect.arrayContaining([
                      expect.objectContaining({ customType: "cloud-workspace-recovery-failed" }),
                    ]),
                  );
                  if (!latePolicy && mode !== "accepted-allowed") {
                    await expect(runtime.dispatchService.reclaim(identity)).resolves.toMatchObject({
                      state: "reclaimed",
                      turnClaim: null,
                    });
                  }
                  expect(await placements.listPendingWorkspaceResultsAsync()).toEqual([]);
                  expect(
                    await placements.getPlacementMoveAsync(identity.sessionId),
                  ).toBeUndefined();
                } else {
                  await placements.startReconcile({
                    sessionId: active.sessionId,
                    environmentId: active.environmentId,
                    ownerEpoch: active.activeOwnerEpoch,
                    expectedGeneration: begun.placement.generation,
                  });
                  await environments.destroy(active.environmentId);
                  const observedMaterialization = vi
                    .spyOn(materialization, "materializeSessionRepositoryWorkspaceOnGateway")
                    .mockClear();
                  const entered = createDeferred();
                  const release = createDeferred();
                  const held = withOpenClawStateLease(
                    {
                      scope: "projects.clone",
                      key: sha256HexPrefixCore(url, 16),
                      database: { scope: "shared" },
                      leaseMs: 60_000,
                      waitMs: 0,
                      signal,
                    },
                    async () => {
                      entered.resolve();
                      await release.promise;
                    },
                  );
                  const arriving = createDeferred();
                  const originalClone = projectClones.materializeProjectClone;
                  const observation = vi
                    .spyOn(projectClones, "materializeProjectClone")
                    .mockImplementation((...args) => {
                      if (args[0].gitUrl === url) {
                        arriving.resolve();
                      }
                      return originalClone(...args);
                    });
                  let recovering: Promise<void> | undefined;
                  try {
                    await withinTest(entered.promise, signal);
                    recovering = runtime.dispatchService.reconcile();
                    await withinTest(
                      awaitGateBeforeSettlement(
                        arriving.promise,
                        recovering,
                        "Recovery did not reach its real project clone lease",
                      ),
                      signal,
                    );
                    if (mode === "policy-activated") {
                      publishConfig("development");
                    }
                  } finally {
                    release.resolve();
                    await held;
                    await recovering;
                    observation.mockRestore();
                  }
                  if (mode !== "allowed") {
                    const currentCall = observedMaterialization.mock.calls.findIndex(
                      ([params]) => params.sessionId === identity.sessionId,
                    );
                    expect(currentCall).toBeGreaterThanOrEqual(0);
                    await expect(
                      observedMaterialization.mock.results[currentCall]?.value,
                    ).rejects.toThrow("required worker profile policy");
                  }
                  observedMaterialization.mockRestore();
                  if (mode === "allowed") {
                    expect(placements.get(identity.sessionId)?.state).toBe("local");
                    const entry = loadSessionEntry(identity);
                    const worktree = await managedWorktrees.findLiveByOwner(
                      "session",
                      identity.sessionKey,
                    );
                    expect(entry?.repositoryWorkspaceId).toBeUndefined();
                    expect(entry?.worktree?.id).toBe(worktree?.id);
                    expect(worktree).toBeDefined();
                    expect(await fs.readFile(path.join(worktree!.path, "result.txt"), "utf8")).toBe(
                      "accepted\n",
                    );
                    expect(await git(worktree!.path, ["rev-parse", "HEAD"])).toBe(baseCommit);
                  } else {
                    expect(loadSessionEntry(identity)?.repositoryWorkspaceId).toBe(
                      repository.workspaceId,
                    );
                    expect(
                      await managedWorktrees.findLiveByOwner("session", identity.sessionKey),
                    ).toBeUndefined();
                    expect(placements.get(identity.sessionId)?.state).toBe("reconciling");
                    if (mode === "policy-activated") {
                      expect(
                        (await placements.getPlacementMoveAsync(identity.sessionId))?.lastError,
                      ).toContain("required worker profile policy");
                    }
                  }
                }
                if (mode !== "allowed" && !latePolicy && mode !== "accepted-allowed") {
                  expect(
                    await fs.readdir(state.statePath("projects"), { recursive: true }),
                  ).toEqual(cloneFilesBefore);
                  expect(loadSessionEntry(identity)?.repositoryWorkspaceId).toBe(
                    repository.workspaceId,
                  );
                  expect(
                    await managedWorktrees.findLiveByOwner("session", identity.sessionKey),
                  ).toBeUndefined();
                }
                if (latePolicy || mode === "accepted-allowed") {
                  const entry = loadSessionEntry(identity);
                  const worktree = await managedWorktrees.findLiveByOwner(
                    "session",
                    identity.sessionKey,
                  );
                  expect(entry?.worktree?.id).toBe(worktree?.id);
                  expect(worktree).toBeDefined();
                  expect(await fs.readFile(path.join(worktree!.path, "result.txt"), "utf8")).toBe(
                    "accepted\n",
                  );
                }
                expect(environments.get(active.environmentId)?.state).toBe("destroyed");
                await expect(fs.stat(leaseId)).rejects.toMatchObject({ code: "ENOENT" });
                expect(await repositories.get(repository.workspaceId)).toMatchObject({
                  workspaceId: repository.workspaceId,
                  baseCommit,
                  manifestHash: current.manifestRef,
                });
                console.info(
                  `destination-boundary ${mode}: required-placement=${Boolean(config.cloudWorkers?.requiredProfile)} gateway-binding=${Boolean(loadSessionEntry(identity)?.worktree)} source=destroyed checkpoint=retained placement=${placements.get(identity.sessionId)?.state}`,
                );
                if (mode === "policy-activated") {
                  // Retire the synthetic operation after asserting its retained rejection;
                  // later controls must not resume it when their policy is intentionally off.
                  await placements.cancelPlacementMove(begun.intent);
                  await placements.fail({
                    sessionId: identity.sessionId,
                    expectedGeneration: placements.get(identity.sessionId)!.generation,
                    recoveryError: "Destination proof control completed",
                  });
                }
              }
              expect(lateSettlements).toEqual(
                contract === "pending-result settlement"
                  ? [
                      "accepted-policy-destroy:reclaimed",
                      "accepted-policy-transaction:reclaimed",
                      "accepted-policy-commit:reclaimed",
                    ]
                  : [],
              );
              expect(failedRecoveries).toEqual(
                contract === "failed-placement recovery"
                  ? [
                      "failed-allowed:allowed:local",
                      "failed-policy-transaction:refused:failed",
                      "failed-policy-commit:refused:failed",
                    ]
                  : [],
              );
            },
            () => vi.restoreAllMocks(),
            () => ownedEnvironments?.stop(),
            () => ownedTransfer?.closeAll(),
            () => ownedNode?.processes.close(),
            () => ownedNode?.quiescence.close(),
            () => ownedServer?.closeAllConnections(),
            () => ownedListener?.releaseListener(),
            () => ownedListener?.claim.release(),
            () => closeStateDatabaseForTest(),
          );
        },
      );
    },
  );
});
