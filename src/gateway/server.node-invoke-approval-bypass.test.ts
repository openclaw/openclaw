import crypto from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import type { WebSocket } from "ws";
import { writeConfigFile } from "../config/config.js";
import type { DeviceIdentity } from "../infra/device-identity.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import type { GatewayClient } from "./client.js";
import {
  issueOperatorToken,
  loadDeviceIdentity,
  openTrackedWs,
} from "./device-authz.test-helpers.js";
import { connectGatewayClient } from "./test-helpers.e2e.js";
import {
  connectReq,
  installGatewayTestHooks,
  rpcReq,
  startServerWithClient,
} from "./test-helpers.js";
import { acknowledgeNodeInvokeRequestForTest } from "./test-helpers.node-invoke.js";

installGatewayTestHooks({ scope: "suite" });

function createDeviceIdentity(): DeviceIdentity {
  return loadDeviceIdentity(`invoke-node-${crypto.randomUUID()}`).identity;
}

async function expectNoForwardedInvoke(hasInvoke: () => boolean): Promise<void> {
  // Yield a couple of macrotasks so any accidental async forwarding would fire.
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  expect(hasInvoke()).toBe(false);
}

function parseInvokeParamsJSON(payload: unknown): Record<string, unknown> | null {
  const obj = payload as { paramsJSON?: unknown };
  const raw = typeof obj?.paramsJSON === "string" ? obj.paramsJSON : "";
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
}

function createInvokeParamCapture() {
  let invokeCount = 0;
  let lastInvokeParams: Record<string, unknown> | null = null;
  return {
    count: () => invokeCount,
    onInvoke: (payload: unknown) => {
      invokeCount += 1;
      lastInvokeParams = parseInvokeParamsJSON(payload);
    },
    params: () => requireValue(lastInvokeParams, "forwarded invoke params"),
  };
}

function expectForwardedApprovedParams(
  capture: ReturnType<typeof createInvokeParamCapture>,
  absentKey: string,
): void {
  const forwardedParams = capture.params();
  expect(forwardedParams).toMatchObject({ approved: true, approvalDecision: "allow-once" });
  expect(forwardedParams[absentKey]).toBeUndefined();
}

function requireValue<T>(value: T | null | undefined, label: string): T {
  if (!value) {
    throw new Error(`expected ${label}`);
  }
  return value;
}

async function getConnectedNodeIds(ws: WebSocket): Promise<string[]> {
  const nodes = await rpcReq<{ nodes?: Array<{ nodeId: string; connected?: boolean }> }>(
    ws,
    "node.list",
    {},
  );
  expect(nodes.ok).toBe(true);
  return (nodes.payload?.nodes ?? []).filter((node) => node.connected).map((node) => node.nodeId);
}

function invokeNode(ws: WebSocket, nodeId: string, command: string, params: unknown) {
  return rpcReq(ws, "node.invoke", {
    nodeId,
    command,
    params,
    idempotencyKey: crypto.randomUUID(),
  });
}

async function requestAllowOnceApproval(
  ws: WebSocket,
  command: string,
  nodeId: string,
  context?: ChatApprovalContext,
): Promise<string> {
  const approvalId = crypto.randomUUID();
  const commandArgv = command.split(/\s+/).filter((part) => part.length > 0);
  const requested = await rpcReq(ws, "exec.approval.request", {
    id: approvalId,
    command,
    commandArgv,
    systemRunPlan: {
      argv: commandArgv,
      cwd: null,
      commandText: command,
      agentId: context?.agentId ?? null,
      sessionKey: context?.sessionKey ?? null,
    },
    nodeId,
    cwd: null,
    host: "node",
    ...context,
    requireDeliveryRoute: false,
    twoPhase: true,
    timeoutMs: 30_000,
  });
  expect(requested.ok).toBe(true);
  const resolved = await rpcReq(ws, "exec.approval.resolve", {
    id: approvalId,
    decision: "allow-once",
  });
  expect(resolved.ok).toBe(true);
  return approvalId;
}

function invokeApprovedRun(
  ws: WebSocket,
  nodeId: string,
  runId: string,
  extra: Record<string, unknown> = {},
  rawCommand = "echo hi",
) {
  return invokeNode(ws, nodeId, "system.run", {
    command: rawCommand.split(" "),
    rawCommand,
    runId,
    approved: true,
    approvalDecision: "allow-once",
    ...extra,
  });
}

type ChatApprovalContext = {
  agentId: string;
  sessionKey: string;
  turnSourceChannel: string;
  turnSourceTo: string;
  turnSourceAccountId?: string;
  turnSourceThreadId?: string | number;
};

describe("node.invoke approval bypass", () => {
  let server: Awaited<ReturnType<typeof startServerWithClient>>["server"];
  let port: number;
  const sockets: WebSocket[] = [];
  const nodes: GatewayClient[] = [];
  const acknowledgements: Promise<PromiseSettledResult<unknown>[]>[] = [];

  afterEach(async () => {
    for (const ws of sockets.splice(0)) {
      ws.close();
    }
    // The operator result can arrive before the node's acknowledgement settles.
    const results = (await Promise.all(acknowledgements.splice(0))).flat();
    results.push(...(await Promise.allSettled(nodes.splice(0).map((node) => node.stopAndWait()))));
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length > 0) {
      throw new AggregateError(failures, "Node acknowledgement or shutdown failed");
    }
  });

  const openOperatorSocket = async () => {
    const ws = await openTrackedWs(port);
    sockets.push(ws);
    return ws;
  };

  beforeAll(async () => {
    await writeConfigFile({
      gateway: {
        nodes: {
          pairing: { autoApproveCidrs: ["127.0.0.1/32", "::1/128"] },
          commands: {
            allow: [
              "system.run",
              "system.run.prepare",
              "system.which",
              "browser.proxy",
              "fs.listDir",
            ],
          },
        },
      },
    });
    const started = await startServerWithClient("secret", { controlUiEnabled: true });
    server = started.server;
    port = started.port;
    started.ws.close();
  });

  afterAll(() => server.close());

  const approveAllPendingPairings = async () => {
    const { approveDevicePairing } = await import("../infra/device-pairing-approval.js");
    const { listDevicePairing } = await import("../infra/device-pairing.js");
    const { approveNodePairing, listNodePairing } = await import("../infra/device-pairing-node.js");
    for (const pending of (await listDevicePairing()).pending) {
      await approveDevicePairing(pending.requestId, {
        callerScopes: pending.scopes ?? ["operator.admin"],
      });
    }
    for (const pending of (await listNodePairing()).pending) {
      await approveNodePairing(pending.requestId, {
        callerScopes: ["operator.admin"],
      });
    }
  };

  const approvePendingNodePairings = async (nodeId: string) => {
    const { approveNodePairing, listNodePairing } = await import("../infra/device-pairing-node.js");
    let approved = false;
    for (const pending of (await listNodePairing()).pending.filter(
      (node) => node.nodeId === nodeId,
    )) {
      const result = await approveNodePairing(pending.requestId, {
        callerScopes: ["operator.pairing", "operator.write", "operator.admin"],
      });
      approved ||= Boolean(result && "node" in result);
    }
    return approved;
  };

  const connectOperator = async (scopes: string[], deviceIdentityPath?: string) => {
    const connectOnce = async () => {
      const ws = await openOperatorSocket();
      const res = await connectReq(ws, {
        token: "secret",
        scopes,
        deviceIdentityPath,
        timeoutMs: 2_000,
      });
      return { ws, res };
    };

    let { ws, res } = await connectOnce();
    const message = res.error?.message ?? "";
    if (!res.ok && message.includes("pairing required")) {
      ws.close();
      await approveAllPendingPairings();
      ({ ws, res } = await connectOnce());
    }
    expect(res.ok).toBe(true);
    return ws;
  };

  const connectTrustedBackend = async (scopes: string[]) => {
    const ws = await openOperatorSocket();
    const res = await connectReq(ws, {
      token: "secret",
      scopes,
      device: null,
      client: {
        id: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
        displayName: "agent",
        version: "1.0.0",
        platform: "test",
        mode: GATEWAY_CLIENT_MODES.BACKEND,
      },
      timeoutMs: 2_000,
    });
    expect(res.ok).toBe(true);
    return ws;
  };

  const connectDeviceTokenOperator = async (scopes: string[]) => {
    const issued = await issueOperatorToken({
      name: `browser-proxy-scope-${crypto.randomUUID()}`,
      approvedScopes: scopes,
      clientId: GATEWAY_CLIENT_NAMES.TEST,
      clientMode: GATEWAY_CLIENT_MODES.TEST,
    });
    const ws = await openOperatorSocket();
    const res = await connectReq(ws, {
      skipDefaultAuth: true,
      deviceIdentityPath: issued.identityPath,
      deviceToken: issued.token,
      scopes,
      timeoutMs: 2_000,
    });
    expect(res.ok).toBe(true);
    return ws;
  };

  const connectLinuxNode = async (
    onInvoke: (payload: unknown) => void,
    deviceIdentity?: DeviceIdentity,
    commands: string[] = ["system.run"],
  ) => {
    const resolvedDeviceIdentity = deviceIdentity ?? createDeviceIdentity();

    const startNodeClient = async () => {
      const client: GatewayClient = await connectGatewayClient({
        url: `ws://127.0.0.1:${port}`,
        connectChallengeTimeoutMs: 2_000,
        timeoutMs: 10_000,
        token: "secret",
        role: "node",
        clientName: GATEWAY_CLIENT_NAMES.NODE_HOST,
        clientVersion: "1.0.0",
        platform: "linux",
        mode: GATEWAY_CLIENT_MODES.NODE,
        scopes: [],
        caps: ["system"],
        commands,
        deviceIdentity: resolvedDeviceIdentity,
        onEvent: (event) => {
          const acknowledgement = acknowledgeNodeInvokeRequestForTest({ client, event, onInvoke });
          if (acknowledgement) {
            acknowledgements.push(Promise.allSettled([acknowledgement]));
          }
        },
      });
      return client;
    };

    let client = await startNodeClient();
    if (await approvePendingNodePairings(resolvedDeviceIdentity.deviceId)) {
      client.stop();
      client = await startNodeClient();
    }
    nodes.push(client);
    return client;
  };

  const connectObservedNode = async (commands = ["system.run"]) => {
    const identity = createDeviceIdentity();
    const capture = createInvokeParamCapture();
    await connectLinuxNode(capture.onInvoke, identity, commands);
    return { capture, nodeId: identity.deviceId };
  };

  test("rejects malformed/forbidden node.invoke payloads before forwarding", async () => {
    const { capture, nodeId } = await connectObservedNode();
    const ws = await connectOperator(["operator.write"]);
    const cases = [
      {
        command: "system.run",
        params: { command: ["uname", "-a"], rawCommand: "echo hi" },
        expectedError: "rawCommand does not match command",
      },
      {
        command: "system.run",
        params: {
          command: ["echo", "hi"],
          rawCommand: "echo hi",
          approved: true,
          approvalDecision: "allow-once",
        },
        expectedError: "params.runId",
      },
      {
        command: "system.execApprovals.set",
        params: { file: { version: 1, agents: {} }, baseHash: "nope" },
        expectedError: "exec.approvals.node",
      },
    ] as const;

    for (const testCase of cases) {
      const res = await invokeNode(ws, nodeId, testCase.command, testCase.params);
      expect(res.ok, testCase.expectedError).toBe(false);
      expect(res.error?.message ?? "", testCase.expectedError).toContain(testCase.expectedError);
      await expectNoForwardedInvoke(() => capture.count() > 0);
    }
  });

  test("rejects persistent browser profile mutations before forwarding", async () => {
    const command = "browser.proxy";
    const { capture, nodeId } = await connectObservedNode([command]);
    const ws = await connectOperator(["operator.write"]);
    const res = await invokeNode(ws, nodeId, command, {
      method: "POST",
      path: "/profiles/create",
      body: { name: "poc", cdpUrl: "http://127.0.0.1:9222" },
    });
    expect(res.ok).toBe(false);
    expect(res.error?.message ?? "").toContain(
      `node.invoke cannot mutate persistent browser profiles via ${command}`,
    );
    await expectNoForwardedInvoke(() => capture.count() > 0);
  });

  test("requires admin scope for direct browser.proxy node.invoke", async () => {
    const { capture, nodeId } = await connectObservedNode(["browser.proxy"]);
    const ws = await connectDeviceTokenOperator(["operator.write"]);
    const browserRequest = await rpcReq(ws, "browser.request", {
      method: "GET",
      path: "/profiles",
    });
    expect(browserRequest.ok).toBe(false);
    expect(browserRequest.error?.message ?? "").toContain("missing scope: operator.admin");

    const directProxy = await invokeNode(ws, nodeId, "browser.proxy", {
      method: "GET",
      path: "/profiles",
    });
    expect(directProxy.ok).toBe(false);
    expect(directProxy.error).toMatchObject({
      code: "FORBIDDEN",
      message: "missing scope: operator.admin",
      details: {
        code: "MISSING_SCOPE",
        missingScope: "operator.admin",
        requiredScopes: ["operator.admin"],
      },
    });
    await expectNoForwardedInvoke(() => capture.count() > 0);
  });

  test("allows direct browser.proxy node.invoke for admin-scoped operators", async () => {
    const { capture, nodeId } = await connectObservedNode(["browser.proxy"]);
    const ws = await connectDeviceTokenOperator(["operator.admin"]);
    const directProxy = await invokeNode(ws, nodeId, "browser.proxy", {
      method: "GET",
      path: "/profiles",
    });
    expect(directProxy.ok, JSON.stringify(directProxy.error)).toBe(true);
    expect(capture.count()).toBeGreaterThan(0);
  });

  test("binds approvals to decision/device and blocks cross-device replay", async () => {
    const { capture: invokeCapture, nodeId } = await connectObservedNode();
    const wsApprover = await connectOperator(["operator.write", "operator.approvals"]);
    const wsCaller = await connectOperator(["operator.write"]);
    const wsOtherDevice = await connectOperator(
      ["operator.write"],
      loadDeviceIdentity(`operator-${crypto.randomUUID()}`).identityPath,
    );

    const approvalId = await requestAllowOnceApproval(wsApprover, "echo hi", nodeId);
    // Separate caller connection simulates per-call clients.
    const invoke = await invokeApprovedRun(wsCaller, nodeId, approvalId, {
      approvalDecision: "allow-always",
      injected: "nope",
    });
    expect(invoke.ok, JSON.stringify(invoke.error)).toBe(true);
    expectForwardedApprovedParams(invokeCapture, "injected");

    const replayApprovalId = await requestAllowOnceApproval(wsApprover, "echo hi", nodeId);
    const invokeCountBeforeReplay = invokeCapture.count();
    const replay = await invokeApprovedRun(wsOtherDevice, nodeId, replayApprovalId);
    expect(replay.ok).toBe(false);
    expect(replay.error?.message ?? "").toContain("not valid for this device");
    await expectNoForwardedInvoke(() => invokeCapture.count() > invokeCountBeforeReplay);
  });

  test("bridges no-device chat approvals across backend reconnects only for the same turn source", async () => {
    const { capture: invokeCapture, nodeId } = await connectObservedNode();
    const wsRequest = await connectTrustedBackend(["operator.write", "operator.approvals"]);
    const wsReplay = await connectTrustedBackend(["operator.write", "operator.approvals"]);

    const context: ChatApprovalContext = {
      agentId: "main",
      sessionKey: "agent:main:telegram:direct:12345",
      turnSourceChannel: "telegram",
      turnSourceTo: "telegram:12345",
      turnSourceAccountId: "work",
      turnSourceThreadId: "42",
    };

    const approvalId = await requestAllowOnceApproval(wsRequest, "echo chat", nodeId, context);
    const invoke = await invokeApprovedRun(wsReplay, nodeId, approvalId, context, "echo chat");
    expect(invoke.ok).toBe(true);
    expectForwardedApprovedParams(invokeCapture, "turnSourceTo");

    const mismatchApprovalId = await requestAllowOnceApproval(
      wsRequest,
      "echo chat",
      nodeId,
      context,
    );
    const invokeCountBeforeMismatch = invokeCapture.count();
    const mismatch = await invokeApprovedRun(
      wsReplay,
      nodeId,
      mismatchApprovalId,
      {
        ...context,
        turnSourceTo: "telegram:67890",
      },
      "echo chat",
    );
    expect(mismatch.ok).toBe(false);
    expect(mismatch.error?.message ?? "").toContain("not valid for this client");
    await expectNoForwardedInvoke(() => invokeCapture.count() > invokeCountBeforeMismatch);
  });

  test("blocks cross-node replay on same device", async () => {
    const approvedNode = await connectObservedNode();
    const replayNode = await connectObservedNode();

    const wsApprover = await connectOperator(["operator.write", "operator.approvals"]);
    const wsCaller = await connectOperator(["operator.write"]);

    await expect
      .poll(() => getConnectedNodeIds(wsApprover), {
        timeout: 3_000,
        interval: 50,
      })
      .toEqual(expect.arrayContaining([approvedNode.nodeId, replayNode.nodeId]));

    const approvalId = await requestAllowOnceApproval(wsApprover, "echo hi", approvedNode.nodeId);
    const beforeReplayApprovedNode = approvedNode.capture.count();
    const beforeReplayOtherNode = replayNode.capture.count();
    const replay = await invokeApprovedRun(wsCaller, replayNode.nodeId, approvalId);
    expect(replay.ok).toBe(false);
    expect(replay.error?.message ?? "").toContain("not valid for this node");
    await expectNoForwardedInvoke(
      () =>
        approvedNode.capture.count() > beforeReplayApprovedNode ||
        replayNode.capture.count() > beforeReplayOtherNode,
    );
  });
});
