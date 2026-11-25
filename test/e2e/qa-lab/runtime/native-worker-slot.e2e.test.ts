import path from "node:path";
import { expect, it, vi } from "vitest";
import { createQaGatewayChild } from "../../../../extensions/qa-lab/api.js";
import type { OpenClawConfig } from "../../../../src/config/types.openclaw.js";
import type { AgentJobTerminalSnapshot } from "../../../../src/gateway/agent-turn/types.js";
import { loadOrCreateDeviceIdentity } from "../../../../src/infra/device-identity.js";
import {
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../../../src/infra/kysely-sync.js";
import { NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND } from "../../../../src/infra/node-commands.js";
import { withOpenClawStateDatabaseReadOnly } from "../../../../src/state/openclaw-state-db-readonly.js";
import type { DB as StateDatabase } from "../../../../src/state/openclaw-state-db.generated.js";
import {
  nodeWorkerPlanHash,
  parseNodeWorkerLaunchInput,
} from "../../../../src/worker/node-supervisor-protocol.js";
import { createDeferred, withinTest } from "../../../helpers/promise.js";
import { stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import { runQaGatewayTestFixture } from "../../../helpers/qa-gateway-test-lifetime.js";
import { MODEL_REF, PROOF_TIMEOUT_MS } from "./cloud-worker-midturn-loss-fixture.js";
import {
  createNativeProvider,
  listenNativeProvider,
  nativeModel,
  writeNativeCompletion,
} from "./native-provider-proof-fixture.js";
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

const [providerId, modelId] = MODEL_REF.split("/");

async function providerFixture() {
  const entered = { A: createDeferred(), B: createDeferred() };
  const releases = { A: createDeferred(), B: createDeferred() };
  const requests: string[] = [];
  const errors: unknown[] = [];
  const server = createNativeProvider(
    async (request, response, body) => {
      const marker = [...body.matchAll(/NATIVE-SLOT-([AB])/gu)].at(-1)?.[1];
      if (request.url !== "/v1/chat/completions" || (marker !== "A" && marker !== "B")) {
        response.writeHead(400).end("unexpected native request");
        return;
      }
      requests.push(marker);
      entered[marker].resolve();
      await releases[marker].promise;
      writeNativeCompletion(response, "native-slot-" + marker, modelId!, "NATIVE-SLOT-" + marker);
    },
    (error, response) => {
      errors.push(error);
      response.destroy();
    },
  );
  return {
    server,
    entered,
    releases,
    requests,
    errors,
    baseUrl: await listenNativeProvider(server),
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
  async (context) => {
    const gatewayOwner = createQaGatewayChild();
    let providerResource: Awaited<ReturnType<typeof providerFixture>> | undefined;
    let publishedResource: Awaited<ReturnType<typeof createPublishedWireWorkspace>> | undefined;
    let node: PairedNodeWorkerHost | undefined;
    let operator: Awaited<ReturnType<typeof connectWireClient>> | undefined;
    await runQaGatewayTestFixture(
      context,
      async ({ signal, createTempDir }) => {
        const root = createTempDir("native-slot-lifecycle-");
        const provider = (providerResource = await providerFixture());
        const published = (publishedResource = await createPublishedWireWorkspace(root));
        const identity = loadOrCreateDeviceIdentity({
          env: { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "node-state") },
        });
        const config: OpenClawConfig = {
          models: {
            providers: {
              [providerId!]: {
                apiKey: "synthetic-native-slot-key",
                api: "openai-completions",
                baseUrl: provider.baseUrl,
                models: [
                  nativeModel(modelId!, {
                    maxTokens: 128,
                    reasoning: true,
                    thinkingLevelMap: { medium: "medium" },
                  }),
                ],
              },
            },
          },
        };
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
        operator = await connectWireClient({
          gateway,
          role: "operator",
          identity: null,
        });
        await operator.request("sessions.subscribe", {});
        node = await createPairedNodeWorkerHost({
          gateway,
          operator,
          root,
          capacity: 1,
          nodeConfig: config,
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
        // Terminal replies precede durable workspace settlement, including refused launches.
        const expectSettled = (
          suffix: keyof typeof keys,
          placement: Record<string, unknown> = {},
        ) =>
          vi.waitFor(
            () =>
              expect(readPlacement(gateway, keys[suffix])).toMatchObject({
                placement: { state: "active", turn_claim_id: null, ...placement },
                pending: undefined,
              }),
            { timeout: PROOF_TIMEOUT_MS, interval: 100 },
          );
        const finish = async (suffix: "A" | "B", placement: Record<string, unknown> = {}) => {
          provider.releases[suffix].resolve();
          expect(await wait("native-slot-" + suffix.toLowerCase())).toMatchObject({ status: "ok" });
          await expectSettled(suffix, placement);
          await node!.waitForWorkersIdle();
          expect(await node!.supervisor.hasActiveWork()).toBe(false);
        };
        await start(keys.A, "NATIVE-SLOT-A", "native-slot-a");
        await withinTest(provider.entered.A.promise, signal);
        expect(readPlacement(gateway, keys.A).placement?.turn_claim_id).toBeTruthy();
        expect(await node.supervisor.hasActiveWork()).toBe(true);
        await start(keys.Busy, "NATIVE-SLOT-B", "native-slot-b-at-capacity");
        expect(await wait("native-slot-b-at-capacity")).toMatchObject({ status: "error" });
        // agent.wait intentionally scrubs the internal refusal. The live claim and lack of a
        // second provider request prove that the occupied physical slot rejected this turn.
        await expectSettled("Busy");
        expect(provider.requests).toEqual(["A"]);
        expect(readPlacement(gateway, keys.A).placement?.turn_claim_id).toBeTruthy();
        await finish("A", { workspace_base_manifest_ref: expect.stringMatching(/^sha256:/u) });
        const history = await operator.request<{ messages: unknown[] }>("chat.history", {
          sessionKey: keys.A,
        });
        expect(history.messages.map(wireMessageText)).toContain("NATIVE-SLOT-A");
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
        await finish("B");
        expect(provider.requests).toEqual(["A", "B"]);
        expect(provider.errors).toEqual([]);
        expect(node.invokeErrors).toEqual([]);
      },
      async () => {
        providerResource?.releases.A.resolve();
        providerResource?.releases.B.resolve();
        await node?.stop();
      },
      async () => {
        await operator?.stopAndWait({ timeoutMs: 2000 });
      },
      () => stopQaGatewayFixture(gatewayOwner),
      () => (providerResource ? closeWireServer(providerResource.server) : undefined),
      () => (publishedResource ? closeWireServer(publishedResource.server) : undefined),
    );
  },
  PROOF_TIMEOUT_MS + 180_000,
);
