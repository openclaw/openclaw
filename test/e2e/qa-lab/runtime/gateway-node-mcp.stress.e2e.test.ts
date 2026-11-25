import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as waitForProcessTick } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { createQaGatewayChild } from "../../../../extensions/qa-lab/api.js";
import type { NodePluginToolDescriptor } from "../../../../packages/gateway-protocol/src/schema/nodes.js";
import type { OpenClawConfig } from "../../../../src/config/types.openclaw.js";
import { stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";
import {
  TEST_TIMEOUT_MS,
  WAIT_OPTIONS,
  approvePairing,
  createMcpPlacement,
  descriptorFor,
  invokeNodeMcp,
  invokeNodeMcpPayload,
  parseNodeMcpTextRecord,
  processIsAlive,
  startHttpFixture,
  startMcpGateway,
  startNodeProcess,
  stopChild,
  waitForNode,
  waitForProcessExit,
  type CapturedChild,
  type GatewayHandle,
  type HttpFixture,
} from "./gateway-node-mcp.test-support.js";

// The node owns these descendants; tree signaling does not expose their extinction.
async function waitForGenerationExit(
  record: { leaderPid: number; descendantPid: number },
  signal: AbortSignal,
): Promise<void> {
  try {
    while (processIsAlive(record.leaderPid) || processIsAlive(record.descendantPid)) {
      await waitForProcessTick(10, undefined, { signal });
    }
  } catch (error) {
    throw new Error(`timed out waiting for MCP generation ${record.leaderPid} to exit`, {
      cause: error,
    });
  }
}

async function readProcessRecords(filePath: string) {
  const text = await fs.readFile(filePath, "utf8");
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { leaderPid: number; descendantPid: number });
}

it(
  "serializes catalogs, recovers terminal streams, fences expiry, and reaps crash generations",
  { timeout: TEST_TIMEOUT_MS },
  async ({ signal, onTestFinished }) => {
    // Finish hooks run in reverse order: join children before deleting their paths.
    const tempDirs = useAutoCleanupTempDirTracker(onTestFinished);
    const root = tempDirs.make("openclaw-gateway-node-mcp-stress-");
    const nodePlacement = await createMcpPlacement(root, "node");
    const nodeEvents = path.join(root, "node-generations.jsonl");
    const fixturePath = path.join(
      process.cwd(),
      "test/e2e/qa-lab/runtime/gateway-node-mcp.fixture.mjs",
    );

    let fixture: HttpFixture | undefined;
    let startingFixture: Promise<HttpFixture> | undefined;
    const gatewayOwner = createQaGatewayChild();
    let gateway: GatewayHandle | undefined;
    let node: CapturedChild | undefined;
    let cleanupPromise: Promise<void> | undefined;
    const cleanup = () =>
      (cleanupPromise ??= (async () => {
        const acquiredFixture = await startingFixture?.catch(() => undefined);
        if (node) {
          await Promise.allSettled([stopChild(node)]);
        }
        await Promise.allSettled([
          stopQaGatewayFixture(gatewayOwner),
          ...(acquiredFixture ? [stopChild(acquiredFixture)] : []),
        ]);
        const records = await readProcessRecords(nodeEvents).catch(() => []);
        for (const record of records) {
          for (const pid of [record.leaderPid, record.descendantPid]) {
            if (processIsAlive(pid)) {
              process.kill(pid, "SIGKILL");
              await waitForProcessExit(pid).catch(() => {});
            }
          }
        }
      })());
    onTestFinished(cleanup);
    try {
      const fixtureEnv = nodePlacement.env();
      startingFixture = startHttpFixture({
        fixturePath,
        labelPrefix: "node",
        env: fixtureEnv,
        signal,
      });
      fixture = await startingFixture;
      const nodeServers = nodePlacement.servers(fixture, {
        MCP_STRESS_STARTUP_INVERSION: "1",
        MCP_STRESS_EVENT_PATH: nodeEvents,
      });
      const nodeConfig: OpenClawConfig = {
        gateway: { mode: "local" },
        plugins: { enabled: false },
        nodeHost: { mcp: { servers: nodeServers }, skills: { enabled: false } },
      };
      await fs.writeFile(
        nodePlacement.configPath,
        `${JSON.stringify(nodeConfig, null, 2)}\n`,
        "utf8",
      );

      gateway = await startMcpGateway(gatewayOwner);
      const nodeEnv = nodePlacement.hostEnv(gateway.token);
      const gatewayPort = Number(new URL(gateway.baseUrl).port);
      node = startNodeProcess(gatewayPort, nodeEnv);
      const nodeId = await approvePairing(gateway, "device");
      await stopChild(node);
      node = startNodeProcess(gatewayPort, nodeEnv);
      await approvePairing(gateway, "node", nodeId);

      const invocation = { gateway, nodeId };
      const invoke = (descriptor: NodePluginToolDescriptor, marker: string) =>
        invokeNodeMcp({ ...invocation, descriptor, marker });
      const invokePayload = (descriptor: NodePluginToolDescriptor, marker: string) =>
        invokeNodeMcpPayload({ ...invocation, descriptor, marker });

      const tools = async () => (await waitForNode(gateway!, nodeId, 3)).nodePluginTools ?? [];
      let descriptors = await tools();
      expect(descriptorFor(descriptors, "stdio").mcp?.tool).toBe("parity_probe");
      expect(descriptors.some((entry) => entry.mcp?.tool === "parity_stale")).toBe(false);

      const stdioDescriptor = descriptorFor(descriptors, "stdio");
      const nodeRich = await invokePayload(stdioDescriptor, "rich-result");
      expect(nodeRich).toMatchObject({
        payload: {
          content: ["text", "resource_link", "resource", "audio", "image"].map((type) => ({
            type,
          })),
          structuredContent: { marker: "rich-result", rich: true },
        },
      });
      const nodeEmpty = await invokePayload(stdioDescriptor, "empty-error");
      expect(nodeEmpty).toMatchObject({ payload: { content: [], isError: true } });

      for (const server of ["sse", "streamableHttp"] as const) {
        descriptors = await tools();
        const descriptor = descriptorFor(descriptors, server);
        const before = parseNodeMcpTextRecord(await invokePayload(descriptor, `before-${server}`));
        await invoke(descriptor, "break-notifications");
        await vi.waitFor(async () => {
          const current = await tools();
          const after = parseNodeMcpTextRecord(
            await invokePayload(descriptorFor(current, server), `after-${server}`),
          );
          expect(Number(after.generation)).toBeGreaterThan(Number(before.generation));
        }, WAIT_OPTIONS);
      }

      for (let generation = 0; generation < 3; generation += 1) {
        descriptors = await tools();
        const result = await invoke(descriptorFor(descriptors, "stdio"), "crash-generation");
        // runStressStdio appends this record before installing its request handler.
        const records = await readProcessRecords(nodeEvents);
        const record = records.find((entry) => entry.leaderPid === result.pid);
        expect(record).toBeDefined();
        if (!record) {
          throw new Error(`MCP generation ${result.pid} omitted its process record`);
        }
        await waitForGenerationExit(record, signal);
        await vi.waitFor(async () => {
          const current = await tools();
          const recovered = await invoke(
            descriptorFor(current, "stdio"),
            `recovered-${generation}`,
          );
          expect(recovered.pid).not.toBe(result.pid);
        }, WAIT_OPTIONS);
      }

      descriptors = await tools();
      const streamable = descriptorFor(descriptors, "streamableHttp");
      // The fixture admits both HTTP requests before expiring their shared session.
      const expired = await Promise.allSettled([
        invokePayload(streamable, "expire-concurrent-session"),
        invokePayload(streamable, "expire-concurrent-session"),
      ]);
      expect(expired.every((result) => result.status === "rejected")).toBe(true);
      await vi.waitFor(async () => {
        const current = await tools();
        const stats = parseNodeMcpTextRecord(
          await invokePayload(descriptorFor(current, "streamableHttp"), "expiry-stats"),
        );
        expect(stats.expiryCalls).toBe(2);
      }, WAIT_OPTIONS);
    } finally {
      await cleanup();
    }
  },
);
