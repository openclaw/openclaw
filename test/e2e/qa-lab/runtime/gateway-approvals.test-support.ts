import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { expect, vi } from "vitest";
import { GATEWAY_CLIENT_CAPS } from "../../../../packages/gateway-protocol/src/client-info.js";
import type { ExecApprovalsSnapshot } from "../../../../packages/gateway-protocol/src/index.js";
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
import { readExecApprovalsSocket } from "../../../../src/infra/exec-approvals-socket.js";
import { readExecApprovalsSnapshot } from "../../../../src/infra/exec-approvals.js";
import { setLoggerOverride } from "../../../../src/logging.js";

type Client = Awaited<ReturnType<typeof connectGatewayClient>>;
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

async function expectPolicyRoundTrip(reviewer: Client) {
  const initial = await reviewer.request<ExecApprovalsSnapshot>("exec.approvals.get", {});
  const stored = readExecApprovalsSnapshot();
  const socket = await readExecApprovalsSocket();
  expect(socket?.socket_token).toMatch(/^[A-Za-z0-9_-]{32}$/);
  expect(stored.file.socket?.token).toBeUndefined();
  expect(initial).toMatchObject({
    exists: true,
    hash: stored.hash,
    file: { version: 1, socket: { path: socket?.socket_path } },
  });
  expect(initial.file.socket).not.toHaveProperty("token");
  const replacement = {
    version: 1 as const,
    defaults: { security: "allowlist", ask: "always", askFallback: "deny", autoAllowSkills: false },
    agents: { main: { allowlist: [{ pattern: "printf gateway-qa" }] } },
  };
  const updated = await reviewer.request<ExecApprovalsSnapshot>("exec.approvals.set", {
    baseHash: initial.hash,
    file: replacement,
  });
  expect(updated.hash).not.toBe(initial.hash);
  expect(updated.file).toMatchObject({ ...replacement, socket: { path: socket?.socket_path } });
  expect(updated.file.socket).not.toHaveProperty("token");
  expect((await readExecApprovalsSocket())?.socket_token).toBe(socket?.socket_token);
  await expect(
    reviewer.request("exec.approvals.set", {
      baseHash: initial.hash,
      file: { ...replacement, defaults: { ...replacement.defaults, security: "deny" } },
    }),
  ).rejects.toThrow("exec approvals changed since last load");
  await expect(reviewer.request("exec.approvals.get", {})).resolves.toEqual(updated);
}

export async function runApprovalProof(
  kind: "exec" | "plugin",
  onTestFinished: (cleanup: () => Promise<void>) => void,
) {
  if (kind === "plugin") {
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
  const connect = async (name: string, scope: string) => {
    const identity = loadOrCreateDeviceIdentity({
      path: path.join(
        stateDir,
        "test-device-identities",
        `${kind}-${name}`,
        "client",
        "credentials.sqlite",
      ),
    });
    const client = await connectGatewayClient({
      url: `ws://127.0.0.1:${port}`,
      token,
      scopes: [scope],
      clientDisplayName: `${kind} approval ${name}`,
      deviceIdentity: identity,
      timeoutMs: 60_000,
      ...(kind === "plugin" && name === "reviewer"
        ? {
            caps: [GATEWAY_CLIENT_CAPS.APPROVALS],
            onEvent: (event: { event?: string; payload?: unknown }) => {
              if (
                event.event === "plugin.approval.requested" ||
                event.event === "plugin.approval.resolved"
              ) {
                events.push(event);
              }
            },
          }
        : {}),
    });
    onTestFinished(() => disconnectGatewayClient(client));
    return { client, identity };
  };
  // Keep each proof's connection order: plugin delivery needs a reviewer first.
  const connections = new Map<string, Awaited<ReturnType<typeof connect>>>();
  for (const name of kind === "plugin" ? ["reviewer", "requester"] : ["requester", "reviewer"]) {
    connections.set(name, await connect(name, name === "reviewer" ? ADMIN_SCOPE : APPROVALS_SCOPE));
  }
  const requester = connections.get("requester")!;
  const reviewer = connections.get("reviewer")!;
  expect(reviewer.identity.deviceId).not.toBe(requester.identity.deviceId);
  if (kind === "exec") {
    await expectPolicyRoundTrip(reviewer.client);
  }
  const method = (action: string) => `${kind}.approval.${action}`;
  const accepted = await requester.client.request<{
    id: string;
    status: string;
    deliveryRoute?: string;
  }>(method("request"), {
    ...(kind === "exec"
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
    timeoutMs: kind === "exec" ? 60_000 : 30_000,
  });
  expect(accepted).toMatchObject(
    kind === "exec"
      ? { id: "gateway-exec-approvals-qa", status: "accepted" }
      : {
          id: expect.stringMatching(/^plugin:[0-9a-f-]{36}$/),
          status: "accepted",
          deliveryRoute: "approval-client",
        },
  );
  const request = {
    id: accepted.id,
    request:
      kind === "exec"
        ? { command: "printf gateway-qa" }
        : {
            pluginId: "qa-plugin",
            allowedDecisions: ["allow-once", "deny"],
          },
  };
  if (kind === "plugin") {
    expect(await waitForEvent("plugin.approval.requested")).toMatchObject(request);
  }
  const pending = await (kind === "exec" ? requester.client : reviewer.client).request<Approval[]>(
    method("list"),
    {},
  );
  const expected = expect.objectContaining({
    ...request,
    request: expect.objectContaining(request.request),
  });
  if (kind === "exec") {
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
  const remaining = await (kind === "exec" ? requester.client : reviewer.client).request<
    Approval[]
  >(method("list"), {});
  if (kind === "exec") {
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
