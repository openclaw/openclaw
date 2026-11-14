// Opt-in shipped-flow proof: real Gateway and node-host processes, real model, fixture MCP only.
import "../test-utils/prepare-compiled-subprocesses.js";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createOpenClawTestInstance } from "../../test/helpers/openclaw-test-instance.js";
import { createOpenClawTestProcess } from "../../test/helpers/openclaw-test-process.js";
import {
  readMcpFixtureMessage,
  replyMcpFixtureResult,
  startMcpHttpFixture,
} from "../agents/agent-bundle-mcp-lifecycle.test-support.js";
import { isLiveTestEnabled } from "../agents/live-test-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { validateConfigObject } from "../config/validation.js";
import { NODE_MCP_TOOLS_CALL_COMMAND } from "../infra/node-commands.js";
import { listKnownProviderAuthEnvVarNamesCore } from "../secrets/provider-env-vars.js";
import { extractAssistantPhaseText } from "../shared/chat-message-content.js";
import type { NodeListNode } from "../shared/node-list-types.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  connectTestGatewayClient,
  ensurePairedTestGatewayClientIdentity,
} from "./gateway-cli-backend.live-helpers.js";

const enabled =
  isLiveTestEnabled() &&
  process.env.OPENCLAW_LIVE_NODE_INVENTORY === "1" &&
  Boolean(process.env.OPENAI_API_KEY);
const model = "openai/gpt-5.4";
const displayName = "Inventory Proof Node";
const profile = "node-inventory-proof";

it.skipIf(!enabled)(
  "discovers and calls tool_129 through a real node daemon and model turn",
  async ({ signal, onTestFinished }) => {
    const evidenceDir = path.resolve(
      process.env.OPENCLAW_NODE_PROOF_EVIDENCE_DIR ?? ".artifacts/node-inventory-live",
    );
    await fs.mkdir(evidenceDir, { recursive: true });
    const marker = "NODE_INVENTORY_" + randomUUID();
    const calls: string[] = [];
    let listPages = 0;
    const tools = Array.from({ length: 130 }, (_, index) => ({
      name: "tool_" + String(index).padStart(3, "0"),
      description: "Synthetic inventory probe " + index,
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    }));
    const mcp = await startMcpHttpFixture(async (request, response) => {
      if (request.method !== "POST") {
        response.writeHead(request.method === "DELETE" ? 200 : 405).end();
        return;
      }
      const message = await readMcpFixtureMessage<{ cursor?: string; name?: string }>(request);
      if (message.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      let result: unknown;
      if (message.method === "initialize") {
        result = {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "node-inventory-fixture", version: "1" },
        };
      } else if (message.method === "tools/list") {
        listPages += 1;
        const from = Number(message.params?.cursor ?? 0);
        const end = Math.min(from + 64, tools.length);
        result = {
          tools: tools.slice(from, end),
          ...(end < tools.length ? { nextCursor: String(end) } : {}),
        };
      } else if (message.method === "tools/call") {
        calls.push(String(message.params?.name));
        result = {
          content: [
            { type: "text", text: message.params?.name === "tool_129" ? marker : "wrong tool" },
          ],
        };
      } else {
        throw new Error("unexpected fixture MCP method");
      }
      replyMcpFixtureResult(response, message, result);
    });
    onTestFinished(() => mcp.close());
    const authEnv = Object.fromEntries(
      listKnownProviderAuthEnvVarNamesCore().map((name) => [name, undefined]),
    );
    const instance = await createOpenClawTestInstance({
      name: profile,
      signal,
      entrypoint: ["dist/index.js", "--profile", profile],
      env: {
        ...authEnv,
        OPENAI_API_KEY: process.env.OPENAI_API_KEY,
        OPENCLAW_PROFILE: profile,
        OPENAI_BASE_URL: undefined,
        OPENAI_API_BASE: undefined,
        OPENCLAW_AGENT_RUNTIME: undefined,
        OPENCLAW_TEST_MINIMAL_GATEWAY: "0",
        OPENCLAW_SKIP_PROVIDERS: undefined,
        OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
        OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: undefined,
      },
      startTimeoutMs: 90_000,
      gracefulShutdownTimeoutMs: 5_000,
    });
    onTestFinished(() => instance.cleanup());
    instance.state.applyEnv();
    const config: OpenClawConfig = {
      logging: { file: path.join(evidenceDir, "gateway-file.private.log") },
      gateway: {
        mode: "local",
        port: instance.port,
        auth: { mode: "token", token: instance.gatewayToken },
        controlUi: { enabled: false },
        nodes: {
          commands: { allow: [NODE_MCP_TOOLS_CALL_COMMAND] },
          pairing: { autoApproveLocal: false, sshVerify: false },
        },
      },
      agents: {
        defaults: {
          workspace: instance.state.workspaceDir,
          skipBootstrap: true,
          timeoutSeconds: 180,
          thinkingDefault: "low",
          model: { primary: model, fallbacks: [] },
          sandbox: { mode: "off" },
        },
        entries: { probe: { workspace: instance.state.workspaceDir } },
      },
      tools: { allow: ["node-mcp", "tool_search"], codeMode: { enabled: true } },
      mcp: { apps: { enabled: false } },
      secrets: { providers: { default: { source: "env" } } },
      models: {
        mode: "merge",
        providers: {
          openai: {
            api: "openai-responses",
            baseUrl: "https://api.openai.com/v1",
            apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
            agentRuntime: { id: "openclaw" },
            models: [],
          },
        },
      },
    };
    const validation = validateConfigObject(config);
    expect(validation.ok, JSON.stringify(validation)).toBe(true);
    await instance.state.writeConfig(config);
    instance.env.OPENCLAW_GATEWAY_PORT = String(instance.port);
    // The repository live-test client owns a synthetic operator on this disposable Gateway;
    // it never routes this child session's report into another real conversation or strips exec markers.
    const operatorIdentity = await ensurePairedTestGatewayClientIdentity({
      displayName: "Inventory proof operator",
    });
    await instance.startGateway();
    const gatewayPid = instance.child?.pid;
    expect(gatewayPid).toBeGreaterThan(0);
    onTestFinished(() => instance.stopGateway());
    const client = await connectTestGatewayClient({
      url: instance.url,
      token: instance.gatewayToken,
      deviceIdentity: operatorIdentity,
      requestTimeoutMs: 200_000,
    });
    onTestFinished(() => client.stopAndWait());
    const nodeState = await createOpenClawTestState({
      label: "inventory-node",
      env: { ...authEnv, OPENCLAW_PROFILE: profile },
    });
    onTestFinished(() => nodeState.cleanup());
    await nodeState.writeConfig({
      logging: { file: path.join(evidenceDir, "node-file.private.log") },
      gateway: { mode: "local" },
      browser: { enabled: false },
      plugins: { enabled: false },
      nodeHost: {
        browserProxy: { enabled: false },
        mcp: { servers: { fixture: { transport: "streamable-http", url: mcp.url } } },
      },
    });
    const nodeLogs: string[] = [];
    const node = await createOpenClawTestProcess({
      argv: [
        process.execPath,
        "dist/index.js",
        "--profile",
        profile,
        "node",
        "run",
        "--host",
        "127.0.0.1",
        "--port",
        String(instance.port),
        "--display-name",
        displayName,
        "--auth-from-env",
      ],
      cwd: process.cwd(),
      env: {
        ...nodeState.env,
        OPENCLAW_GATEWAY_TOKEN: instance.gatewayToken,
        OPENCLAW_GATEWAY_PORT: String(instance.port),
      },
      signal,
      onError: (error) => nodeLogs.push(error.message),
      onSpawnCleanup: (cleanup) => {
        void cleanup.catch(() => {});
      },
    });
    node.process.stdout.on("data", (chunk) => nodeLogs.push(String(chunk)));
    node.process.stderr.on("data", (chunk) => nodeLogs.push(String(chunk)));
    onTestFinished(async () => {
      await node.stop(Date.now() + 10_000, (message) => nodeLogs.push(message));
    });
    await node.started;
    const nodePid = node.process.pid;
    expect(nodePid).toBeGreaterThan(0);
    expect(nodePid).not.toBe(gatewayPid);
    const approved = new Set<string>();
    let deviceApproved = false;
    let surfaceApproved = false;
    let connected: NodeListNode | undefined;
    try {
      await expect
        .poll(
          async () => {
            for (const kind of ["device", "node"]) {
              const pending = await client.request<{
                pending: Array<{ requestId: string; displayName?: string; role?: string }>;
              }>(kind + ".pair.list", {});
              for (const request of pending.pending.filter(
                (entry) => entry.displayName === displayName,
              )) {
                if (approved.has(request.requestId)) {
                  continue;
                }
                await client.request(kind + ".pair.approve", { requestId: request.requestId });
                approved.add(request.requestId);
                if (kind === "device") {
                  deviceApproved = true;
                } else {
                  surfaceApproved = true;
                }
              }
            }
            const result = await client.request<{ nodes: NodeListNode[] }>("node.list", {});
            connected = result.nodes.find(
              (entry) => entry.displayName === displayName && entry.connected,
            );
            return connected?.nodePluginTools?.length;
          },
          { timeout: 60_000, interval: 250 },
        )
        .toBe(130);
      expect(deviceApproved).toBe(true);
      expect(surfaceApproved).toBe(true);
      expect(connected?.nodePluginTools?.at(-1)?.mcp?.tool).toBe("tool_129");
      expect(calls).toEqual([]);
      const sessionKey = "agent:probe:node-inventory-live";
      const runId = randomUUID();
      await client.request("chat.send", {
        sessionKey,
        idempotencyKey: runId,
        message:
          "Use Code Mode to first discover the paired node MCP tool with original name tool_129: call catalog.search with query tool_129 and inspect the returned callable/schema. Invoke that discovered MCP tool exactly once with empty arguments. Do not invoke any other inventory tool. Return exactly the proof marker returned by the tool. Do not guess the marker or use filesystem/shell/network tools.",
      });
      const waited = await client.request<{ status: string }>("agent.wait", {
        runId,
        timeoutMs: 180_000,
      });
      const history = await client.request<{
        messages: Array<Record<string, unknown>>;
        sessionInfo: { agentRuntime?: { id: string } };
      }>("chat.history", { sessionKey, limit: 100 });
      await fs.writeFile(
        path.join(evidenceDir, "history.private.json"),
        JSON.stringify(history, null, 2),
        { mode: 0o600 },
      );
      expect(waited.status).toBe("ok");
      expect(history.sessionInfo.agentRuntime?.id).toBe("openclaw");
      const assistant = history.messages.filter((message) => message.role === "assistant");
      const encoded = JSON.stringify(assistant);
      expect(encoded).toContain("catalog.search");
      expect(encoded).toContain("tool_129");
      const finalAssistant = assistant.at(-1);
      expect(finalAssistant?.provider).toBe("openai");
      expect(finalAssistant?.model).toBe("gpt-5.4");
      const finalText = extractAssistantPhaseText(finalAssistant)?.trim();
      expect(finalText).toBe(marker);
      expect(calls).toEqual(["tool_129"]);
      const nodeId = connected?.nodeId;
      expect(nodeId).toBeTruthy();
      await node.stop(Date.now() + 10_000, (message) => nodeLogs.push(message));
      await expect
        .poll(
          async () =>
            (await client.request<{ nodes: NodeListNode[] }>("node.list", {})).nodes.some(
              (entry) => entry.nodeId === nodeId && entry.connected,
            ),
          { timeout: 10_000 },
        )
        .toBe(false);
      await expect(
        client.request("node.invoke", {
          nodeId,
          command: NODE_MCP_TOOLS_CALL_COMMAND,
          params: { server: "fixture", tool: "tool_129", arguments: {} },
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toThrow();
      expect(calls).toEqual(["tool_129"]);
      await client.stopAndWait();
      await instance.stopGateway();
      const evidence = {
        sourceHead: process.env.OPENCLAW_NODE_PROOF_HEAD,
        realGatewayProcess: typeof gatewayPid === "number" && gatewayPid > 0,
        realNodeHostProcess: typeof nodePid === "number" && nodePid > 0,
        distinctForegroundProcesses: gatewayPid !== nodePid,
        runtimeVersion: process.versions.bun ?? process.version,
        fixtureSha256: createHash("sha256")
          .update(await fs.readFile(new URL(import.meta.url)))
          .digest("hex"),
        genuineDevicePairingApproved: deviceApproved,
        commandSurfaceApproved: surfaceApproved,
        publishedCardinality: connected?.nodePluginTools?.length,
        modelTurnCompleted: waited.status === "ok",
        codeModeDiscoveryObserved: true,
        mcpCalls: calls,
        listPages,
        hiddenToolResultInFinalAnswer: finalText === marker,
        hiddenResultSha256: createHash("sha256")
          .update(finalText ?? "")
          .digest("hex"),
        disconnectedCallRejected: true,
        nodeExitCode: node.process.exitCode,
        cleanup: "node and Gateway stopped",
      };
      await fs.writeFile(
        path.join(evidenceDir, "evidence.json"),
        JSON.stringify(evidence, null, 2),
      );
      console.log("NODE_INVENTORY_SHIPPED_FLOW_PROOF " + JSON.stringify(evidence));
    } finally {
      await fs.writeFile(path.join(evidenceDir, "node.private.log"), nodeLogs.join(""), {
        mode: 0o600,
      });
      await fs.writeFile(path.join(evidenceDir, "gateway.private.log"), instance.logs(), {
        mode: 0o600,
      });
    }
  },
  360_000,
);
