import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { expect, vi } from "vitest";
import { GATEWAY_CLIENT_CAPS } from "../../../../packages/gateway-protocol/src/client-info.js";
import { ADMIN_SCOPE, APPROVALS_SCOPE } from "../../../../src/gateway/method-scopes.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
} from "../../../../src/gateway/test-helpers.e2e.js";
import {
  getGatewayTestPort,
  startTestGatewayServer,
} from "../../../../src/gateway/test-helpers.js";
import { loadOrCreateDeviceIdentity } from "../../../../src/infra/device-identity.js";
import { setLoggerOverride } from "../../../../src/logging.js";

type Approval = {
  id: string;
  request: { command?: string; pluginId?: string | null; allowedDecisions?: string[] };
};
type Decision = {
  id: string;
  decision: string;
  createdAtMs: number;
  expiresAtMs: number;
  terminalReason: string | null;
};
const requireRecord = createRequireRecord("record", "expected-label");

export async function runApprovalProof(
  kind: "exec" | "plugin",
  onTestFinished: (cleanup: () => Promise<void>) => void,
) {
  const plugin = kind === "plugin";
  if (plugin) {
    setLoggerOverride({ level: "silent", consoleLevel: "warn", consoleStyle: "compact" });
  }
  const stateDir = process.env.OPENCLAW_STATE_DIR;
  if (!stateDir) {
    throw new Error("OPENCLAW_STATE_DIR is required for gateway QA fixtures");
  }
  const port = await getGatewayTestPort();
  const token = `gateway-${kind}-approvals-qa-token`;
  const server = await startTestGatewayServer(port, {
    bind: "loopback",
    auth: { mode: "token", token },
    controlUiEnabled: false,
    sidecarStartup: "defer",
  });
  onTestFinished(() => server.close());
  const events: Array<{ event?: string; payload?: unknown }> = [];
  const waitForEvent = async (name: string) => {
    const matches = () => events.filter((event) => event.event === name);
    await vi.waitFor(() => expect(matches()).toHaveLength(1));
    return requireRecord(matches()[0]?.payload, name);
  };
  const identityRoot = path.join(stateDir, "test-device-identities");
  const connect = async (name: "requester" | "reviewer") => {
    const receivesEvents = plugin && name === "reviewer";
    const identity = loadOrCreateDeviceIdentity({
      path: path.join(identityRoot, `${kind}-${name}`, "client", "credentials.sqlite"),
    });
    const client = await connectGatewayClient({
      url: `ws://127.0.0.1:${port}`,
      token,
      scopes: [name === "reviewer" ? ADMIN_SCOPE : APPROVALS_SCOPE],
      clientDisplayName: `${kind} approval ${name}`,
      deviceIdentity: identity,
      timeoutMs: 60_000,
      caps: receivesEvents ? [GATEWAY_CLIENT_CAPS.APPROVALS] : undefined,
      onEvent: receivesEvents
        ? (event) => {
            if (
              event.event === "plugin.approval.requested" ||
              event.event === "plugin.approval.resolved"
            ) {
              events.push(event);
            }
          }
        : undefined,
    });
    onTestFinished(() => disconnectGatewayClient(client));
    return { client, identity };
  };
  // Keep each proof's connection order: plugin delivery needs a reviewer first.
  const first = await connect(plugin ? "reviewer" : "requester");
  const second = await connect(plugin ? "requester" : "reviewer");
  const reviewer = plugin ? first : second;
  const requester = plugin ? second : first;
  expect(reviewer.identity.deviceId).not.toBe(requester.identity.deviceId);
  const method = (action: string) => `${kind}.approval.${action}`;
  const listingClient = plugin ? reviewer.client : requester.client;
  const list = () => listingClient.request<Approval[]>(method("list"), {});
  const accepted = await requester.client.request<{
    id: string;
    status: string;
    deliveryRoute?: string;
  }>(method("request"), {
    ...(!plugin
      ? {
          id: "gateway-exec-approvals-qa",
          command: "printf gateway-qa",
          commandArgv: ["printf", "gateway-qa"],
          cwd: "/tmp",
          host: "gateway",
          ask: "always",
          requireDeliveryRoute: false,
        }
      : {
          pluginId: "qa-plugin",
          title: "Allow fixture mutation",
          description: "The QA fixture requests one bounded mutation.",
          allowedDecisions: ["allow-once"],
        }),
    twoPhase: true,
    timeoutMs: plugin ? 30_000 : 60_000,
  });
  expect(accepted).toMatchObject({
    status: "accepted",
    id: plugin ? expect.stringMatching(/^plugin:[0-9a-f-]{36}$/) : "gateway-exec-approvals-qa",
    ...(plugin ? { deliveryRoute: "approval-client" } : {}),
  });
  const expected = expect.objectContaining({
    id: accepted.id,
    request: expect.objectContaining(
      !plugin
        ? { command: "printf gateway-qa" }
        : { pluginId: "qa-plugin", allowedDecisions: ["allow-once", "deny"] },
    ),
  });
  if (plugin) {
    expect(await waitForEvent("plugin.approval.requested")).toEqual(expected);
  }
  const pending = await list();
  if (!plugin) {
    expect(pending).toContainEqual(expected);
    await expect(
      requester.client.request(method("get"), { id: accepted.id }),
    ).resolves.toMatchObject({
      id: accepted.id,
      commandText: "printf gateway-qa",
      host: "gateway",
      nodeId: null,
      agentId: null,
    });
  } else {
    expect(pending).toEqual([expected]);
  }
  let settled = false;
  const wait = requester.client
    .request<Decision>(method("waitDecision"), { id: accepted.id }, { timeoutMs: 10_000 })
    .finally(() => {
      settled = true;
    });
  await delay(25);
  expect(settled).toBe(false);
  const decision = { id: accepted.id, decision: "allow-once" };
  await expect(reviewer.client.request(method("resolve"), decision)).resolves.toEqual({ ok: true });
  const terminal = await wait;
  expect(terminal).toMatchObject(decision);
  const remaining = await list();
  if (!plugin) {
    expect(remaining.map((entry) => entry.id)).not.toContain(accepted.id);
    await expect(requester.client.request(method("get"), { id: accepted.id })).rejects.toThrow(
      "unknown or expired approval id",
    );
  } else {
    expect(terminal).toMatchObject({
      createdAtMs: expect.any(Number),
      expiresAtMs: expect.any(Number),
      terminalReason: "user",
    });
    const resolved = await waitForEvent("plugin.approval.resolved");
    expect({ id: resolved.id, decision: resolved.decision }).toEqual(decision);
    expect(terminal.expiresAtMs).toBeGreaterThan(terminal.createdAtMs);
    expect(remaining).toEqual([]);
  }
}
