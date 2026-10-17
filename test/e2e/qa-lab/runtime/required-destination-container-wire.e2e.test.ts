import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
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
type Session = { placement: Placement; execCwd?: string; spawnedCwd?: string };

it.runIf(process.env.OPENCLAW_DOCKER_NODE_WORKER_E2E === "1")(
  "required destination real Docker wire retains accepted results when policy revokes Gateway Move during teardown",
  { timeout: PROOF_TIMEOUT_MS + 120_000 },
  async () => {
    const root = tempDirs.make("openclaw-required-destination-docker-");
    const provider = await startQaMockOpenAiServer({ modelRefs: [MODEL_REF] });
    const published = await createPublishedWireWorkspace(root);
    const gatewayOwner = createQaGatewayChild();
    let workerNode: PairedNodeWorkerHost | undefined;
    let operator: Awaited<ReturnType<typeof connectWireClient>> | undefined;
    let observedContainer: Promise<string> | undefined;
    const image = process.env.OPENCLAW_DOCKER_NODE_WORKER_IMAGE ?? "node:24-bookworm";
    const docker = async (...args: string[]) =>
      (await execFileAsync("docker", args, { encoding: "utf8", timeout: 15_000 })).stdout.trim();
    const containerIds = (...filters: string[]) =>
      docker("ps", "--no-trunc", ...filters, "--format", "{{.ID}}");
    await runQaGatewayFixture(
      async () => {
        const gateway = await startPairedNodeWorkerGateway({
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
        const request = operator.request.bind(operator);
        const session = <T>(method: string, params = {}) =>
          request<T>(`sessions.${method}`, { key: sessionKey, ...params });
        const expectPlacement = (result: Promise<unknown>, state: string) =>
          expect(result).resolves.toMatchObject({ placement: { state } });
        const approval = await request<{ hash: string }>("exec.approvals.get", {});
        await request("exec.approvals.set", {
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
                  id = await containerIds(
                    "--filter",
                    `label=openclaw.node-worker.launch=${Buffer.from(launchId).toString("base64url")}`,
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
        await session("create", {
          agentId: "qa",
          worktree: true,
          worktreeName: "required-destination-docker",
          worktreeBaseRef: "main",
          cwd: published.source,
          permissionMode: "full",
        });
        const deviceId = workerNode.identity.deviceId;
        await expectPlacement(session("dispatch", { deviceId }), "active");
        const runId = `docker-destination-${Date.now()}`;
        await expect(
          request("chat.send", {
            sessionKey,
            message: `Tool progress QA check: call the exec tool exactly once with this exact command before answering: \`test -f /.dockerenv && printf ${marker} > ${file}\`. After that exec command completes or fails, reply exactly \`${marker}\`.`,
            deliver: false,
            idempotencyKey: runId,
          }),
        ).resolves.toMatchObject({ runId, status: "started" });
        await expect(
          request(
            "agent.wait",
            { runId, timeoutMs: PROOF_TIMEOUT_MS },
            { timeoutMs: PROOF_TIMEOUT_MS + 5_000 },
          ),
        ).resolves.toMatchObject({ status: "ok" });
        expect(observedContainer).toBeTruthy();
        const containerId = await observedContainer!;
        const readPlacement = () =>
          session<{ session: Session }>("describe").then((result) => result.session);
        const finished = await readPlacement();
        const gatewayWorkspace = finished.execCwd ?? finished.spawnedCwd;
        const expectFile = (workspace = gatewayWorkspace!) =>
          expect(fs.readFile(path.join(workspace, file), "utf8")).resolves.toBe(marker);
        for (const workspace of [finished.placement.remoteWorkspaceDir, gatewayWorkspace!]) {
          await expectFile(workspace);
        }
        await workerNode.waitForWorkersIdle();
        expect(await containerIds("--all", "--filter", `id=${containerId}`)).toBe("");
        const moveToGateway = () =>
          readPlacement().then(({ placement }) => {
            const { generation, environmentId, activeOwnerEpoch: ownerEpoch } = placement;
            return session("move", {
              expected: { generation, environmentId, ownerEpoch },
              target: { kind: "gateway" },
            });
          });
        await expectPlacement(moveToGateway(), "local");
        await expectPlacement(session("dispatch", { deviceId }), "active");
        const originalStop = workerNode.supervisor.stopEnvironment.bind(workerNode.supervisor);
        const stop = vi.spyOn(workerNode.supervisor, "stopEnvironment");
        stop.mockImplementationOnce(async (identity) => {
          await originalStop(identity);
          const snapshot = await request<{ hash: string }>("config.get", {});
          const profile = { provider: "device", readyWorkers: 0, settings: { device: deviceId } };
          await request("config.patch", {
            baseHash: snapshot.hash,
            raw: JSON.stringify({
              cloudWorkers: {
                requiredProfile: "docker-proof",
                preparedPool: { maxTotal: 0 },
                profiles: { "docker-proof": profile },
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
        await expectFile();
        for (const [method, selection] of [
          ["dispatch", { deviceId }],
          ["dispatch", { profileId: "docker-proof", machineClass: "override" }],
          ["dispatch", { profileId: "docker-proof", os: "linux" }],
          ["patch", { execNode: deviceId }],
        ] as const) {
          await expect(session(method, selection)).rejects.toThrow("requires worker profile");
        }
        await expectPlacement(session("dispatch", { profileId: "docker-proof" }), "active");
        await expect(moveToGateway()).rejects.toThrow("required worker profile policy");
        await expectPlacement(session("reclaim"), "reclaimed");
        await expectFile();
        expect(workerNode.invokeErrors).toEqual([]);
      },
      () => workerNode?.stop(),
      () => operator?.stopAndWait({ timeoutMs: 2_000 }),
      () => stopQaGatewayFixture(gatewayOwner),
      () => provider.stop(),
      () => closeWireServer(published.server),
    );
  },
);
