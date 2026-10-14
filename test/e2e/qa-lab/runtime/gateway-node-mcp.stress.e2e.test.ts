import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as waitForProcessTick } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { createQaGatewayChild } from "../../../../extensions/qa-lab/api.js";
import type { NodePluginToolDescriptor } from "../../../../packages/gateway-protocol/src/schema/nodes.js";
import { createSessionMcpRuntime } from "../../../../src/agents/agent-bundle-mcp-runtime.js";
import type { OpenClawConfig } from "../../../../src/config/types.openclaw.js";
import { stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";
import {
  NODE_MCP_COMMAND,
  TEST_TIMEOUT_MS,
  WAIT_OPTIONS,
  approvePairing,
  createChildEnv,
  createMcpServers,
  invokeNodeMcp,
  invokeNodeMcpPayload,
  parseNodeMcpTextRecord,
  processIsAlive,
  startHttpFixture,
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

function descriptorFor(
  descriptors: readonly NodePluginToolDescriptor[],
  server: string,
): NodePluginToolDescriptor {
  const descriptor = descriptors.find((entry) => entry.mcp?.server === server);
  if (!descriptor) {
    throw new Error(`missing ${server} MCP descriptor`);
  }
  return descriptor;
}

async function readProcessRecords(filePath: string) {
  const text = await fs.readFile(filePath, "utf8");
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { leaderPid: number; descendantPid: number });
}

describe("Gateway/node MCP real-process stress", () => {
  it(
    "serializes catalogs, recovers terminal streams, fences expiry, and reaps crash generations",
    { timeout: TEST_TIMEOUT_MS },
    async ({ signal, onTestFinished }) => {
      // Finish hooks run in reverse order: join children before deleting their paths.
      const tempDirs = useAutoCleanupTempDirTracker(onTestFinished);
      const repoRoot = process.cwd();
      const root = tempDirs.make("openclaw-gateway-node-mcp-stress-");
      const at = (...parts: string[]) => path.join(root, ...parts);
      const nodeHome = at("node", "home");
      const nodeStateDir = at("node", "state");
      const nodeConfigPath = at("node", "openclaw.json");
      const nodeTempDir = at("node", "tmp");
      const sessionHome = at("session", "home");
      const sessionTempDir = at("session", "tmp");
      const sessionWorkspace = at("session", "workspace");
      const nodeEvents = at("node-generations.jsonl");
      const sessionEvents = at("session-generations.jsonl");
      const fixturePath = path.join(
        repoRoot,
        "test/e2e/qa-lab/runtime/gateway-node-mcp.fixture.mjs",
      );
      await Promise.all(
        [nodeHome, nodeStateDir, nodeTempDir, sessionHome, sessionTempDir, sessionWorkspace].map(
          (dir) => fs.mkdir(dir, { recursive: true }),
        ),
      );

      let fixture: HttpFixture | undefined;
      let startingFixture: Promise<HttpFixture> | undefined;
      const gatewayOwner = createQaGatewayChild();
      let gateway: GatewayHandle | undefined;
      let node: CapturedChild | undefined;
      let sessionRuntime: ReturnType<typeof createSessionMcpRuntime> | undefined;
      let cleanupPromise: Promise<void> | undefined;
      const cleanup = () =>
        (cleanupPromise ??= (async () => {
          const acquiredFixture = await startingFixture?.catch(() => undefined);
          await Promise.allSettled([
            ...(sessionRuntime ? [sessionRuntime.dispose()] : []),
            ...(node ? [stopChild(node)] : []),
          ]);
          await Promise.allSettled([
            stopQaGatewayFixture(gatewayOwner),
            ...(acquiredFixture ? [stopChild(acquiredFixture)] : []),
          ]);
          for (const eventPath of [nodeEvents, sessionEvents]) {
            const records = await readProcessRecords(eventPath).catch(() => []);
            for (const record of records) {
              for (const pid of [record.leaderPid, record.descendantPid]) {
                if (processIsAlive(pid)) {
                  process.kill(pid, "SIGKILL");
                  await waitForProcessExit(pid).catch(() => {});
                }
              }
            }
          }
        })());
      onTestFinished(cleanup);
      try {
        const fixtureEnv = createChildEnv({ home: nodeHome, tempDir: nodeTempDir });
        startingFixture = startHttpFixture({
          fixturePath,
          labelPrefix: "node",
          env: fixtureEnv,
          signal,
        });
        fixture = await startingFixture;
        const nodeStdioEnv = createChildEnv({
          home: nodeHome,
          tempDir: nodeTempDir,
          extra: {
            MCP_STRESS_STARTUP_INVERSION: "1",
            MCP_STRESS_EVENT_PATH: nodeEvents,
          },
        });
        const nodeServers = createMcpServers({
          placement: "node",
          fixture,
          stdioEnv: nodeStdioEnv,
          fixturePath,
          repoRoot,
        });
        const nodeConfig: OpenClawConfig = {
          gateway: { mode: "local" },
          plugins: { enabled: false },
          nodeHost: { mcp: { servers: nodeServers }, skills: { enabled: false } },
        };
        await fs.writeFile(nodeConfigPath, `${JSON.stringify(nodeConfig, null, 2)}\n`, "utf8");

        gateway = await gatewayOwner.start({
          repoRoot,
          command: {
            executablePath: process.execPath,
            argsPrefix: ["dist/index.js"],
            cwd: repoRoot,
            usePackagedPlugins: true,
          },
          transportBaseUrl: "http://127.0.0.1",
          controlUiEnabled: false,
          runtimeEnvPatch: {
            OPENCLAW_SKIP_CHANNELS: "1",
            OPENCLAW_SKIP_PROVIDERS: "1",
            OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
          },
          mutateConfig: (cfg) => {
            return {
              ...cfg,
              plugins: { enabled: false },
              gateway: {
                ...cfg.gateway,
                nodes: {
                  ...cfg.gateway?.nodes,
                  commands: { allow: [NODE_MCP_COMMAND] },
                  pairing: { ...cfg.gateway?.nodes?.pairing, autoApproveLocal: false },
                },
              },
            };
          },
        });
        const nodeEnv = createChildEnv({
          home: nodeHome,
          tempDir: nodeTempDir,
          extra: {
            OPENCLAW_HOME: nodeHome,
            OPENCLAW_STATE_DIR: nodeStateDir,
            OPENCLAW_CONFIG_PATH: nodeConfigPath,
            OPENCLAW_GATEWAY_TOKEN: gateway.token,
            OPENCLAW_ALLOW_INSECURE_PRIVATE_WS: "1",
            OPENCLAW_SKIP_CHANNELS: "1",
            OPENCLAW_SKIP_PROVIDERS: "1",
          },
        });
        const gatewayPort = Number(new URL(gateway.baseUrl).port);
        node = startNodeProcess(gatewayPort, nodeEnv);
        const nodeId = await approvePairing(gateway, "device");
        await stopChild(node);
        node = startNodeProcess(gatewayPort, nodeEnv);
        await approvePairing(gateway, "node", nodeId);

        let descriptors = (await waitForNode(gateway, nodeId, 3)).nodePluginTools ?? [];
        expect(descriptorFor(descriptors, "stdio").mcp?.tool).toBe("parity_probe");
        expect(descriptors.some((entry) => entry.mcp?.tool === "parity_stale")).toBe(false);

        const sessionStdioEnv = createChildEnv({
          home: sessionHome,
          tempDir: sessionTempDir,
          extra: {
            MCP_STRESS_STARTUP_INVERSION: "1",
            MCP_STRESS_EVENT_PATH: sessionEvents,
          },
        });
        const sessionServers = createMcpServers({
          placement: "session",
          fixture,
          stdioEnv: sessionStdioEnv,
          fixturePath,
          repoRoot,
        });
        const sessionStdio = sessionServers.stdio;
        if (!sessionStdio) {
          throw new Error("session stdio MCP server config was not created");
        }
        sessionRuntime = createSessionMcpRuntime({
          sessionId: `stress-${randomUUID()}`,
          workspaceDir: sessionWorkspace,
          cfg: {
            plugins: { enabled: false },
            mcp: { servers: { stdio: sessionStdio } },
          },
        });
        await sessionRuntime.getCatalog();

        const stdioDescriptor = descriptorFor(descriptors, "stdio");
        const nodeRich = await invokeNodeMcpPayload({
          gateway,
          nodeId,
          descriptor: stdioDescriptor,
          marker: "rich-result",
        });
        const sessionRich = await sessionRuntime.callTool("stdio", "parity_probe", {
          marker: "rich-result",
        });
        expect(nodeRich).toMatchObject({
          payload: {
            content: sessionRich.content.map((block) => ({ type: block.type })),
            structuredContent: { marker: "rich-result", rich: true },
          },
        });
        expect(sessionRich.structuredContent).toMatchObject({ marker: "rich-result", rich: true });

        const nodeEmpty = await invokeNodeMcpPayload({
          gateway,
          nodeId,
          descriptor: stdioDescriptor,
          marker: "empty-error",
        });
        const sessionEmpty = await sessionRuntime.callTool("stdio", "parity_probe", {
          marker: "empty-error",
        });
        expect(nodeEmpty).toMatchObject({ payload: { content: [], isError: true } });
        expect(sessionEmpty).toMatchObject({ content: [], isError: true });
        await sessionRuntime.dispose();
        sessionRuntime = undefined;

        for (const server of ["sse", "streamableHttp"] as const) {
          descriptors = (await waitForNode(gateway, nodeId, 3)).nodePluginTools ?? [];
          const descriptor = descriptorFor(descriptors, server);
          const before = parseNodeMcpTextRecord(
            await invokeNodeMcpPayload({
              gateway,
              nodeId,
              descriptor,
              marker: `before-${server}`,
            }),
          );
          await invokeNodeMcp({
            gateway,
            nodeId,
            descriptor,
            marker: "break-notifications",
          });
          await vi.waitFor(async () => {
            const current = (await waitForNode(gateway!, nodeId, 3)).nodePluginTools ?? [];
            const after = parseNodeMcpTextRecord(
              await invokeNodeMcpPayload({
                gateway: gateway!,
                nodeId,
                descriptor: descriptorFor(current, server),
                marker: `after-${server}`,
              }),
            );
            expect(Number(after.generation)).toBeGreaterThan(Number(before.generation));
          }, WAIT_OPTIONS);
        }

        for (let generation = 0; generation < 3; generation += 1) {
          descriptors = (await waitForNode(gateway, nodeId, 3)).nodePluginTools ?? [];
          const result = await invokeNodeMcp({
            gateway,
            nodeId,
            descriptor: descriptorFor(descriptors, "stdio"),
            marker: "crash-generation",
          });
          // runStressStdio appends this record before installing its request handler.
          const records = await readProcessRecords(nodeEvents);
          const record = records.find((entry) => entry.leaderPid === result.pid);
          expect(record).toBeDefined();
          if (!record) {
            throw new Error(`MCP generation ${result.pid} omitted its process record`);
          }
          await waitForGenerationExit(record, signal);
          await vi.waitFor(async () => {
            const current = (await waitForNode(gateway!, nodeId, 3)).nodePluginTools ?? [];
            const recovered = await invokeNodeMcp({
              gateway: gateway!,
              nodeId,
              descriptor: descriptorFor(current, "stdio"),
              marker: `recovered-${generation}`,
            });
            expect(recovered.pid).not.toBe(result.pid);
          }, WAIT_OPTIONS);
        }

        descriptors = (await waitForNode(gateway, nodeId, 3)).nodePluginTools ?? [];
        const streamable = descriptorFor(descriptors, "streamableHttp");
        // The fixture admits both HTTP requests before expiring their shared session.
        const expired = await Promise.allSettled([
          invokeNodeMcpPayload({
            gateway,
            nodeId,
            descriptor: streamable,
            marker: "expire-concurrent-session",
          }),
          invokeNodeMcpPayload({
            gateway,
            nodeId,
            descriptor: streamable,
            marker: "expire-concurrent-session",
          }),
        ]);
        expect(expired.every((result) => result.status === "rejected")).toBe(true);
        await vi.waitFor(async () => {
          const current = (await waitForNode(gateway!, nodeId, 3)).nodePluginTools ?? [];
          const stats = parseNodeMcpTextRecord(
            await invokeNodeMcpPayload({
              gateway: gateway!,
              nodeId,
              descriptor: descriptorFor(current, "streamableHttp"),
              marker: "expiry-stats",
            }),
          );
          expect(stats.expiryCalls).toBe(2);
        }, WAIT_OPTIONS);
      } finally {
        await cleanup();
      }
    },
  );
});
