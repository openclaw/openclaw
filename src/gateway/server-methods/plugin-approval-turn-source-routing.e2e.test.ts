// Gateway e2e proof: real delivery routes change approval response behavior.
//
// Without turn-source fields: plugin.approval.request expires immediately with
// {decision: null} because there is no approval client and no turn-source route.
//
// With a connected authorized approval-capable client: the approval stays alive and
// returns {status: "accepted"} because it has a real delivery route.
//
// This test runs against a real gateway server with no Telegram required.
import { X509Certificate } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GATEWAY_CLIENT_CAPS } from "../../../packages/gateway-protocol/src/client-info.js";
import { TEST_TLS_CERT_PEM, TEST_TLS_KEY_PEM } from "../../../test/helpers/tls-fixture.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../../config/config.js";
import { clearSessionStoreCacheForTest } from "../../config/sessions/store-writer-state.js";
import type { GatewayAuthConfig } from "../../config/types.gateway.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { setUserProfileRole } from "../../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../../test-utils/env.js";
import { prepareUserProfileCatalogForTest } from "../../test-utils/user-profile-catalog.js";
import { ADMIN_SCOPE, APPROVALS_SCOPE, READ_SCOPE, WRITE_SCOPE } from "../method-scopes.js";
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
const CREATOR_EMAIL = "creator@approval-route.example.test";
const OTHER_EMAIL = "other@approval-route.example.test";
const ADMIN_EMAIL = "admin@approval-route.example.test";
const ORIGIN = "https://control.example.test";

describe("plugin.approval.request delivery routing (real gateway)", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;
  let tempHome: string;
  let hookExecutionPath: string;
  let url: string;
  let tlsFingerprint: string;
  let releaseProfileCatalog: (() => void) | undefined;
  let server: Awaited<ReturnType<typeof startGatewayServer>>;
  let requester: Awaited<ReturnType<typeof connectGatewayClient>>;
  let toolCaller: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;
  let approvalClient: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;

  function connection(scopes: string[], email = CREATOR_EMAIL) {
    return {
      url,
      tlsFingerprint,
      origin: ORIGIN,
      clientName: "openclaw-control-ui" as const,
      mode: "webchat" as const,
      scopes,
      edgeAuthHeaders: {
        "x-forwarded-user": email,
        "x-forwarded-for": "203.0.113.50",
        "x-forwarded-proto": "https",
        "x-openclaw-scopes": scopes.join(","),
      },
    };
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
    releaseProfileCatalog = (await prepareUserProfileCatalogForTest()).release;
    for (const email of [CREATOR_EMAIL, OTHER_EMAIL]) {
      setUserProfileRole(ensureProfileForEmail(email).id, "member");
    }
    setUserProfileRole(ensureProfileForEmail(ADMIN_EMAIL).id, "administrator");
    const memberScopes = [READ_SCOPE, WRITE_SCOPE, APPROVALS_SCOPE];
    const auth = {
      mode: "trusted-proxy",
      // The hook's local approval-runtime bridge connects without browser proxy headers.
      password: "approval-route-local-runtime-password",
      trustedProxy: {
        userHeader: "x-forwarded-user",
        requiredHeaders: ["x-forwarded-proto", "x-openclaw-scopes"],
        allowUsers: [CREATOR_EMAIL, OTHER_EMAIL, ADMIN_EMAIL],
        allowLoopback: true,
        deviceAutoApprove: { enabled: true, scopes: [ADMIN_SCOPE, ...memberScopes] },
      },
    } satisfies GatewayAuthConfig;
    const certPath = path.join(tempHome, "cert.pem");
    const keyPath = path.join(tempHome, "key.pem");
    await fs.writeFile(certPath, TEST_TLS_CERT_PEM);
    await fs.writeFile(keyPath, TEST_TLS_KEY_PEM);
    tlsFingerprint = new X509Certificate(TEST_TLS_CERT_PEM).fingerprint256;
    await fs.writeFile(
      configPath,
      JSON.stringify({
        gateway: {
          auth,
          tls: { enabled: true, autoGenerate: false, certPath, keyPath },
          trustedProxies: ["127.0.0.1", "::1"],
          controlUi: { allowedOrigins: [ORIGIN] },
          roles: {
            default: "member",
            definitions: {
              member: {
                agents: ["main"],
                scopes: memberScopes,
                sessions: { others: "write" },
              },
              administrator: {
                agents: "*",
                scopes: [ADMIN_SCOPE],
                sessions: { others: "write" },
              },
            },
          },
        },
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
    url = `wss://127.0.0.1:${claim.port}`;
    setTestEnvValue("OPENCLAW_GATEWAY_PORT", String(claim.port));

    server = await startClaimedGateway(claim, () =>
      startGatewayServer(claim.port, {
        bind: "loopback",
        auth,
        controlUiEnabled: false,
        sidecarStartup: "defer",
      }),
    );
    await server.startupSettled;

    // Scope alone does not advertise an approval delivery route; the requester has no cap.
    requester = await connectGatewayClient({
      ...connection([WRITE_SCOPE, APPROVALS_SCOPE]),
      clientDisplayName: "plugin-approval requester",
      requestTimeoutMs: 10_000,
      timeoutMs: 60_000,
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
    releaseProfileCatalog?.();
    releaseProfileCatalog = undefined;
    await fs.rm(tempHome, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
    envSnapshot.restore();
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    clearSessionStoreCacheForTest();
  });

  // The E2E setup retires active plugins after each `it`, so each test owns a fresh Gateway.
  it("expires with decision:null when no turn-source route and no approval client", async () => {
    // Without turn-source fields or an authorized approval client, no delivery route exists.
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

  it("returns accepted for a sessionless request when an administrator reviewer is connected", async () => {
    approvalClient = await connectGatewayClient({
      ...connection([ADMIN_SCOPE], ADMIN_EMAIL),
      clientDisplayName: "sessionless administrator reviewer",
      caps: [GATEWAY_CLIENT_CAPS.APPROVALS],
      timeoutMs: 60_000,
    });

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

  it("routes a plugin tool approval to its authenticated session creator", async () => {
    if (approvalClient) {
      await disconnectGatewayClient(approvalClient);
      approvalClient = undefined;
    }
    toolCaller = await connectGatewayClient({
      ...connection([WRITE_SCOPE]),
      clientDisplayName: "write-only plugin tool caller",
      timeoutMs: 60_000,
    });
    await expect(toolCaller.request("plugin.approval.list", {})).rejects.toThrow(
      "missing scope: operator.approvals",
    );
    const { key: sessionKey } = await toolCaller.request<{ key: string }>("sessions.create", {
      agentId: "main",
      visibility: "shared",
    });
    const decided = createDeferredCore();
    // The reviewer shares the caller's authenticated profile and host-selected device.
    const reviewer = await connectGatewayClient({
      ...connection([APPROVALS_SCOPE]),
      clientDisplayName: "same-device reviewer",
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
        sessionKey,
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
      { ...connection([APPROVALS_SCOPE], OTHER_EMAIL), deviceFamily: "other-device" },
      connection([READ_SCOPE]),
    ]) {
      let receivedRequests = 0;
      const untrusted = await connectGatewayClient({
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
          sessionKey,
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
      ...connection([WRITE_SCOPE]),
      clientDisplayName: "write-only hook caller",
      requestTimeoutMs: 15_000,
      timeoutMs: 60_000,
    });
    await expect(caller.request("plugin.approval.list", {})).rejects.toThrow(
      "missing scope: operator.approvals",
    );
    const { key: sessionKey } = await caller.request<{ key: string }>("sessions.create", {
      agentId: "main",
      visibility: "shared",
    });
    let decision: "allow-once" | "deny" = "allow-once";
    let decided = createDeferredCore();
    const reviewer = await connectGatewayClient({
      ...connection([APPROVALS_SCOPE]),
      clientDisplayName: "same-device hook reviewer",
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
        sessionKey,
        args: {},
        confirm: true,
      });
    try {
      const allowed = await invoke();
      expect(allowed, JSON.stringify(allowed)).toMatchObject({
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
