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
it("enforces destination authority before real clone, worktree, and session-binding effects", async ({
  signal,
}) => {
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
                  Object.assign(current.workerHost, { capturedExecPolicy: true, promptContext: 1 });
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
              for (const mode of [
                "allowed",
                "policy-activated",
                "source-reassigned",
                "accepted-stop",
                "accepted-attached-stop",
              ] as const) {
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
                const begun = placements.beginPlacementMove({
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
                if (mode === "accepted-stop" || mode === "accepted-attached-stop") {
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
                  publishConfig("development");
                  await runtime.dispatchService.reconcileActive(active.environmentId);
                  expect(await loadTranscriptEvents(identity)).not.toEqual(
                    expect.arrayContaining([
                      expect.objectContaining({ customType: "cloud-workspace-recovery-failed" }),
                    ]),
                  );
                  await expect(runtime.dispatchService.reclaim(identity)).resolves.toMatchObject({
                    state: "reclaimed",
                    turnClaim: null,
                  });
                  expect(await placements.listPendingWorkspaceResultsAsync()).toEqual([]);
                  expect(placements.getPlacementMove(identity.sessionId)).toBeUndefined();
                } else {
                  const reconciling = await placements.startReconcile({
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
                    if (mode === "source-reassigned") {
                      placements.cancelPlacementMove(begun.intent);
                      await placements.fail({
                        sessionId: identity.sessionId,
                        expectedGeneration: reconciling.generation,
                        recoveryError: "Source reassigned",
                      });
                      await placements.startDispatch({ ...identity, executionMode: "worker-turn" });
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
                    ).rejects.toThrow(
                      mode === "policy-activated"
                        ? "required worker profile policy"
                        : "lost its source owner",
                    );
                  }
                  observedMaterialization.mockRestore();
                  if (mode === "allowed") {
                    expect(placements.get(identity.sessionId)?.state).toBe("local");
                    const entry = loadSessionEntry(identity);
                    const worktree = managedWorktrees.findLiveByOwner(
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
                      managedWorktrees.findLiveByOwner("session", identity.sessionKey),
                    ).toBeUndefined();
                    expect(placements.get(identity.sessionId)?.state).toBe(
                      mode === "policy-activated" ? "reconciling" : "requested",
                    );
                    if (mode === "policy-activated") {
                      expect(placements.getPlacementMove(identity.sessionId)?.lastError).toContain(
                        "required worker profile policy",
                      );
                    }
                  }
                }
                if (mode !== "allowed") {
                  expect(
                    await fs.readdir(state.statePath("projects"), { recursive: true }),
                  ).toEqual(cloneFilesBefore);
                  expect(loadSessionEntry(identity)?.repositoryWorkspaceId).toBe(
                    repository.workspaceId,
                  );
                  expect(
                    managedWorktrees.findLiveByOwner("session", identity.sessionKey),
                  ).toBeUndefined();
                }
                expect(environments.get(active.environmentId)?.state).toBe("destroyed");
                await expect(fs.stat(leaseId)).rejects.toMatchObject({ code: "ENOENT" });
                expect(await repositories.get(repository.workspaceId)).toMatchObject({
                  workspaceId: repository.workspaceId,
                  baseCommit,
                  manifestHash: current.manifestRef,
                });
                console.info(
                  `destination-boundary ${mode}: required-placement=active gateway-binding=${Boolean(loadSessionEntry(identity)?.worktree)} source=destroyed checkpoint=retained placement=${placements.get(identity.sessionId)?.state}`,
                );
                if (mode === "policy-activated" || mode === "source-reassigned") {
                  // Retire the synthetic operation after asserting its retained rejection;
                  // later controls must not resume it when their policy is intentionally off.
                  if (mode === "policy-activated") {
                    placements.cancelPlacementMove(begun.intent);
                  }
                  await placements.fail({
                    sessionId: identity.sessionId,
                    expectedGeneration: placements.get(identity.sessionId)!.generation,
                    recoveryError: "Destination proof control completed",
                  });
                }
              }
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
