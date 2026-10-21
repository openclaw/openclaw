import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { expect, it, vi } from "vitest";
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

it("delivers a generated request to a distinct reviewer and resolves one terminal decision", async ({
  onTestFinished,
}) => {
  // Keep normal test logs quiet while exposing the existing ws-control
  // handshake phase if this real connection fails before hello-ok.
  setLoggerOverride({ level: "silent", consoleLevel: "warn", consoleStyle: "compact" });

  const stateDir = process.env.OPENCLAW_STATE_DIR;
  if (!stateDir) {
    throw new Error("OPENCLAW_STATE_DIR is required for gateway QA fixtures");
  }
  const port = await getGatewayTestPort();
  const token = "gateway-plugin-approvals-qa-token";
  const url = `ws://127.0.0.1:${port}`;
  const server = await startTestGatewayServer(port, {
    bind: "loopback",
    auth: { mode: "token", token },
    controlUiEnabled: false,
    sidecarStartup: "defer",
  });
  onTestFinished(() => server.close());

  const approvalEvents: ApprovalEvent[] = [];
  const waitForEvent = async (name: string) => {
    const matches = () => approvalEvents.filter((event) => event.event === name);
    await vi.waitFor(() => expect(matches()).toHaveLength(1));
    return requireRecord(matches()[0]?.payload, name);
  };
  const connect = async (
    name: string,
    scopes: string[],
    options: Pick<Parameters<typeof connectGatewayClient>[0], "caps" | "onEvent"> = {},
  ) => {
    const identity = loadOrCreateDeviceIdentity({
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: path.join(stateDir, "test-device-identities", name),
      },
    });
    const client = await connectGatewayClient({
      url,
      token,
      scopes,
      ...options,
      clientDisplayName: `plugin approval ${name}`,
      deviceIdentity: identity,
      timeoutMs: 60_000,
    });
    onTestFinished(() => disconnectGatewayClient(client));
    return { client, identity };
  };
  const { client: reviewer, identity: reviewerIdentity } = await connect(
    "reviewer",
    [ADMIN_SCOPE],
    {
      caps: [GATEWAY_CLIENT_CAPS.APPROVALS],
      onEvent: (event) => {
        if (
          event.event === "plugin.approval.requested" ||
          event.event === "plugin.approval.resolved"
        ) {
          approvalEvents.push(event);
        }
      },
    },
  );
  const { client: requester, identity: requesterIdentity } = await connect("requester", [
    APPROVALS_SCOPE,
  ]);
  expect(reviewerIdentity.deviceId).not.toBe(requesterIdentity.deviceId);

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
    id: expect.stringMatching(/^plugin:[0-9a-f-]{36}$/),
    status: "accepted",
    deliveryRoute: "approval-client",
  });

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
  await delay(25);
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

  await expect(reviewer.request<ApprovalRecord[]>("plugin.approval.list", {})).resolves.toEqual([]);
}, 120_000);
