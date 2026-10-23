import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { createQaGatewayChild } from "../../../../extensions/qa-lab/api.js";
import type { NodePluginToolDescriptor } from "../../../../packages/gateway-protocol/src/schema/nodes.js";
import { createSessionMcpRuntime } from "../../../../src/agents/agent-bundle-mcp-runtime.js";
import type { OpenClawConfig } from "../../../../src/config/types.openclaw.js";
import { stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";
import {
  MCP_SERVERS,
  NODE_MCP_COMMAND,
  WAIT_OPTIONS,
  approvePairing,
  createMcpPlacement,
  descriptorFor,
  expectedProbeResults,
  flattenEffectiveTools,
  invokeNodeMcp,
  invokeNodeMcpPayload,
  parseProbeResult,
  processIsAlive,
  readNode,
  startHttpFixture,
  startMcpGateway,
  startNodeProcess,
  stopChild,
  waitForNode,
  waitForProcessExit,
  type CapturedChild,
  type GatewayHandle,
  type HttpFixture,
  type ProbeResult,
  type ToolsEffectiveResult,
} from "./gateway-node-mcp.test-support.js";

const QA_AGENT_ID = "qa";

it(
  "connects, filters, inventories, invokes, withdraws, and cleans up all real transports",
  // Repair progress and Gateway readiness have independent startup deadlines.
  { timeout: 300_000 },
  async ({ signal, onTestFinished }) => {
    // Finish hooks run in reverse order: join children before deleting their paths.
    const tempDirs = useAutoCleanupTempDirTracker(onTestFinished);
    const taskRoot = tempDirs.make("openclaw-gateway-node-mcp-");
    const nodePlacement = await createMcpPlacement(taskRoot, "node");
    const sessionPlacement = await createMcpPlacement(taskRoot, "session");
    const fixturePath = path.join(
      process.cwd(),
      "test/e2e/qa-lab/runtime/gateway-node-mcp.fixture.mjs",
    );

    let sessionHttpFixture: HttpFixture | undefined;
    let nodeHttpFixture: HttpFixture | undefined;
    let startingHttpFixtures: Promise<void> | undefined;
    const gatewayOwner = createQaGatewayChild();
    let gateway: GatewayHandle | undefined;
    let node: CapturedChild | undefined;
    let sessionRuntime: ReturnType<typeof createSessionMcpRuntime> | undefined;
    let proofError: unknown;
    const cleanupErrors: unknown[] = [];
    let cleanupPromise: Promise<void> | undefined;
    const cleanup = () =>
      (cleanupPromise ??= (async () => {
        await startingHttpFixtures?.catch(() => {});
        const stopped = [
          ...(await Promise.allSettled([
            ...(sessionRuntime ? [sessionRuntime.dispose()] : []),
            ...(node ? [stopChild(node)] : []),
          ])),
          ...(await Promise.allSettled([
            stopQaGatewayFixture(gatewayOwner),
            stopChild(sessionHttpFixture),
            stopChild(nodeHttpFixture),
          ])),
        ];
        for (const result of stopped) {
          if (result.status === "rejected") {
            cleanupErrors.push(result.reason);
          }
        }
        if (gateway && existsSync(gateway.tempRoot)) {
          cleanupErrors.push(new Error(`Gateway temp root was not removed: ${gateway.tempRoot}`));
        }
      })());
    onTestFinished(cleanup);

    try {
      const sessionEnv = sessionPlacement.env();
      const nodeFixtureEnv = nodePlacement.env();
      // Retain the whole sequential acquisition so cleanup also joins a later startup.
      startingHttpFixtures = (async () => {
        sessionHttpFixture = await startHttpFixture({
          fixturePath,
          labelPrefix: "session",
          env: sessionEnv,
          signal,
        });
        nodeHttpFixture = await startHttpFixture({
          fixturePath,
          labelPrefix: "node",
          env: nodeFixtureEnv,
          signal,
        });
      })();
      await startingHttpFixtures;
      if (!sessionHttpFixture || !nodeHttpFixture) {
        throw new Error("HTTP MCP fixtures did not start");
      }
      const sessionMcpServers = sessionPlacement.servers(sessionHttpFixture);
      const nodeMcpServers = nodePlacement.servers(nodeHttpFixture);

      const nodeConfig: OpenClawConfig = {
        gateway: { mode: "local" },
        plugins: { enabled: false },
        nodeHost: { mcp: { servers: nodeMcpServers }, skills: { enabled: false } },
      };
      await fs.writeFile(
        nodePlacement.configPath,
        `${JSON.stringify(nodeConfig, null, 2)}\n`,
        "utf8",
      );

      gateway = await startMcpGateway(gatewayOwner, (cfg) => ({
        ...cfg,
        mcp: { servers: sessionMcpServers },
        agents: {
          ...cfg.agents,
          entries: {
            ...cfg.agents?.entries,
            [QA_AGENT_ID]: {
              ...cfg.agents?.entries?.[QA_AGENT_ID],
              tools: { ...cfg.agents?.entries?.[QA_AGENT_ID]?.tools, profile: "full" },
            },
          },
        },
      }));

      const gatewayPort = Number(new URL(gateway.baseUrl).port);
      const nodeEnv = nodePlacement.hostEnv(gateway.token);

      // The first connection persists the approved device identity; the restart initiates node pairing.
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

      const tools = async (count = 3) =>
        (await waitForNode(gateway!, nodeId, count)).nodePluginTools ?? [];
      const published = await tools();
      expect(
        published.map((tool) => ({
          pluginId: tool.pluginId,
          command: tool.command,
          server: tool.mcp?.server,
          tool: tool.mcp?.tool,
        })),
      ).toEqual(
        MCP_SERVERS.map((server) => ({
          pluginId: "node-mcp",
          command: NODE_MCP_COMMAND,
          server,
          tool: "parity_probe",
        })),
      );

      sessionRuntime = createSessionMcpRuntime({
        sessionId: `qa-mcp-parity-${randomUUID()}`,
        sessionKey: `agent:${QA_AGENT_ID}:qa-mcp-parity-${randomUUID()}`,
        workspaceDir: sessionPlacement.workspaceDir,
        cfg: { plugins: { enabled: false }, mcp: { servers: sessionMcpServers } },
      });
      const sessionCall = (server: string, marker: string, tool = "parity_probe") =>
        sessionRuntime!.callTool(server, tool, { marker });
      const catalog = await sessionRuntime.getCatalog();
      expect(
        catalog.tools
          .map((tool) => [tool.serverName, tool.toolName] as const)
          .toSorted(([left], [right]) => left.localeCompare(right)),
      ).toEqual(MCP_SERVERS.map((server) => [server, "parity_probe"]));

      const nodeResults = new Map<string, ProbeResult>();
      for (const descriptor of published) {
        const server = descriptor.mcp?.server;
        if (!server) {
          throw new Error(`node MCP descriptor ${descriptor.name} omitted its server`);
        }
        nodeResults.set(server, await invoke(descriptor, `node-${server}`));
      }

      const sessionResults = new Map<string, ProbeResult>();
      for (const server of MCP_SERVERS) {
        sessionResults.set(
          server,
          parseProbeResult(await sessionCall(server, `session-${server}`)),
        );
      }

      expect(Object.fromEntries(nodeResults)).toEqual(
        expectedProbeResults("node", "node", nodeHttpFixture.pid),
      );
      expect(Object.fromEntries(sessionResults)).toEqual(
        expectedProbeResults("session", "session", sessionHttpFixture.pid),
      );
      expect(nodeHttpFixture.pid).not.toBe(sessionHttpFixture.pid);
      expect(nodeResults.get("stdio")?.pid).not.toBe(sessionResults.get("stdio")?.pid);

      const nodeStreamable = descriptorFor(published, "streamableHttp");
      const errorResult = (marker: string) => ({
        isError: true,
        structuredContent: { marker, retryable: true },
      });
      const nodeError = await invokePayload(nodeStreamable, "error-node-streamableHttp");
      expect(nodeError).toMatchObject({
        ok: true,
        payload: errorResult("error-node-streamableHttp"),
      });
      await expect(
        sessionCall("streamableHttp", "error-session-streamableHttp"),
      ).resolves.toMatchObject(errorResult("error-session-streamableHttp"));

      await invoke(nodeStreamable, "rotate-remove");
      let rotatedPublished: NodePluginToolDescriptor[] = [];
      const catalogGateway = gateway;
      await vi.waitFor(async () => {
        rotatedPublished = (await readNode(catalogGateway, nodeId))?.nodePluginTools ?? [];
        expect(
          rotatedPublished.map((descriptor) => [descriptor.mcp?.server, descriptor.mcp?.tool]),
          catalogGateway.logs(),
        ).toEqual([
          ["sse", "parity_probe"],
          ["stdio", "parity_probe"],
          ["streamableHttp", "parity_rotated"],
        ]);
      }, WAIT_OPTIONS);
      const rotatedNodeStreamable = descriptorFor(rotatedPublished, "streamableHttp");
      expect(rotatedNodeStreamable?.parameters).toMatchObject({
        properties: { revision: { type: "string" } },
      });
      for (const server of ["sse", "stdio"] as const) {
        const descriptor = descriptorFor(rotatedPublished, server);
        await expect(invoke(descriptor, `node-after-rotation-${server}`)).resolves.toMatchObject({
          marker: `node-after-rotation-${server}`,
        });
      }

      await sessionCall("streamableHttp", "rotate-remove");
      await vi.waitFor(async () => {
        const refreshed = await sessionRuntime?.getCatalog();
        expect(
          refreshed?.tools
            .filter((entry) => entry.serverName === "streamableHttp")
            .map((entry) => entry.toolName),
        ).toEqual(["parity_rotated"]);
      }, WAIT_OPTIONS);
      await expect(
        sessionCall("streamableHttp", "session-after-rotation", "parity_rotated"),
      ).resolves.toBeDefined();

      await expect(invoke(rotatedNodeStreamable, "expire-session")).rejects.toThrow();
      await waitForNode(gateway, nodeId, 2);
      const recoveredPublished = await tools();
      const recoveredStreamable = descriptorFor(recoveredPublished, "streamableHttp");
      await expect(invoke(recoveredStreamable, "node-after-session-expiry")).resolves.toMatchObject(
        { marker: "node-after-session-expiry" },
      );
      rotatedPublished = recoveredPublished;

      const created = (await gateway.call("sessions.create", {
        agentId: QA_AGENT_ID,
        label: "QA MCP parity inventory",
      })) as { key?: string };
      if (!created.key) {
        throw new Error("sessions.create did not return a session key");
      }
      const effective = (await gateway.call("tools.effective", {
        sessionKey: created.key,
      })) as ToolsEffectiveResult;
      const effectiveNodeTools = flattenEffectiveTools(effective).filter(
        (tool) => tool.pluginId === "node-mcp" && tool.source === "mcp",
      );
      expect(
        effectiveNodeTools
          .map((tool) => tool.id)
          .toSorted((a, b) => (a ?? "").localeCompare(b ?? "")),
      ).toEqual(rotatedPublished.map((tool) => tool.name).toSorted((a, b) => a.localeCompare(b)));

      const nodeStdioPid = nodeResults.get("stdio")?.pid;
      if (!nodeStdioPid) {
        throw new Error("node stdio probe did not return its PID");
      }
      process.kill(nodeStdioPid, "SIGTERM");
      await waitForProcessExit(nodeStdioPid);
      const remaining = await tools(2);
      expect(
        remaining
          .map((tool) => tool.mcp?.server)
          .toSorted((a, b) => (a ?? "").localeCompare(b ?? "")),
      ).toEqual(["sse", "streamableHttp"]);
      const remainingResults = new Map<string, ProbeResult>();
      for (const descriptor of remaining) {
        const server = descriptor.mcp?.server;
        if (!server) {
          throw new Error(`remaining descriptor ${descriptor.name} omitted its server`);
        }
        remainingResults.set(server, await invoke(descriptor, `node-after-stdio-stop-${server}`));
      }
      expect(Object.fromEntries(remainingResults)).toEqual(
        expectedProbeResults("node", "node-after-stdio-stop", nodeHttpFixture.pid, [
          "sse",
          "streamableHttp",
        ]),
      );
      const recoveredAfterStdio = await tools();
      const recoveredStdio = descriptorFor(recoveredAfterStdio, "stdio");
      const recoveredStdioResult = await invoke(recoveredStdio, "node-after-stdio-recovery");
      expect(recoveredStdioResult.marker).toBe("node-after-stdio-recovery");
      expect(recoveredStdioResult.pid).not.toBe(nodeStdioPid);

      const sessionStdioPid = sessionResults.get("stdio")?.pid;
      await sessionRuntime.dispose();
      sessionRuntime = undefined;
      if (sessionStdioPid) {
        await waitForProcessExit(sessionStdioPid);
      }

      await stopChild(node);
      node = undefined;
      const activeGateway = gateway;
      await vi.waitFor(async () => {
        const disconnected = await readNode(activeGateway, nodeId);
        expect(disconnected, activeGateway.logs()).toMatchObject({ connected: false });
        expect(disconnected?.nodePluginTools ?? []).toEqual([]);
      }, WAIT_OPTIONS);

      const afterNodeStop = (await gateway.call("tools.effective", {
        sessionKey: created.key,
      })) as ToolsEffectiveResult;
      expect(
        flattenEffectiveTools(afterNodeStop).filter((tool) => tool.pluginId === "node-mcp"),
      ).toEqual([]);
      expect([sessionHttpFixture.pid, nodeHttpFixture.pid].every(processIsAlive)).toBe(true);

      const httpPids = [sessionHttpFixture.pid, nodeHttpFixture.pid];
      await Promise.all([stopChild(sessionHttpFixture), stopChild(nodeHttpFixture)]);
      sessionHttpFixture = undefined;
      nodeHttpFixture = undefined;
      expect(httpPids.map(processIsAlive)).toEqual([false, false]);
    } catch (error) {
      const message = error instanceof Error ? error.stack : String(error);
      proofError = new Error(`${message}\nnode logs:\n${node?.logs() ?? "not started"}`, {
        cause: error,
      });
    } finally {
      await cleanup();
    }

    const failures = proofError === undefined ? cleanupErrors : [proofError, ...cleanupErrors];
    if (failures.length === 1) {
      throw failures[0];
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, "Gateway/node MCP parity proof failed");
    }
  },
);
