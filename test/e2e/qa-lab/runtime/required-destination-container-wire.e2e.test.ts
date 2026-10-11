import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createQaGatewayChild,
  startQaMockOpenAiServer,
} from "../../../../extensions/qa-lab/api.js";
import { NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND } from "../../../../src/infra/node-commands.js";
import { resolveNodeWorkerContainerEngine } from "../../../../src/node-host/node-worker-container-engine.js";
import { runQaGatewayFixture, stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";
import { MODEL_REF, PROOF_TIMEOUT_MS } from "./cloud-worker-midturn-loss-fixture.js";
import {
  closeWireServer,
  connectWireClient,
  createPairedNodeWorkerHost,
  createPublishedWireWorkspace,
  startPairedNodeWorkerGateway,
  type PairedNodeWorkerHost,
  type WireGateway,
} from "./paired-node-worker-wire-fixture.js";

const execFileAsync = promisify(execFile);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const sessionKey = "agent:qa:required-destination-container";
const marker = "DOCKER_DESTINATION_RESULT_OK";
const file = "docker-destination-result.txt";
type Placement = {
  state: string;
  generation: number;
  environmentId: string;
  activeOwnerEpoch: number;
  remoteWorkspaceDir: string;
};

describe.runIf(process.env.OPENCLAW_DOCKER_NODE_WORKER_E2E === "1")(
  "required destination real Docker wire",
  () => {
    it(
      "retains accepted Docker results when policy revokes Gateway Move during real teardown",
      { timeout: PROOF_TIMEOUT_MS + 120_000 },
      async () => {
        const root = tempDirs.make("openclaw-required-destination-docker-");
        const provider = await startQaMockOpenAiServer({ modelRefs: [MODEL_REF] });
        const published = await createPublishedWireWorkspace(root);
        const gatewayOwner = createQaGatewayChild();
        let gateway: WireGateway | undefined;
        let workerNode: PairedNodeWorkerHost | undefined;
        let operator: Awaited<ReturnType<typeof connectWireClient>> | undefined;
        let observedContainer: Promise<string> | undefined;
        const image = process.env.OPENCLAW_DOCKER_NODE_WORKER_IMAGE ?? "node:24-bookworm";
        const docker = async (...args: string[]) =>
          (
            await execFileAsync("docker", args, { encoding: "utf8", timeout: 15_000 })
          ).stdout.trim();
        await runQaGatewayFixture(
          async () => {
            gateway = await startPairedNodeWorkerGateway({
              owner: gatewayOwner,
              providerBaseUrl: provider.baseUrl,
              fullAccess: true,
              useRepoCli: false,
              command: {
                executablePath: process.execPath,
                argsPrefix: [path.resolve("dist/index.js")],
                tempParentDir: await fs.realpath(root),
              },
            });
            operator = await connectWireClient({
              gateway,
              role: "operator",
              identity: null,
              includeApprovals: true,
            });
            const approval = await operator.request<{ hash: string }>("exec.approvals.get", {});
            await operator.request("exec.approvals.set", {
              baseHash: approval.hash,
              file: { version: 1, defaults: { security: "full", ask: "off", askFallback: "deny" } },
            });
            const engine = await resolveNodeWorkerContainerEngine();
            expect(engine.id).toBe("docker");
            const workerUrl = new URL(gateway.wsUrl);
            workerUrl.hostname =
              process.env.OPENCLAW_DOCKER_NODE_WORKER_GATEWAY_HOST ?? "host.docker.internal";
            workerNode = await createPairedNodeWorkerHost({
              gateway,
              operator,
              root,
              containerEngine: engine,
              containerImage: image,
              workerGatewayUrl: workerUrl.toString(),
              workerEnv: { OPENCLAW_ALLOW_INSECURE_PRIVATE_WS: "1" },
              onInvoke: (frame) => {
                if (frame.command !== NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND || !frame.paramsJSON) {
                  return;
                }
                const { launchId } = JSON.parse(frame.paramsJSON) as { launchId: string };
                observedContainer = (async () => {
                  let id = "";
                  await vi.waitFor(
                    async () => {
                      id = await docker(
                        "ps",
                        "--no-trunc",
                        "--filter",
                        `label=openclaw.node-worker.launch=${Buffer.from(launchId).toString("base64url")}`,
                        "--format",
                        "{{.ID}}",
                      );
                      expect(id).toMatch(/^[a-f0-9]{64}$/u);
                    },
                    { timeout: 30_000, interval: 50 },
                  );
                  expect(
                    await docker("inspect", "--format", "{{.Config.Image}} {{.State.Status}}", id),
                  ).toBe(`${image} running`);
                  return id;
                })();
                void observedContainer.catch(() => {});
              },
            });
            await operator.request("sessions.create", {
              key: sessionKey,
              agentId: "qa",
              worktree: true,
              worktreeName: "required-destination-docker",
              worktreeBaseRef: "main",
              cwd: published.source,
              permissionMode: "full",
            });
            const dispatched = await operator.request<{ placement: Placement }>(
              "sessions.dispatch",
              { key: sessionKey, deviceId: workerNode.identity.deviceId },
              { timeoutMs: PROOF_TIMEOUT_MS },
            );
            expect(dispatched.placement.state).toBe("active");
            const runId = `docker-destination-${Date.now()}`;
            await expect(
              operator.request("chat.send", {
                sessionKey,
                message: `Tool progress QA check: call the exec tool exactly once with this exact command before answering: \`test -f /.dockerenv && printf ${marker} > ${file}\`. After that exec command completes or fails, reply exactly \`${marker}\`.`,
                deliver: false,
                idempotencyKey: runId,
              }),
            ).resolves.toMatchObject({ runId, status: "started" });
            await expect(
              operator.request(
                "agent.wait",
                { runId, timeoutMs: PROOF_TIMEOUT_MS },
                { timeoutMs: PROOF_TIMEOUT_MS + 5_000 },
              ),
            ).resolves.toMatchObject({ status: "ok" });
            expect(observedContainer).toBeTruthy();
            const containerId = await observedContainer!;
            const readPlacement = async () =>
              (
                await operator!.request<{
                  session: { placement: Placement; execCwd?: string; spawnedCwd?: string };
                }>("sessions.describe", { key: sessionKey })
              ).session;
            const finished = await readPlacement();
            const gatewayWorkspace = finished.execCwd ?? finished.spawnedCwd;
            expect(gatewayWorkspace).toBeTruthy();
            for (const workspace of [finished.placement.remoteWorkspaceDir, gatewayWorkspace!]) {
              await expect(fs.readFile(path.join(workspace, file), "utf8")).resolves.toBe(marker);
            }
            await workerNode.waitForWorkersIdle();
            expect(
              await docker("ps", "--all", "--filter", `id=${containerId}`, "--format", "{{.ID}}"),
            ).toBe("");
            console.info(
              "Docker destination proof: physical container ran; exec verified /.dockerenv; file restored to Gateway; worker container retired",
            );
            const moveToGateway = async () => {
              const source = (await readPlacement()).placement;
              return await operator!.request(
                "sessions.move",
                {
                  key: sessionKey,
                  expected: {
                    generation: source.generation,
                    environmentId: source.environmentId,
                    ownerEpoch: source.activeOwnerEpoch,
                  },
                  target: { kind: "gateway" },
                },
                { timeoutMs: PROOF_TIMEOUT_MS },
              );
            };
            await expect(moveToGateway()).resolves.toMatchObject({ placement: { state: "local" } });
            await expect(
              operator.request("sessions.dispatch", {
                key: sessionKey,
                deviceId: workerNode.identity.deviceId,
              }),
            ).resolves.toMatchObject({ placement: { state: "active" } });
            // Delay only the real destruction acknowledgment; never substitute settlement or policy.
            const originalStop = workerNode.supervisor.stopEnvironment.bind(workerNode.supervisor);
            const stop = vi.spyOn(workerNode.supervisor, "stopEnvironment");
            stop.mockImplementationOnce(async (identity) => {
              await originalStop(identity);
              const snapshot = await operator!.request<{ hash: string }>("config.get", {});
              await operator!.request("config.patch", {
                baseHash: snapshot.hash,
                raw: JSON.stringify({
                  cloudWorkers: {
                    requiredProfile: "docker-proof",
                    preparedPool: { maxTotal: 0 },
                    profiles: {
                      "docker-proof": {
                        provider: "device",
                        readyWorkers: 0,
                        settings: { device: workerNode!.identity.deviceId },
                      },
                    },
                  },
                }),
              });
            });
            try {
              await expect(moveToGateway()).rejects.toThrow("required worker profile policy");
            } finally {
              stop.mockRestore();
            }
            expect((await readPlacement()).placement.state).toBe("reclaimed");
            await expect(fs.readFile(path.join(gatewayWorkspace!, file), "utf8")).resolves.toBe(
              marker,
            );
            console.info(
              "Docker destination proof: allowed Move=local; policy during real destruction acknowledgment=reclaimed; accepted file retained",
            );
            for (const selection of [
              { deviceId: workerNode.identity.deviceId },
              { profileId: "docker-proof", machineClass: "override" },
              { profileId: "docker-proof", os: "linux" },
            ]) {
              await expect(
                operator.request("sessions.dispatch", { key: sessionKey, ...selection }),
              ).rejects.toThrow("requires worker profile");
            }
            await expect(
              operator.request("sessions.patch", {
                key: sessionKey,
                execNode: workerNode.identity.deviceId,
              }),
            ).rejects.toThrow("requires worker profile");
            await expect(
              operator.request("sessions.dispatch", { key: sessionKey, profileId: "docker-proof" }),
            ).resolves.toMatchObject({ placement: { state: "active" } });
            await expect(moveToGateway()).rejects.toThrow("required worker profile policy");
            await expect(
              operator.request(
                "sessions.reclaim",
                { key: sessionKey },
                { timeoutMs: PROOF_TIMEOUT_MS },
              ),
            ).resolves.toMatchObject({ placement: { state: "reclaimed" } });
            await expect(fs.readFile(path.join(gatewayWorkspace!, file), "utf8")).resolves.toBe(
              marker,
            );
            expect(workerNode.invokeErrors).toEqual([]);
            console.info(
              "Docker destination proof: overrides refused; required-profile dispatch=active; Stop=reclaimed; accepted result retained",
            );
          },
          async () => {
            const cleanup = await Promise.allSettled([
              workerNode?.stop(),
              operator?.stopAndWait({ timeoutMs: 2_000 }),
              stopQaGatewayFixture(gatewayOwner),
              provider.stop(),
              closeWireServer(published.server),
            ]);
            const errors = cleanup.flatMap((result) =>
              result.status === "rejected" ? [result.reason] : [],
            );
            if (errors.length) {
              throw new AggregateError(errors, "required destination Docker cleanup failed");
            }
          },
        );
      },
    );
  },
);
