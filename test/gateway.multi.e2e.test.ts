import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, describe, expect, it } from "vitest";
import { GatewayClient } from "../src/gateway/client.js";
import { requireGatewayRecord } from "../src/gateway/test-helpers.assertions.js";
import { buildMockOpenAiResponsesProvider } from "../src/gateway/test-openai-responses-model.js";
import { loadOrCreateDeviceIdentity } from "../src/infra/device-identity.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../src/utils/message-channel.js";
import {
  type GatewayInstance,
  connectNode,
  connectGatewayStatusClient,
  postJson,
  spawnGatewayInstance,
  stopGatewayInstance,
  waitForNodeStatus,
} from "./helpers/gateway-e2e-harness.js";
import { connectProofClient } from "./helpers/gateway-integration-fixtures.js";
import { createOpenClawTestInstance } from "./helpers/openclaw-test-instance.js";
import { waitForFile } from "./helpers/process-wait.js";
import { runQaGatewayFixture } from "./helpers/qa-gateway-cleanup.js";

const E2E_TIMEOUT_MS = 120_000;

const CLOCK_SHIFT_PRELOAD = `
import { existsSync, writeFileSync } from "node:fs";

const shiftPath = process.env.NODE_INVOKE_CLOCK_SHIFT_PATH;
const shiftReadyPath = process.env.NODE_INVOKE_CLOCK_SHIFT_READY_PATH;
const offsetMs = Number(process.env.NODE_INVOKE_CLOCK_SHIFT_MS ?? "0");
const originalNow = Date.now.bind(Date);
const timer = setInterval(() => {
  if (!shiftPath || !existsSync(shiftPath)) {
    return;
  }
  clearInterval(timer);
  Date.now = () => originalNow() + offsetMs;
  if (shiftReadyPath) {
    writeFileSync(shiftReadyPath, "ready\\n");
  }
}, 10);
timer.unref();
`;

async function settleGatewayCleanups(cleanups: Array<() => unknown>) {
  const results = await Promise.allSettled(cleanups.map(async (cleanup) => await cleanup()));
  const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, "Multi-Gateway cleanup failed");
  }
}

async function cleanupGateways(instances: GatewayInstance[], clients: GatewayClient[]) {
  // Failed client cleanup must not release files their Gateway may still use.
  let clientsJoined = false;
  await runQaGatewayFixture(
    async () => {
      await settleGatewayCleanups(clients.map((client) => () => client.stopAndWait()));
      clientsJoined = true;
    },
    () =>
      settleGatewayCleanups(
        instances.map(
          (instance) => () =>
            clientsJoined ? stopGatewayInstance(instance) : instance.stopGateway(),
        ),
      ),
  );
}

describe("gateway multi-instance e2e", () => {
  const instances: GatewayInstance[] = [];
  const nodeClients: GatewayClient[] = [];
  const acquisitions: Promise<unknown>[] = [];

  afterAll(async () => {
    // Join failed acquisitions' siblings before reading their retained owners.
    await Promise.allSettled(acquisitions);
    await cleanupGateways(instances, nodeClients);
  });

  it(
    "spins up two gateways and exercises WS + HTTP + node pairing",
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      const spawnOwnedGateway = async (name: string) => {
        const inst = await spawnGatewayInstance(name);
        instances.push(inst);
        return inst;
      };
      const gatewayAcquisitions = [spawnOwnedGateway("a"), spawnOwnedGateway("b")] as const;
      acquisitions.push(...gatewayAcquisitions);
      const gateways = await Promise.all(gatewayAcquisitions);
      const hookResults = await Promise.all(
        gateways.map((gateway, index) =>
          postJson(
            `http://127.0.0.1:${gateway.port}/hooks/wake`,
            { text: `wake ${index === 0 ? "a" : "b"}`, mode: "now" },
            { "x-openclaw-token": gateway.hookToken },
          ),
        ),
      );
      expect(hookResults).toMatchObject([
        { status: 200, json: { ok: true } },
        { status: 200, json: { ok: true } },
      ]);

      const connectOwnedNode = async (inst: GatewayInstance, label: string) => {
        const node = await connectNode(inst, label);
        nodeClients.push(node.client);
        return node;
      };
      const nodeAcquisitions = gateways.map((gateway, index) =>
        connectOwnedNode(gateway, index === 0 ? "node-a" : "node-b"),
      );
      acquisitions.push(...nodeAcquisitions);
      const nodes = await Promise.all(nodeAcquisitions);
      await Promise.all(
        gateways.map((gateway, index) => waitForNodeStatus(gateway, nodes[index]!.nodeId)),
      );
    },
  );

  it(
    "preserves scheduler runtime across a scheduler-disabled Gateway edit",
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      const model = buildMockOpenAiResponsesProvider("http://127.0.0.1:9/v1", "scheduler-canary");
      const manager = await createOpenClawTestInstance({
        name: "cron-passive-manager",
        config: {
          cron: { enabled: false },
          plugins: { enabled: false },
          agents: {
            defaults: {
              model: { primary: model.modelRef },
              models: { [model.modelRef]: { agentRuntime: { id: "openclaw" } } },
            },
          },
          models: {
            mode: "replace",
            providers: {
              [model.providerId]: { ...model.config, request: { allowPrivateNetwork: true } },
            },
          },
        },
        env: { OPENCLAW_SKIP_CRON: "0" },
      });
      let managerClient: GatewayClient | undefined;
      await runQaGatewayFixture(
        async () => {
          // Creation captures a durable account; only the injected offline runner executes it.
          await manager.state.writeAuthProfiles({
            version: 1,
            profiles: {
              "openai:cron-passive-manager": {
                type: "api_key",
                provider: "openai",
                key: "synthetic-cron-scheduler-key",
              },
            },
          });
          await manager.startGateway();
          managerClient = await connectGatewayStatusClient(manager);
          const canary = await managerClient.request<{ id: string }>("cron.add", {
            name: "shared-store canary",
            enabled: true,
            schedule: { kind: "every", everyMs: 3_600_000 },
            sessionTarget: "isolated",
            wakeMode: "now",
            payload: {
              kind: "agentTurn",
              model: "openai/gpt-4.1@openai:cron-passive-manager",
              message: "run canary",
              toolsAllow: [],
            },
            delivery: { mode: "none" },
          });
          const target = await managerClient.request<{ id: string }>("cron.add", {
            name: "shared-store edit target",
            enabled: true,
            schedule: { kind: "cron", expr: "0 6 * * *" },
            sessionTarget: "main",
            wakeMode: "now",
            payload: { kind: "systemEvent", text: "edit target" },
          });

          await managerClient.request("cron.list", { includeDisabled: true });

          // Exclusive cron custody requires stopping the Gateway before the offline scheduler.
          await managerClient.stopAndWait();
          managerClient = undefined;
          await manager.stopGateway();
          const scheduler = spawnSync(
            process.execPath,
            [
              "--import",
              path.join(process.cwd(), "scripts/tsx.mjs"),
              "--input-type=module",
              "--eval",
              `
import { CronService } from "./src/cron/service.ts";
import { resolveCronJobsStorePath } from "./src/cron/store.ts";
import { toPublicCronJob } from "./src/cron/public-job.ts";
import { createTestGatewayScheduler } from "./src/test-utils/gateway-scheduler-clock.ts";
const cron = new CronService({
  scheduler: createTestGatewayScheduler(),
  nowMs: () => Date.now(),
  cronEnabled: true,
  storePath: resolveCronJobsStorePath(),
  log: { debug() {}, info() {}, warn() {}, error() {} },
  enqueueSystemEvent() {},
  requestHeartbeat() {},
  async runIsolatedAgentJob() { return { status: "ok", summary: "scheduler canary completed" }; },
});
try {
  await cron.start();
  const result = await cron.run(process.argv[1], "force");
  if (!result.ok || !("ran" in result) || !result.ran) throw new Error(JSON.stringify(result));
  console.log(JSON.stringify(toPublicCronJob(cron.getJob(process.argv[1]))));
} finally {
  cron.stop();
}
`,
              canary.id,
            ],
            { cwd: process.cwd(), env: manager.env, encoding: "utf8", timeout: E2E_TIMEOUT_MS },
          );
          expect(scheduler.stderr).toBe("");
          expect(
            scheduler.status,
            scheduler.error?.message ?? scheduler.signal ?? scheduler.stderr,
          ).toBe(0);
          const before = JSON.parse(scheduler.stdout) as {
            state: { lastRunAtMs?: number; lastStatus?: string };
          };
          expect(before.state).toMatchObject({ lastRunAtMs: expect.any(Number), lastStatus: "ok" });

          await manager.startGateway();
          managerClient = await connectGatewayStatusClient(manager);
          await managerClient.request("cron.update", {
            id: target.id,
            patch: { description: "updated through passive Gateway" },
          });
          const after = await managerClient.request<{ state: unknown }>("cron.get", {
            id: canary.id,
          });
          expect(after.state).toEqual(before.state);
        },
        () => cleanupGateways([manager], managerClient ? [managerClient] : []),
      );
    },
  );
  it(
    "keeps a real node.invoke timeout stable across a gateway wall-clock change",
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      const proofRoot = await mkdtemp(path.join(os.tmpdir(), "openclaw-node-invoke-proof-"));
      const shiftPath = path.join(proofRoot, "shift");
      const shiftReadyPath = path.join(proofRoot, "shift-ready");
      const preloadPath = path.join(proofRoot, "clock-shift.mjs");
      let node: GatewayClient | undefined;
      let operator: GatewayClient | undefined;
      let instance: GatewayInstance | undefined;
      let responseWork = Promise.resolve();
      await runQaGatewayFixture(
        async () => {
          await writeFile(preloadPath, CLOCK_SHIFT_PRELOAD, "utf8");
          instance = await createOpenClawTestInstance({
            name: "node-invoke-clock",
            gatewayCommandPrefix: [process.execPath, "--import", pathToFileURL(preloadPath).href],
            env: {
              NODE_INVOKE_CLOCK_SHIFT_PATH: shiftPath,
              NODE_INVOKE_CLOCK_SHIFT_READY_PATH: shiftReadyPath,
              NODE_INVOKE_CLOCK_SHIFT_MS: "1000",
            },
          });
          await instance.startGateway();
          const nodeIdentity = loadOrCreateDeviceIdentity({
            path: path.join(
              instance.homeDir,
              "proof-clients",
              "node",
              "client",
              "credentials.sqlite",
            ),
          });
          const nodeId = nodeIdentity.deviceId;
          node = await connectProofClient(instance, {
            clientName: GATEWAY_CLIENT_NAMES.NODE_HOST,
            clientDisplayName: "real-node-proof",
            clientVersion: "1.0.0",
            platform: "ios",
            mode: GATEWAY_CLIENT_MODES.NODE,
            role: "node",
            scopes: [],
            caps: ["system"],
            commands: ["system.notify"],
            deviceIdentity: nodeIdentity,
            onEvent: (event) => {
              if (event.event !== "node.invoke.request") {
                return;
              }
              const payload = requireGatewayRecord(event.payload, "node invoke request");
              expect(payload).toMatchObject({ id: expect.any(String), nodeId });
              responseWork = responseWork.then(async () => {
                await writeFile(shiftPath, "shift\n");
                await waitForFile(shiftReadyPath, AbortSignal.timeout(5_000));
                await new Promise<void>((resolve) => {
                  setTimeout(resolve, 50);
                });
                await expectDefined(node, "connected proof node").request("node.invoke.result", {
                  id: payload.id,
                  nodeId: payload.nodeId,
                  ok: true,
                  payloadJSON: JSON.stringify({ captured: true }),
                });
              });
              void responseWork.catch(() => {});
            },
          });
          operator = await connectProofClient(instance, {
            clientName: GATEWAY_CLIENT_NAMES.CLI,
            mode: GATEWAY_CLIENT_MODES.CLI,
            role: "operator",
            scopes: ["operator.admin", "operator.read", "operator.write", "operator.pairing"],
            deviceIdentity: loadOrCreateDeviceIdentity({
              path: path.join(
                instance.homeDir,
                "proof-clients",
                "operator",
                "client",
                "credentials.sqlite",
              ),
            }),
          });
          const pairing = await operator.request<{
            pending: Array<{ nodeId: string }>;
            paired: Array<{ nodeId: string; commands?: string[] }>;
          }>("node.pair.list", {});
          expect(pairing.pending.find((entry) => entry.nodeId === nodeId)).toBeUndefined();
          expect(pairing.paired.find((entry) => entry.nodeId === nodeId)?.commands).toEqual([
            "system.notify",
          ]);
          await waitForNodeStatus(instance, nodeId);
          const startedAt = performance.now();
          const result = await operator.request(
            "node.invoke",
            {
              nodeId,
              command: "system.notify",
              params: { quality: "low" },
              timeoutMs: 500,
              idempotencyKey: "real-node-invoke-clock-proof",
            },
            { timeoutMs: 5_000 },
          );
          const elapsedMs = Math.round(performance.now() - startedAt);
          expect(result).toMatchObject({ payload: { captured: true } });
          expect(elapsedMs).toBeGreaterThanOrEqual(50);
          expect(elapsedMs).toBeLessThan(500);
          await responseWork;
        },
        () => responseWork,
        async () => {
          await cleanupGateways(
            instance ? [instance] : [],
            [operator, node].filter((client): client is GatewayClient => client !== undefined),
          );
          await rm(proofRoot, { recursive: true, force: true });
        },
      );
    },
  );
});
