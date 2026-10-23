import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ApprovalGetResult,
  type ApprovalHistoryResult,
  type ApprovalResolveResult,
  validateApprovalGetResult,
  validateApprovalHistoryResult,
  validateApprovalResolveResult,
} from "../../packages/gateway-protocol/src/index.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../config/config.js";
import { clearSessionStoreCacheForTest } from "../config/sessions/store-writer-state.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
import { ADMIN_SCOPE, APPROVALS_SCOPE, READ_SCOPE } from "./method-scopes.js";
import { withOperatorApprovalsGatewayClient } from "./operator-approvals-client.js";
import { startGatewayServer } from "./server.js";
import { connectGatewayClient, disconnectGatewayClient } from "./test-helpers.e2e.js";
import { acquireGatewayE2ePortBlock, startClaimedGateway } from "./test-helpers.listener.js";
import {
  configureManualGatewayBackgroundEnv,
  MANUAL_GATEWAY_ENV_KEYS,
} from "./test-helpers.manual-gateway-env.js";

const TEST_ENV_KEYS = [
  "HOME",
  ...MANUAL_GATEWAY_ENV_KEYS,
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_GATEWAY_URL",
  "OPENCLAW_GATEWAY_TOKEN",
  "OPENCLAW_GATEWAY_PASSWORD",
];

type Cleanup = () => Promise<void> | void;
type Client = Awaited<ReturnType<typeof connectGatewayClient>>;

async function requestExecApproval(requester: Client, id: string): Promise<void> {
  await expect(
    requester.request("exec.approval.request", {
      id,
      command: "printf smoke",
      cwd: "/tmp",
      host: "local",
      ask: "always",
      twoPhase: true,
      // Devices resolve by ID, without a legacy event-delivery route.
      requireDeliveryRoute: false,
      timeoutMs: 60_000,
    }),
  ).resolves.toMatchObject({ status: "accepted", id });
}

describe("operator approval gateway client e2e", () => {
  const cleanup: Cleanup[] = [];

  afterEach(async () => {
    for (const step of cleanup.splice(0).toReversed()) {
      await step();
    }
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    clearSessionStoreCacheForTest();
  });

  async function gatewayFixture(prefix: string) {
    const envSnapshot = captureEnv(TEST_ENV_KEYS);
    cleanup.push(() => envSnapshot.restore());
    for (const key of [
      "OPENCLAW_CONFIG_PATH",
      "OPENCLAW_GATEWAY_URL",
      "OPENCLAW_GATEWAY_TOKEN",
      "OPENCLAW_GATEWAY_PASSWORD",
    ]) {
      deleteTestEnvValue(key);
    }

    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    cleanup.push(() => fs.rm(tempHome, { recursive: true, force: true, maxRetries: 5 }));

    const stateDir = path.join(tempHome, ".openclaw");
    await fs.mkdir(stateDir, { recursive: true });
    setTestEnvValue("HOME", tempHome);
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    configureManualGatewayBackgroundEnv(tempHome);

    const claim = await acquireGatewayE2ePortBlock();
    const token = "approval-e2e-token";
    const url = `ws://127.0.0.1:${claim.port}`;
    setTestEnvValue("OPENCLAW_GATEWAY_PORT", String(claim.port));

    const server = await startClaimedGateway(claim, () =>
      startGatewayServer(claim.port, {
        bind: "loopback",
        auth: { mode: "token", token },
        controlUiEnabled: false,
        sidecarStartup: "defer",
      }),
    );
    cleanup.push(() => server.close());

    const localConfig = {
      gateway: {
        port: claim.port,
        auth: { mode: "token", token },
      },
    } satisfies OpenClawConfig;
    const connect = async (
      scopes: string[] = [APPROVALS_SCOPE],
      deviceIdentity?: ReturnType<typeof loadOrCreateDeviceIdentity>,
    ) => {
      const client = await connectGatewayClient({
        url,
        token,
        clientDisplayName: "approval test device",
        scopes,
        ...(deviceIdentity ? { deviceIdentity } : {}),
        timeoutMs: 60_000,
      });
      cleanup.push(() => disconnectGatewayClient(client));
      return client;
    };
    return { stateDir, url, localConfig, connect };
  }

  it("uses runtime authority only for generated local gateway URLs", async () => {
    const { url, localConfig, connect } = await gatewayFixture("openclaw-approval-client-e2e-");
    const admin = await connect([ADMIN_SCOPE]);
    const requester = await connect();
    const resolve = (config: OpenClawConfig, id: string) =>
      withOperatorApprovalsGatewayClient(
        { config, clientDisplayName: "approval resolver" },
        async (client) => {
          await client.request(
            "exec.approval.resolve",
            { id, decision: "allow-once" },
            { timeoutMs: 10_000 },
          );
        },
      );

    await requestExecApproval(requester, "local-source-approval");
    await resolve(localConfig, "local-source-approval");

    const remoteLoopbackConfig = {
      gateway: {
        mode: "remote",
        remote: { url },
        auth: localConfig.gateway.auth,
      },
    } satisfies OpenClawConfig;

    await requestExecApproval(requester, "remote-loopback-approval");
    await expect(resolve(remoteLoopbackConfig, "remote-loopback-approval")).rejects.toMatchObject({
      gatewayCode: "INVALID_REQUEST",
      details: { reason: "APPROVAL_NOT_FOUND" },
    });

    await admin.request(
      "exec.approval.resolve",
      { id: "remote-loopback-approval", decision: "deny" },
      { timeoutMs: 10_000 },
    );
  }, 120_000);

  it("resolves one approval from distinct devices with first-answer-wins semantics", async () => {
    const { stateDir, connect } = await gatewayFixture("openclaw-approval-surfaces-e2e-");
    const identity = (role: string) =>
      loadOrCreateDeviceIdentity({
        path: path.join(
          stateDir,
          "test-device-identities",
          `approval-${role}`,
          "client",
          "credentials.sqlite",
        ),
      });
    const requesterIdentity = identity("requester");
    const reviewerIdentity = identity("reviewer");
    const underscopedIdentity = identity("underscoped");
    expect(requesterIdentity.deviceId).not.toBe(reviewerIdentity.deviceId);

    const requester = await connect([APPROVALS_SCOPE], requesterIdentity);
    const reviewer = await connect([APPROVALS_SCOPE], reviewerIdentity);
    const underscoped = await connect([READ_SCOPE], underscopedIdentity);

    const approvalId = "multi-surface-first-answer-wins";
    await requestExecApproval(requester, approvalId);
    const get = async (client: Client) => {
      const result = await client.request<ApprovalGetResult>("approval.get", { id: approvalId });
      expect(validateApprovalGetResult(result)).toBe(true);
      return result.approval;
    };
    const resolve = async (client: Client, decision: "allow-once" | "deny") => {
      const result = await client.request<ApprovalResolveResult>("approval.resolve", {
        id: approvalId,
        kind: "exec",
        decision,
      });
      expect(validateApprovalResolveResult(result)).toBe(true);
      return result;
    };

    expect(await get(reviewer)).toMatchObject({
      id: approvalId,
      status: "pending",
      presentation: { kind: "exec" },
    });

    for (const [method, params] of [
      ["approval.get", { id: approvalId }],
      ["approval.history", {}],
      ["approval.resolve", { id: approvalId, kind: "exec", decision: "deny" }],
    ] as const) {
      await expect(underscoped.request(method, params)).rejects.toThrow(
        "missing scope: operator.approvals",
      );
    }
    expect((await get(reviewer)).status).toBe("pending");

    const [allowResult, denyResult] = await Promise.all([
      resolve(requester, "allow-once"),
      resolve(reviewer, "deny"),
    ]);
    expect([allowResult.applied, denyResult.applied].filter(Boolean)).toHaveLength(1);
    expect(allowResult.approval).toEqual(denyResult.approval);

    const winningDecision = allowResult.approval.status === "allowed" ? "allow-once" : "deny";
    expect(allowResult.approval).toMatchObject({
      id: approvalId,
      status: winningDecision === "deny" ? "denied" : "allowed",
      decision: winningDecision,
    });

    const replay = await resolve(reviewer, winningDecision);
    expect(replay).toEqual({ applied: false, approval: allowResult.approval });

    expect(await get(requester)).toEqual(allowResult.approval);

    const history = await reviewer.request<ApprovalHistoryResult>("approval.history", {
      limit: 10,
    });
    expect(validateApprovalHistoryResult(history)).toBe(true);
    expect(history.items).toContainEqual(allowResult.approval);
  }, 120_000);
});
