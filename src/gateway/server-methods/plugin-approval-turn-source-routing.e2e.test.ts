// Gateway e2e proof: real delivery routes change approval response behavior.
//
// Without turn-source fields: plugin.approval.request expires immediately with
// {decision: null} because there is no approval client and no turn-source route.
//
// With a connected approval-capable client: the approval stays alive and
// returns {status: "accepted"} because it has a real delivery route.
//
// This test runs against a real gateway server with no Telegram required.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
  let connectApprovalClient: () => Promise<Awaited<ReturnType<typeof connectGatewayClient>>>;

  beforeAll(async () => {
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

    // No operator approval client; only a requester with write and approvals scopes.
    // This is the state that triggers the no-route expiry in the unfixed code.
    requester = await connectGatewayClient({
      url,
      token,
      clientDisplayName: "plugin-approval requester",
      scopes: [WRITE_SCOPE, APPROVALS_SCOPE],
      requestTimeoutMs: 10_000,
      timeoutMs: 60_000,
    });
    connectApprovalClient = () =>
      connectGatewayClient({
        url,
        token,
        clientDisplayName: "plugin approval client",
        scopes: [APPROVALS_SCOPE],
        caps: [GATEWAY_CLIENT_CAPS.APPROVALS],
        timeoutMs: 60_000,
      });
  });

  afterAll(async () => {
    if (approvalClient) {
      await disconnectGatewayClient(approvalClient).catch(() => undefined);
    }
    if (toolCaller) {
      await disconnectGatewayClient(toolCaller).catch(() => undefined);
    }
    await disconnectGatewayClient(requester).catch(() => undefined);
    await server?.close();
    await fs.rm(tempHome, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
    envSnapshot.restore();
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    clearSessionStoreCacheForTest();
  });

  it("expires with decision:null when no turn-source route and no approval client", async () => {
    // This is the bug: without turn-source fields, the gateway expires the record
    // immediately (decision: null) because there is no delivery route.
    const result = await requester.request("plugin.approval.request", {
      pluginId: "test-plugin",
      title: "Confirm action",
      description: "Plugin wants to perform an action",
      twoPhase: true,
      timeoutMs: 10_000,
      // No turnSourceChannel/turnSourceTo/turnSourceAccountId/turnSourceThreadId
    });

    expect(result).toMatchObject({ decision: null });
    expect((result as { id?: string }).id).toMatch(/^plugin:/);
  });

  it("returns accepted when a real approval client is connected", async () => {
    approvalClient = await connectApprovalClient();

    const result = await requester.request("plugin.approval.request", {
      pluginId: "test-plugin",
      title: "Confirm action",
      description: "Plugin wants to perform an action",
      twoPhase: true,
      timeoutMs: 10_000,
    });

    expect(result).toMatchObject({ status: "accepted" });
    expect((result as { id?: string }).id).toMatch(/^plugin:/);
    await approvalClient.request("plugin.approval.resolve", {
      id: (result as { id: string }).id,
      decision: "allow-once",
    });
  });

  it("routes a plugin tool approval only to the host-selected reviewer device", async () => {
    if (approvalClient) {
      await disconnectGatewayClient(approvalClient);
      approvalClient = undefined;
    }
    toolCaller = await connectGatewayClient({
      url,
      token,
      clientDisplayName: "write-only plugin tool caller",
      scopes: [WRITE_SCOPE],
      timeoutMs: 60_000,
    });
    const decided = createDeferredCore();
    // The reviewer shares the helper's default test device identity with the tool caller.
    const reviewer = await connectGatewayClient({
      url,
      token,
      clientDisplayName: "same-device reviewer",
      scopes: [APPROVALS_SCOPE],
      caps: [GATEWAY_CLIENT_CAPS.APPROVALS],
      onEvent: (event) => {
        if (event.event !== "plugin.approval.requested") {
          return;
        }
        const id = (event.payload as { id?: unknown } | undefined)?.id;
        if (typeof id === "string") {
          void reviewer
            .request("plugin.approval.resolve", { id, decision: "allow-once" })
            .then(() => decided.resolve(), decided.reject);
        }
      },
      timeoutMs: 60_000,
    });
    try {
      const result = await toolCaller.request("tools.invoke", {
        name: "approval_route_probe",
        agentId: "main",
        sessionKey: "main",
        args: {},
      });
      expect(result).toMatchObject({
        ok: true,
        output: { content: [{ type: "text", text: "allow-once" }] },
      });
      await decided.promise;
    } finally {
      await disconnectGatewayClient(reviewer);
    }

    for (const deniedReviewer of [
      { deviceFamily: "other-device", scopes: [APPROVALS_SCOPE] },
      { scopes: ["operator.read"] },
    ]) {
      let receivedRequests = 0;
      const untrusted = await connectGatewayClient({
        url,
        token,
        clientDisplayName: "unmatched reviewer",
        ...deniedReviewer,
        caps: [GATEWAY_CLIENT_CAPS.APPROVALS],
        onEvent: (event) => {
          if (event.event === "plugin.approval.requested") {
            receivedRequests += 1;
          }
        },
        timeoutMs: 60_000,
      });
      try {
        const result = await toolCaller.request("tools.invoke", {
          name: "approval_route_probe",
          agentId: "main",
          sessionKey: "main",
          args: {},
        });
        expect(result).toMatchObject({
          ok: true,
          output: { content: [{ type: "text", text: "cancelled" }] },
        });
        expect(receivedRequests).toBe(0);
      } finally {
        await disconnectGatewayClient(untrusted);
      }
    }
  });

  it("honors a generic plugin hook approval from a write-only caller", async () => {
    const caller = await connectGatewayClient({
      url,
      token,
      clientDisplayName: "write-only hook caller",
      scopes: [WRITE_SCOPE],
      requestTimeoutMs: 15_000,
      timeoutMs: 60_000,
    });
    let decision: "allow-once" | "deny" = "allow-once";
    let decided = createDeferredCore();
    const reviewer = await connectGatewayClient({
      url,
      token,
      clientDisplayName: "same-device hook reviewer",
      scopes: [APPROVALS_SCOPE],
      caps: [GATEWAY_CLIENT_CAPS.APPROVALS],
      onEvent: (event) => {
        const payload = event.payload as
          | { id?: unknown; request?: { toolName?: unknown } }
          | undefined;
        if (
          event.event !== "plugin.approval.requested" ||
          payload?.request?.toolName !== "approval_hook_probe" ||
          typeof payload.id !== "string"
        ) {
          return;
        }
        void reviewer
          .request("plugin.approval.resolve", { id: payload.id, decision })
          .then(() => decided.resolve(), decided.reject);
      },
      timeoutMs: 60_000,
    });
    const invoke = () =>
      caller.request("tools.invoke", {
        name: "approval_hook_probe",
        agentId: "main",
        sessionKey: "main",
        args: {},
        confirm: true,
      });
    try {
      const allowed = await invoke();
      expect(allowed).toMatchObject({
        ok: true,
        output: { content: [{ type: "text", text: "HOOK_EXECUTED" }] },
      });
      await decided.promise;
      expect(await fs.readFile(hookExecutionPath, "utf8")).toBe("executed\n");

      decision = "deny";
      decided = createDeferredCore();
      const denied = await invoke();
      expect(denied).toMatchObject({ ok: false, requiresApproval: true });
      await decided.promise;
      expect(await fs.readFile(hookExecutionPath, "utf8")).toBe("executed\n");
    } finally {
      await disconnectGatewayClient(reviewer);
      await disconnectGatewayClient(caller);
    }
  });
});
