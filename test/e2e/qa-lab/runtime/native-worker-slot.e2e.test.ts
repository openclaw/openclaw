import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createQaGatewayChild } from "../../../../extensions/qa-lab/api.js";
import type { AgentJobTerminalSnapshot } from "../../../../src/gateway/agent-turn/types.js";
import { loadOrCreateDeviceIdentity } from "../../../../src/infra/device-identity.js";
import {
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../../../src/infra/kysely-sync.js";
import { NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND } from "../../../../src/infra/node-commands.js";
import { withOpenClawStateDatabaseReadOnly } from "../../../../src/state/openclaw-state-db-readonly.js";
import type { DB as StateDatabase } from "../../../../src/state/openclaw-state-db.generated.js";
import type { NativeRuntimeConfig } from "../../../../src/worker/native-runtime-config.js";
import {
  nodeWorkerPlanHash,
  parseNodeWorkerLaunchInput,
} from "../../../../src/worker/node-supervisor-protocol.js";
import { createDeferred, withinTest } from "../../../helpers/promise.js";
import { runQaGatewayFixture, stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";
import { MODEL_REF, PROOF_TIMEOUT_MS } from "./cloud-worker-midturn-loss-fixture.js";
import {
  closeWireServer,
  connectWireClient,
  createPairedNodeWorkerHost,
  createPublishedWireWorkspace,
  startPairedNodeWorkerGateway,
  wireMessageText,
  type PairedNodeWorkerHost,
  type WireGateway,
} from "./paired-node-worker-wire-fixture.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const [providerId, modelId] = MODEL_REF.split("/");

async function providerFixture() {
  const entered = { A: createDeferred(), B: createDeferred() };
  const releases = { A: createDeferred(), B: createDeferred() };
  const requests: string[] = [];
  const errors: unknown[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk));
      }
      const body = Buffer.concat(chunks).toString();
      const marker = [...body.matchAll(/NATIVE-SLOT-([AB])/gu)].at(-1)?.[1];
      if (request.url !== "/v1/chat/completions" || (marker !== "A" && marker !== "B")) {
        response.writeHead(400).end("unexpected native request");
        return;
      }
      requests.push(marker);
      entered[marker].resolve();
      await releases[marker].promise;
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const [delta, finish_reason] of [
        [{ role: "assistant", content: "NATIVE-SLOT-" + marker }, null],
        [{}, "stop"],
      ]) {
        response.write(
          "data: " +
            JSON.stringify({
              id: "native-slot-" + marker,
              object: "chat.completion.chunk",
              created: 1,
              model: modelId,
              choices: [{ index: 0, delta, finish_reason }],
            }) +
            "\n\n",
        );
      }
      response.end("data: [DONE]\n\n");
    })().catch((error: unknown) => {
      errors.push(error);
      response.destroy();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("missing provider address");
  }
  return {
    server,
    entered,
    releases,
    requests,
    errors,
    baseUrl: "http://127.0.0.1:" + address.port + "/v1",
  };
}

function readPlacement(gateway: WireGateway, key: string) {
  return withOpenClawStateDatabaseReadOnly(
    ({ db }) => {
      const query = getNodeSqliteKysely<StateDatabase>(db);
      const placement = executeSqliteQueryTakeFirstSync(
        db,
        query
          .selectFrom("worker_session_placements")
          .select(["session_id", "state", "turn_claim_id", "workspace_base_manifest_ref"])
          .where("session_key", "=", key),
      );
      const pending =
        placement &&
        executeSqliteQueryTakeFirstSync(
          db,
          query
            .selectFrom("worker_workspace_pending_results")
            .select("session_id")
            .where("session_id", "=", placement.session_id),
        );
      return { placement, pending };
    },
    { env: gateway.runtimeEnv },
  );
}

// Release-tier composition: public create/dispatch/chat/delete -> production launcher ->
// installed worker + native HTTP -> real workspace settlement -> the SAME physical slot.
it.skipIf(process.platform === "win32")(
  "settles native A, deletes it, then runs B on the same one-slot node",
  async ({ signal }) => {
    const root = tempDirs.make("native-slot-lifecycle-");
    const provider = await providerFixture();
    const published = await createPublishedWireWorkspace(root);
    const gatewayOwner = createQaGatewayChild();
    const identity = loadOrCreateDeviceIdentity({ path: path.join(root, "node-identity.sqlite") });
    const nativeInferenceConfig = path.join(root, "native.json");
    const nodeHostRoot = path.join(root, "node-state", "node-host");
    await mkdir(nodeHostRoot, { recursive: true });
    const config: NativeRuntimeConfig = {
      models: [
        {
          provider: providerId!,
          id: modelId!,
          api: "openai-completions",
          baseUrl: provider.baseUrl,
          contextWindow: 32768,
          maxTokens: 128,
          reasoning: true,
          thinkingLevelMap: { medium: "medium" },
          apiKeyEnv: "NATIVE_SLOT_KEY",
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ],
      workspaces: [{ id: "qa", path: nodeHostRoot, scope: "subdirectories", models: [MODEL_REF] }],
    };
    await writeFile(nativeInferenceConfig, JSON.stringify(config), { mode: 0o600 });
    let node: PairedNodeWorkerHost | undefined;
    let operator: Awaited<ReturnType<typeof connectWireClient>> | undefined;
    await runQaGatewayFixture(
      async () => {
        const gateway = await startPairedNodeWorkerGateway({
          owner: gatewayOwner,
          // A Gateway model request must fail rather than accidentally supply this proof's reply.
          providerBaseUrl: "http://127.0.0.1:1",
          nativeWorkerDeviceId: identity.deviceId,
          // Keep Gateway worktrees on the same owned filesystem as the node;
          // its real free-space admission guard still decides whether setup fits.
          command: {
            executablePath: process.execPath,
            argsPrefix: [path.resolve("dist/index.js")],
            tempParentDir: root,
          },
        });
        operator = await connectWireClient({ gateway, role: "operator", identity: null });
        node = await createPairedNodeWorkerHost({
          gateway,
          operator,
          root,
          capacity: 1,
          capacityWaitMs: 0,
          nativeInferenceConfig,
          workerEnv: { NATIVE_SLOT_KEY: "synthetic-native-slot-key" },
        });
        expect(node.identity.deviceId).toBe(identity.deviceId);
        const keys = {
          A: "agent:qa:native-slot-a",
          Busy: "agent:qa:native-slot-busy",
          B: "agent:qa:native-slot-b",
        };
        const createAndDispatch = async (suffix: keyof typeof keys) => {
          await operator!.request("sessions.create", {
            key: keys[suffix],
            agentId: "qa",
            worktree: true,
            worktreeName: "native-slot-" + suffix.toLowerCase(),
            worktreeBaseRef: "main",
            cwd: published.source,
          });
          const dispatched = await operator!.request<{ placement: { state: string } }>(
            "sessions.dispatch",
            { key: keys[suffix], profileId: "native" },
            { timeoutMs: PROOF_TIMEOUT_MS },
          );
          expect(dispatched.placement.state).toBe("active");
        };
        await createAndDispatch("A");
        await createAndDispatch("Busy");
        const start = async (key: string, marker: string, runId: string) => {
          const result = await operator!.request("chat.send", {
            sessionKey: key,
            message: "Reply exactly: " + marker,
            deliver: false,
            idempotencyKey: runId,
          });
          expect(result).toMatchObject({ runId, status: "started" });
        };
        const wait = (runId: string) =>
          operator!.request<AgentJobTerminalSnapshot>(
            "agent.wait",
            { runId, timeoutMs: PROOF_TIMEOUT_MS },
            { timeoutMs: PROOF_TIMEOUT_MS + 5000 },
          );
        await start(keys.A, "NATIVE-SLOT-A", "native-slot-a");
        await withinTest(provider.entered.A.promise, signal);
        expect(readPlacement(gateway, keys.A).placement?.turn_claim_id).toBeTruthy();
        expect(await node.supervisor.hasActiveWork()).toBe(true);
        await start(keys.Busy, "NATIVE-SLOT-B", "native-slot-b-at-capacity");
        const full = await wait("native-slot-b-at-capacity");
        expect(full.status).toBe("error");
        expect(full.error).toMatch(/capacity/iu);
        expect(provider.requests).toEqual(["A"]);
        expect(readPlacement(gateway, keys.A).placement?.turn_claim_id).toBeTruthy();
        provider.releases.A.resolve();
        expect(await wait("native-slot-a")).toMatchObject({ status: "ok" });
        const settled = readPlacement(gateway, keys.A);
        expect(settled.placement).toMatchObject({
          state: "active",
          turn_claim_id: null,
          workspace_base_manifest_ref: expect.stringMatching(/^sha256:/u),
        });
        expect(settled.pending).toBeUndefined();
        await node.waitForWorkersIdle();
        expect(await node.supervisor.hasActiveWork()).toBe(false);
        const history = await operator.request<{ messages: unknown[] }>("chat.history", {
          sessionKey: keys.A,
        });
        expect(
          history.messages.some((message) => wireMessageText(message) === "NATIVE-SLOT-A"),
        ).toBe(true);
        await operator.request("sessions.delete", { key: keys.A });
        expect(readPlacement(gateway, keys.A).placement).toBeUndefined();
        await node.disconnect();
        await node.connect();
        await createAndDispatch("B");
        await start(keys.B, "NATIVE-SLOT-B", "native-slot-b");
        await withinTest(provider.entered.B.promise, signal);
        const launches = node.frames
          .filter((frame) => frame.command === NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND)
          .map((frame) => parseNodeWorkerLaunchInput(frame.paramsJSON));
        const activeB = launches.findLast(
          (launch) => launch.descriptor.assignment.runId === "native-slot-b",
        )!;
        expect(activeB.descriptor.assignment.inference).toBe("runtime-local");
        expect(
          await node.supervisor.cancel({
            launchId: activeB.launchId,
            planHash: nodeWorkerPlanHash(activeB),
            environmentId: activeB.descriptor.admission.environmentId,
            sessionId: activeB.descriptor.admission.sessionId,
            ownerEpoch: activeB.descriptor.admission.ownerEpoch - 1,
            placementGeneration: activeB.placementGeneration,
            runId: activeB.descriptor.assignment.runId,
          }),
        ).toBeUndefined();
        expect(await node.supervisor.status(activeB.launchId)).toMatchObject({ state: "running" });
        provider.releases.B.resolve();
        expect(await wait("native-slot-b")).toMatchObject({ status: "ok" });
        expect(readPlacement(gateway, keys.B)).toMatchObject({
          placement: { state: "active", turn_claim_id: null },
          pending: undefined,
        });
        await node.waitForWorkersIdle();
        expect(await node.supervisor.hasActiveWork()).toBe(false);
        expect(provider.requests).toEqual(["A", "B"]);
        expect(provider.errors).toEqual([]);
        expect(node.invokeErrors).toEqual([]);
        console.info(
          "native-one-slot-proof",
          JSON.stringify({
            nativeRequests: provider.requests,
            liveWorkRejected: true,
            settledClaim: settled.placement?.turn_claim_id,
            pendingResult: settled.pending ?? null,
            deletedA: true,
            sameNode: node.identity.deviceId === identity.deviceId,
            reconnected: true,
            staleEpochRejected: true,
            physicalSlotReleased: true,
          }),
        );
      },
      async () => {
        provider.releases.A.resolve();
        provider.releases.B.resolve();
        await node?.stop();
      },
      async () => {
        await operator?.stopAndWait({ timeoutMs: 2000 });
      },
      () => stopQaGatewayFixture(gatewayOwner),
      () => closeWireServer(provider.server),
      () => closeWireServer(published.server),
    );
  },
  PROOF_TIMEOUT_MS + 180_000,
);
