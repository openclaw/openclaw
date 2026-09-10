// Gateway multi E2E tests validate multi-gateway runtime behavior.
import { spawnSync } from "node:child_process";
import { watch } from "node:fs";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, describe, expect, it, vi } from "vitest";
import { GatewayClient } from "../src/gateway/client.js";
import { requireGatewayRecord } from "../src/gateway/test-helpers.assertions.js";
import { connectGatewayClient } from "../src/gateway/test-helpers.e2e.js";
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
import { createOpenClawTestInstance } from "./helpers/openclaw-test-instance.js";
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
  process.stdout.write("[clock-shift] offsetMs=" + offsetMs + String.fromCharCode(10));
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
  // A failed client join must not strand Gateway processes or release files
  // their owners may still use. Keep terminal cleanup with the instance owner.
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
    // Promise.all can reject while its siblings still acquire owners. Join the
    // original acquisitions before reading either retained cleanup collection.
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
      const [gwA, gwB] = await Promise.all(gatewayAcquisitions);

      const [hookResA, hookResB] = await Promise.all([
        postJson(
          `http://127.0.0.1:${gwA.port}/hooks/wake`,
          {
            text: "wake a",
            mode: "now",
          },
          { "x-openclaw-token": gwA.hookToken },
        ),
        postJson(
          `http://127.0.0.1:${gwB.port}/hooks/wake`,
          {
            text: "wake b",
            mode: "now",
          },
          { "x-openclaw-token": gwB.hookToken },
        ),
      ]);
      expect(hookResA.status).toBe(200);
      expect((hookResA.json as { ok?: boolean } | undefined)?.ok).toBe(true);
      expect(hookResB.status).toBe(200);
      expect((hookResB.json as { ok?: boolean } | undefined)?.ok).toBe(true);

      const connectOwnedNode = async (inst: GatewayInstance, label: string) => {
        const node = await connectNode(inst, label);
        nodeClients.push(node.client);
        return node;
      };
      const nodeAcquisitions = [
        connectOwnedNode(gwA, "node-a"),
        connectOwnedNode(gwB, "node-b"),
      ] as const;
      acquisitions.push(...nodeAcquisitions);
      const [nodeA, nodeB] = await Promise.all(nodeAcquisitions);

      await Promise.all([
        waitForNodeStatus(gwA, nodeA.nodeId),
        waitForNodeStatus(gwB, nodeB.nodeId),
      ]);
    },
  );

  it(
    "preserves scheduler runtime across a scheduler-disabled Gateway edit",
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      const manager = await createOpenClawTestInstance({
        name: "cron-passive-manager",
        config: { cron: { enabled: false }, plugins: { enabled: false } },
        env: { OPENCLAW_SKIP_CRON: "0" },
      });
      let managerClient: GatewayClient | undefined;
      await runQaGatewayFixture(
        async () => {
          await manager.startGateway();
          managerClient = await connectGatewayStatusClient(manager);
          const canary = await managerClient.request<{ id: string }>("cron.add", {
            name: "shared-store canary",
            enabled: true,
            schedule: { kind: "every", everyMs: 3_600_000 },
            sessionTarget: "isolated",
            wakeMode: "now",
            payload: { kind: "agentTurn", message: "run canary", toolsAllow: [] },
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

          // A separate scheduler process advances the row while the passive Gateway
          // retains its snapshot. Two Gateways must not share a state directory.
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
const cron = new CronService({
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
            { cwd: process.cwd(), env: manager.env, encoding: "utf8", timeout: 60_000 },
          );
          expect(scheduler.stderr).toBe("");
          expect(scheduler.status).toBe(0);
          const before = JSON.parse(scheduler.stdout) as {
            state: { lastRunAtMs?: number; lastStatus?: string };
          };
          expect(before.state.lastRunAtMs).toEqual(expect.any(Number));
          expect(before.state.lastStatus).toBe("ok");

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
            env: {
              NODE_OPTIONS: `--import=${pathToFileURL(preloadPath).href}`,
              NODE_INVOKE_CLOCK_SHIFT_PATH: shiftPath,
              NODE_INVOKE_CLOCK_SHIFT_READY_PATH: shiftReadyPath,
              NODE_INVOKE_CLOCK_SHIFT_MS: "1000",
            },
          });
          await instance.startGateway();
          const nodeIdentity = loadOrCreateDeviceIdentity({
            path: path.join(instance.homeDir, "proof-node-device.sqlite"),
          });
          node = await connectGatewayClient({
            url: instance.url,
            token: instance.gatewayToken,
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
              expect(payload.id).toEqual(expect.any(String));
              expect(payload.nodeId).toBe(nodeIdentity.deviceId);
              responseWork = responseWork.then(async () => {
                await writeFile(shiftPath, "shift\n");
                await waitForFile(shiftReadyPath);
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
          operator = await connectGatewayClient({
            url: instance.url,
            token: instance.gatewayToken,
            clientName: GATEWAY_CLIENT_NAMES.CLI,
            mode: GATEWAY_CLIENT_MODES.CLI,
            role: "operator",
            scopes: ["operator.admin", "operator.read", "operator.write", "operator.pairing"],
            deviceIdentity: loadOrCreateDeviceIdentity({
              path: path.join(instance.homeDir, "proof-operator-device.sqlite"),
            }),
          });
          await approveNodePairingForProof(operator, nodeIdentity.deviceId);
          await waitForNodeStatus(instance, nodeIdentity.deviceId);
          const startedAt = performance.now();
          const result = await operator.request<{ payload?: { captured?: boolean } }>(
            "node.invoke",
            {
              nodeId: nodeIdentity.deviceId,
              command: "system.notify",
              params: { quality: "low" },
              timeoutMs: 500,
              idempotencyKey: "real-node-invoke-clock-proof",
            },
            { timeoutMs: 5_000 },
          );
          const elapsedMs = Math.round(performance.now() - startedAt);
          expect(result.payload?.captured).toBe(true);
          expect(elapsedMs).toBeGreaterThanOrEqual(50);
          expect(elapsedMs).toBeLessThan(500);
          await responseWork;
          expect(instance.logs()).toContain("[clock-shift] offsetMs=1000");
          console.log(
            `[real-gateway-node-proof] gatewayProcess=true nodeWebSocket=true wallClockOffsetMs=1000 result=SUCCESS elapsedMs=${elapsedMs}`,
          );
        },
        async () => {
          await runQaGatewayFixture(
            async () => await responseWork,
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
    },
  );
});

async function waitForFile(filePath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const watcher = watch(path.dirname(filePath), (_event, name) => {
      if (String(name) === path.basename(filePath)) {
        clearTimeout(timer);
        watcher.close();
        resolve();
      }
    });
    const timer = setTimeout(() => {
      watcher.close();
      reject(new Error(`Timed out waiting for ${filePath}`));
    }, 5_000);
    void access(filePath).then(
      () => {
        clearTimeout(timer);
        watcher.close();
        resolve();
      },
      () => {},
    );
  });
}

async function approveNodePairingForProof(operator: GatewayClient, nodeId: string): Promise<void> {
  await vi.waitFor(
    async () => {
      const pairing = await operator.request<{
        pending?: Array<{ nodeId?: string; requestId?: string; commands?: string[] }>;
      }>("node.pair.list", {});
      const pending = pairing.pending?.find((entry) => entry.nodeId === nodeId);
      expect(pending?.commands).toEqual(["system.notify"]);
      expect(pending?.requestId).toEqual(expect.any(String));
      await operator.request("node.pair.approve", { requestId: pending?.requestId });
    },
    { timeout: 15_000, interval: 100 },
  );
}
