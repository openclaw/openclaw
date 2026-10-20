// Real Gateway proof of approval delivery, reviewer binding, and hook execution gating.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GATEWAY_CLIENT_CAPS } from "../../../packages/gateway-protocol/src/client-info.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../../config/config.js";
import { clearSessionStoreCacheForTest } from "../../config/sessions/store-writer-state.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../../test-utils/env.js";
import { APPROVALS_SCOPE, WRITE_SCOPE } from "../method-scopes.js";
import { startGatewayServer } from "../server.js";
import { connectGatewayClient, disconnectGatewayClient } from "../test-helpers.e2e.js";
import { acquireGatewayE2ePortBlock, startClaimedGateway } from "../test-helpers.listener.js";
import {
  configureManualGatewayBackgroundEnv,
  MANUAL_GATEWAY_ENV_KEYS,
} from "../test-helpers.manual-gateway-env.js";

const TEST_ENV_KEYS = [
  "HOME",
  ...MANUAL_GATEWAY_ENV_KEYS,
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_GATEWAY_URL",
  "OPENCLAW_GATEWAY_TOKEN",
  "OPENCLAW_GATEWAY_PASSWORD",
  "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
  "OPENCLAW_BUNDLED_PLUGINS_DIR",
  "OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR",
  "OPENCLAW_TEST_MINIMAL_GATEWAY",
];

describe("plugin.approval.request delivery routing (real gateway)", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;
  let tempHome: string;
  let hookExecutionPath: string;
  let url: string;
  let token: string;
  let server: Awaited<ReturnType<typeof startGatewayServer>>;
  let requester: Awaited<ReturnType<typeof connectGatewayClient>>;
  let toolCaller: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;
  let approvalClient: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;

  const connect = (options: Omit<Parameters<typeof connectGatewayClient>[0], "url">) =>
    connectGatewayClient({ url, token, timeoutMs: 60_000, ...options });
  const requestApproval = () =>
    requester.request("plugin.approval.request", {
      pluginId: "test-plugin",
      title: "Confirm action",
      description: "Plugin wants to perform an action",
      twoPhase: true,
      timeoutMs: 10_000,
    });
  const invokeTool = (client: typeof requester, name: string, confirm?: boolean) =>
    client.request("tools.invoke", {
      name,
      agentId: "main",
      sessionKey: "main",
      args: {},
      ...(confirm === undefined ? {} : { confirm }),
    });
  const expectToolText = (result: unknown, text: string) =>
    expect(result).toMatchObject({ ok: true, output: { content: [{ type: "text", text }] } });
  async function connectReviewer(clientDisplayName: string, toolName?: string) {
    const decision: {
      value: "allow-once" | "deny";
      settled: ReturnType<typeof createDeferredCore>;
    } = {
      value: "allow-once",
      settled: createDeferredCore(),
    };
    const client = await connect({
      clientDisplayName,
      scopes: [APPROVALS_SCOPE],
      caps: [GATEWAY_CLIENT_CAPS.APPROVALS],
      onEvent: (event) => {
        const payload = event.payload as
          | { id?: unknown; request?: { toolName?: unknown } }
          | undefined;
        if (
          event.event !== "plugin.approval.requested" ||
          typeof payload?.id !== "string" ||
          (toolName !== undefined && payload.request?.toolName !== toolName)
        ) {
          return;
        }
        void client
          .request("plugin.approval.resolve", { id: payload.id, decision: decision.value })
          .then(
            () => decision.settled.resolve(),
            (error) => decision.settled.reject(error),
          );
      },
    });
    return { client, decision };
  }

  beforeEach(async () => {
    envSnapshot = captureEnv(TEST_ENV_KEYS);
    deleteTestEnvValue("OPENCLAW_CONFIG_PATH");
    deleteTestEnvValue("OPENCLAW_GATEWAY_URL");
    deleteTestEnvValue("OPENCLAW_GATEWAY_TOKEN");
    deleteTestEnvValue("OPENCLAW_GATEWAY_PASSWORD");

    tempHome = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-plugin-approval-turn-source-e2e-"),
    );
    hookExecutionPath = path.join(tempHome, "approval-hook-executions.log");
    await fs.writeFile(hookExecutionPath, "");
    const stateDir = path.join(tempHome, ".openclaw");
    await fs.mkdir(stateDir, { recursive: true });
    setTestEnvValue("HOME", tempHome);
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    configureManualGatewayBackgroundEnv(tempHome);
    const configPath = path.join(stateDir, "openclaw.json");
    setTestEnvValue("OPENCLAW_CONFIG_PATH", configPath);
    await fs.writeFile(
      configPath,
      JSON.stringify({
        plugins: {
          enabled: true,
          allow: ["approval-route-probe"],
          slots: { memory: "none" },
          entries: { "approval-route-probe": { enabled: true } },
        },
      }),
    );
    const bundledDir = path.join(tempHome, "bundled-plugins");
    const pluginDir = path.join(bundledDir, "approval-route-probe");
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.writeFile(
      path.join(pluginDir, "package.json"),
      JSON.stringify({
        name: "@openclaw/approval-route-probe",
        version: "1.0.0",
        type: "commonjs",
        main: "index.cjs",
        openclaw: { extensions: ["./index.cjs"] },
      }),
    );
    await fs.writeFile(
      path.join(pluginDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: "approval-route-probe",
        configSchema: { type: "object", additionalProperties: false },
        contracts: { tools: ["approval_route_probe", "approval_hook_probe"] },
      }),
    );
    await fs.writeFile(
      path.join(pluginDir, "index.cjs"),
      `module.exports = { id: "approval-route-probe", register(api) {
        api.on("before_tool_call", (event) => {
          if (event.toolName !== "approval_hook_probe") return;
          return {
            requireApproval: {
              title: "Review hook-gated tool",
              description: "No effect; generic plugin approval test only",
              allowedDecisions: ["allow-once", "deny"],
              timeoutMs: 3_000,
            },
          };
        });
        api.registerTool((ctx) => ({
          name: "approval_route_probe",
          description: "Request a plugin approval from the current tool context",
          parameters: { type: "object", properties: {} },
          execute: async () => {
            const result = await api.runtime.gateway.request(
              "plugin.approval.request",
              {
                pluginId: api.id,
                title: "Review test action",
                description: "No effect; approval delivery test only",
                agentId: ctx.agentId,
                sessionKey: ctx.sessionKey,
                ...(ctx.approvalReviewerDeviceIds?.length
                  ? { approvalReviewerDeviceIds: ctx.approvalReviewerDeviceIds }
                  : {}),
                timeoutMs: 3_000,
              },
              { scopes: ["operator.approvals"], timeoutMs: 4_000 },
            );
            return { content: [{ type: "text", text: result.decision ?? "cancelled" }] };
          },
        }), { name: "approval_route_probe" });
        api.registerTool({
          name: "approval_hook_probe",
          description: "Run only after the before_tool_call approval",
          parameters: { type: "object", properties: {} },
          execute: async () => {
            require("node:fs").appendFileSync(${JSON.stringify(hookExecutionPath)}, "executed\\n");
            return { content: [{ type: "text", text: "HOOK_EXECUTED" }] };
          },
        });
      } };`,
    );
    setTestEnvValue("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "0");
    setTestEnvValue("OPENCLAW_BUNDLED_PLUGINS_DIR", bundledDir);
    setTestEnvValue("OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR", "1");
    setTestEnvValue("OPENCLAW_TEST_MINIMAL_GATEWAY", "0");

    const claim = await acquireGatewayE2ePortBlock();
    token = "plugin-approval-turn-source-e2e-token";
    url = `ws://127.0.0.1:${claim.port}`;
    setTestEnvValue("OPENCLAW_GATEWAY_PORT", String(claim.port));

    server = await startClaimedGateway(claim, () =>
      startGatewayServer(claim.port, {
        bind: "loopback",
        auth: { mode: "token", token },
        controlUiEnabled: false,
        sidecarStartup: "defer",
      }),
    );

    // A requester is not a delivery route: it lacks the approvals capability.
    requester = await connect({
      clientDisplayName: "plugin-approval requester",
      scopes: [WRITE_SCOPE, APPROVALS_SCOPE],
      requestTimeoutMs: 10_000,
    });
  });

  afterEach(async () => {
    if (approvalClient) {
      await disconnectGatewayClient(approvalClient).catch(() => undefined);
      approvalClient = undefined;
    }
    if (toolCaller) {
      await disconnectGatewayClient(toolCaller).catch(() => undefined);
      toolCaller = undefined;
    }
    await disconnectGatewayClient(requester).catch(() => undefined);
    await server?.close();
    await fs.rm(tempHome, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
    envSnapshot.restore();
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    clearSessionStoreCacheForTest();
  });

  // The E2E setup retires active plugins after each `it`, so each test owns a fresh Gateway.
  it("expires with decision:null when no turn-source route and no approval client", async () => {
    const result = await requestApproval();

    expect(result).toMatchObject({ decision: null });
    expect((result as { id?: string }).id).toMatch(/^plugin:/);
  });

  it("returns accepted when a real approval client is connected", async () => {
    approvalClient = await connect({
      clientDisplayName: "plugin approval client",
      scopes: [APPROVALS_SCOPE],
      caps: [GATEWAY_CLIENT_CAPS.APPROVALS],
    });

    const result = await requestApproval();

    expect(result).toMatchObject({ status: "accepted" });
    expect((result as { id?: string }).id).toMatch(/^plugin:/);
    await approvalClient.request("plugin.approval.resolve", {
      id: (result as { id: string }).id,
      decision: "allow-once",
    });
  });

  it("routes a plugin tool approval only to the host-selected reviewer device", async () => {
    toolCaller = await connect({
      clientDisplayName: "write-only plugin tool caller",
      scopes: [WRITE_SCOPE],
    });
    // The reviewer shares the helper's default test device identity with the tool caller.
    const reviewer = await connectReviewer("same-device reviewer");
    try {
      expectToolText(await invokeTool(toolCaller, "approval_route_probe"), "allow-once");
      await reviewer.decision.settled.promise;
    } finally {
      await disconnectGatewayClient(reviewer.client);
    }

    for (const deniedReviewer of [
      { deviceFamily: "other-device", scopes: [APPROVALS_SCOPE] },
      { scopes: ["operator.read"] },
    ]) {
      let receivedRequests = 0;
      const untrusted = await connect({
        clientDisplayName: "unmatched reviewer",
        ...deniedReviewer,
        caps: [GATEWAY_CLIENT_CAPS.APPROVALS],
        onEvent: (event) => {
          if (event.event === "plugin.approval.requested") {
            receivedRequests += 1;
          }
        },
      });
      try {
        expectToolText(await invokeTool(toolCaller, "approval_route_probe"), "cancelled");
        expect(receivedRequests).toBe(0);
      } finally {
        await disconnectGatewayClient(untrusted);
      }
    }
  });

  it("honors a generic plugin hook approval from a write-only caller", async () => {
    const caller = await connect({
      clientDisplayName: "write-only hook caller",
      scopes: [WRITE_SCOPE],
      requestTimeoutMs: 15_000,
    });
    const { client: reviewer, decision } = await connectReviewer(
      "same-device hook reviewer",
      "approval_hook_probe",
    );
    const invoke = () => invokeTool(caller, "approval_hook_probe", true);
    try {
      const allowed = await invoke();
      expectToolText(allowed, "HOOK_EXECUTED");
      await decision.settled.promise;
      expect(await fs.readFile(hookExecutionPath, "utf8")).toBe("executed\n");

      decision.value = "deny";
      decision.settled = createDeferredCore();
      const denied = await invoke();
      expect(denied).toMatchObject({ ok: false, requiresApproval: true });
      await decision.settled.promise;
      expect(await fs.readFile(hookExecutionPath, "utf8")).toBe("executed\n");
    } finally {
      await disconnectGatewayClient(reviewer);
      await disconnectGatewayClient(caller);
    }
  });
});
