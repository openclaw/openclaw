import path from "node:path";
// Proves the plugin approval lifecycle through authenticated Gateway WebSockets.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_CLIENT_CAPS } from "../../../../packages/gateway-protocol/src/client-info.js";
import { ADMIN_SCOPE, APPROVALS_SCOPE } from "../../../../src/gateway/method-scopes.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
} from "../../../../src/gateway/test-helpers.e2e.js";
import {
  getGatewayTestPort,
  installGatewayTestHooks,
  startTestGatewayServer,
} from "../../../../src/gateway/test-helpers.js";
import { loadOrCreateDeviceIdentity } from "../../../../src/infra/device-identity.js";
import { setLoggerOverride } from "../../../../src/logging.js";

type Cleanup = () => Promise<void> | void;

type ApprovalEvent = {
  event?: string;
  payload?: unknown;
};

type ApprovalRecord = {
  id: string;
  request: {
    allowedDecisions?: string[];
    pluginId?: string | null;
  };
};

type ApprovalDecision = {
  createdAtMs: number;
  decision: string;
  expiresAtMs: number;
  id: string;
  terminalReason: string | null;
};

const requireRecord = createRequireRecord("record", "expected-label");

installGatewayTestHooks({ scope: "suite" });

describe("gateway plugin approvals QA", () => {
  const cleanup: Cleanup[] = [];

  afterEach(async () => {
    for (const step of cleanup.splice(0).toReversed()) {
      await step();
    }
  });

  it("delivers a generated request to a distinct reviewer and resolves one terminal decision", async () => {
    // Keep normal test logs quiet while exposing the existing ws-control
    // handshake phase if this real connection fails before hello-ok.
    setLoggerOverride({ level: "silent", consoleLevel: "warn", consoleStyle: "compact" });

    const stateDir = process.env.OPENCLAW_STATE_DIR;
    if (!stateDir) {
      throw new Error("OPENCLAW_STATE_DIR is required for gateway QA fixtures");
    }
    const reviewerIdentity = loadOrCreateDeviceIdentity({
      path: path.join(stateDir, "test-device-identities", "plugin-approval-reviewer.sqlite"),
    });
    const requesterIdentity = loadOrCreateDeviceIdentity({
      path: path.join(stateDir, "test-device-identities", "plugin-approval-requester.sqlite"),
    });
    expect(reviewerIdentity.deviceId).not.toBe(requesterIdentity.deviceId);

    const port = await getGatewayTestPort();
    const token = "gateway-plugin-approvals-qa-token";
    const url = `ws://127.0.0.1:${port}`;
    const server = await startTestGatewayServer(port, {
      bind: "loopback",
      auth: { mode: "token", token },
      controlUiEnabled: false,
      sidecarStartup: "defer",
    });
    cleanup.push(() => server.close());

    const approvalEvents: ApprovalEvent[] = [];
    const waitForEvent = async (name: string) => {
      const matches = () => approvalEvents.filter((event) => event.event === name);
      await vi.waitFor(() => expect(matches()).toHaveLength(1));
      return requireRecord(matches()[0]?.payload, name);
    };
    const reviewer = await connectGatewayClient({
      url,
      token,
      clientDisplayName: "plugin approval reviewer",
      scopes: [ADMIN_SCOPE],
      caps: [GATEWAY_CLIENT_CAPS.APPROVALS],
      deviceIdentity: reviewerIdentity,
      onEvent: (event) => {
        if (
          event.event === "plugin.approval.requested" ||
          event.event === "plugin.approval.resolved"
        ) {
          approvalEvents.push(event);
        }
      },
      timeoutMs: 60_000,
    });
    cleanup.push(() => disconnectGatewayClient(reviewer));

    const requester = await connectGatewayClient({
      url,
      token,
      clientDisplayName: "plugin approval requester",
      scopes: [APPROVALS_SCOPE],
      deviceIdentity: requesterIdentity,
      timeoutMs: 60_000,
    });
    cleanup.push(() => disconnectGatewayClient(requester));

    const accepted = await requester.request<{
      deliveryRoute: string;
      id: string;
      status: string;
    }>("plugin.approval.request", {
      pluginId: "qa-plugin",
      title: "Allow fixture mutation",
      description: "The QA fixture requests one bounded mutation.",
      allowedDecisions: ["allow-once"],
      twoPhase: true,
      timeoutMs: 30_000,
    });
    expect(accepted).toMatchObject({
      status: "accepted",
      deliveryRoute: "approval-client",
    });
    expect(accepted.id).toMatch(/^plugin:[0-9a-f-]{36}$/);

    const request = {
      id: accepted.id,
      request: { pluginId: "qa-plugin", allowedDecisions: ["allow-once", "deny"] },
    };
    expect(await waitForEvent("plugin.approval.requested")).toMatchObject(request);
    const pending = await reviewer.request<ApprovalRecord[]>("plugin.approval.list", {});
    expect(pending).toEqual([
      expect.objectContaining({ ...request, request: expect.objectContaining(request.request) }),
    ]);
    let waitSettled = false;
    const waitDecision = requester
      .request<ApprovalDecision>(
        "plugin.approval.waitDecision",
        { id: accepted.id },
        { timeoutMs: 10_000 },
      )
      .finally(() => {
        waitSettled = true;
      });
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
    expect(waitSettled).toBe(false);

    await expect(
      reviewer.request("plugin.approval.resolve", {
        id: accepted.id,
        decision: "allow-once",
      }),
    ).resolves.toEqual({ ok: true });

    const terminalDecision = await waitDecision;
    const decision = { id: accepted.id, decision: "allow-once" };
    expect(terminalDecision).toMatchObject({
      ...decision,
      createdAtMs: expect.any(Number),
      expiresAtMs: expect.any(Number),
      terminalReason: "user",
    });
    const resolved = await waitForEvent("plugin.approval.resolved");
    expect({ id: resolved.id, decision: resolved.decision }).toEqual(decision);
    expect(terminalDecision.expiresAtMs).toBeGreaterThan(terminalDecision.createdAtMs);

    await expect(reviewer.request<ApprovalRecord[]>("plugin.approval.list", {})).resolves.toEqual(
      [],
    );
  }, 120_000);
});
