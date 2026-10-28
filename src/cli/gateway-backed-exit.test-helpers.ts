import { once } from "node:events";
import type { AddressInfo } from "node:net";
import os from "node:os";
import { isLoopbackIpAddress, isPrivateOrLoopbackIpAddress } from "@openclaw/net-policy/ip";
import { expect } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import {
  buildMinimalGatewayHelloOkPayload,
  closeMinimalGatewayServer,
  parseMinimalGatewayRequestFrame,
  sendMinimalGatewayConnectChallenge,
  sendMinimalGatewayResponse,
} from "../gateway/minimal-gateway.test-helpers.js";
import { pickMatchingExternalInterfaceAddress } from "../infra/network-interfaces.js";

const activeServers = new Set<WebSocketServer>();
type CliResult = Awaited<
  ReturnType<typeof import("./gateway-backed-exit.process.test-support.js").runIsolatedGatewayCli>
>;
export function expectCliResult(result: CliResult, code = 0): unknown {
  expect(result, result.stderr).toMatchObject({ code, signal: null, stderr: "" });
  return JSON.parse(result.stdout);
}
type Request = ReturnType<typeof parseMinimalGatewayRequestFrame> & { id: string };
type Hello = NonNullable<Parameters<typeof buildMinimalGatewayHelloOkPayload>[0]>;
// Cached device credentials must not also claim shared auth and suppress human identity.
type ExpectedGatewayAuth =
  | { token: string; deviceToken?: never }
  | { token?: never; deviceToken: string };

export async function startGateway(
  handle: ((ws: WebSocket, frame: Request) => void) | Record<string, unknown>,
  connect?: (frame: Request) => Hello,
  host = "127.0.0.1",
) {
  const calls: string[] = [];
  const wss = new WebSocketServer({ host, port: 0 });
  activeServers.add(wss);
  wss.on("connection", (ws) => {
    sendMinimalGatewayConnectChallenge(ws);
    ws.on("message", (data) => {
      const frame = parseMinimalGatewayRequestFrame(data);
      if (frame.type !== "req" || !frame.id) {
        return;
      }
      const request = { ...frame, id: frame.id };
      if (frame.method === "connect" && connect) {
        sendMinimalGatewayResponse(
          ws,
          frame.id,
          buildMinimalGatewayHelloOkPayload(connect(request)),
        );
      } else {
        if (typeof frame.method === "string") {
          calls.push(frame.method);
        }
        if (typeof handle === "function") {
          handle(ws, request);
        } else if (frame.method && Object.hasOwn(handle, frame.method)) {
          sendMinimalGatewayResponse(ws, frame.id, handle[frame.method]);
        }
      }
    });
  });
  await once(wss, "listening");
  const { port } = wss.address() as AddressInfo;
  return {
    calls,
    url: "ws://" + host + ":" + port,
    port,
    close: async () => {
      await closeMinimalGatewayServer(wss);
      activeServers.delete(wss);
    },
  };
}

function authenticate(
  expected: ExpectedGatewayAuth | string | undefined,
  methods: string[],
  deviceToken?: string,
): (frame: Request) => Hello {
  return (frame) => {
    if (typeof expected === "object") {
      expect(frame.params?.auth).toEqual(expected);
    } else {
      expect(frame.params?.auth?.token).toBe(expected);
    }
    return {
      methods,
      auth: {
        role: "operator",
        scopes: ["operator.admin"],
        ...(deviceToken ? { deviceToken } : {}),
      },
    };
  };
}

const emptyCronList = {
  jobs: [],
  snapshotRevision: "test-revision",
  total: 0,
  offset: 0,
  limit: 50,
  hasMore: false,
  nextOffset: null,
  deliveryPreviews: {},
};
export const EMPTY_STABILITY_SNAPSHOT = {
  capacity: 100,
  count: 0,
  dropped: 0,
  events: [],
  summary: { byType: {} },
};

function sendFailure(ws: WebSocket, id: string, error: unknown, sent?: () => void) {
  ws.send(JSON.stringify({ type: "res", id, ok: false, error }), sent);
}

export async function startCliReadGateway(token?: string): Promise<{ url: string }> {
  return await startGateway(
    (ws, frame) => {
      if (frame.method === "cron.list") {
        sendMinimalGatewayResponse(ws, frame.id, emptyCronList);
      }
      if (frame.method === "cron.status") {
        sendMinimalGatewayResponse(ws, frame.id, { enabled: true, jobs: 0 });
      }
      if (frame.method === "message.action") {
        expect(frame.params).toMatchObject({
          channel: "discord",
          action: "read",
          params: { target: "123456789012345678", limit: "1" },
          conversationReadOrigin: "direct-operator",
        });
        sendMinimalGatewayResponse(ws, frame.id, { messages: [] });
      }
    },
    authenticate(token, ["cron.list", "cron.status", "message.action"]),
  );
}

export async function startCronLookupMissGateway(token: string, jobId: string) {
  const gateway = await startGateway(
    (ws, frame) => {
      if (frame.method === "cron.get") {
        sendFailure(ws, frame.id, {
          code: "INVALID_REQUEST",
          message: "cron job not found: " + jobId,
          details: { code: "CRON_JOB_NOT_FOUND", jobId },
        });
      }
      if (frame.method === "cron.list") {
        sendMinimalGatewayResponse(ws, frame.id, emptyCronList);
      }
    },
    authenticate(token, ["cron.get", "cron.list"]),
  );
  return { calls: gateway.calls, url: gateway.url };
}

export async function startRateLimitedGateway(): Promise<{ url: string }> {
  return await startGateway((ws, frame) => {
    if (frame.method !== "connect") {
      return;
    }
    const message = "unauthorized: too many failed authentication attempts (retry later)";
    sendFailure(
      ws,
      frame.id,
      {
        code: "INVALID_REQUEST",
        message,
        retryable: true,
        retryAfterMs: 60_000,
        details: {
          code: "AUTH_RATE_LIMITED",
          authReason: "rate_limited",
          recommendedNextStep: "wait_then_retry",
        },
      },
      () => ws.close(1008, message),
    );
  });
}

export async function startNodePairingGateway(
  expectedAuth: ExpectedGatewayAuth,
  issuedDeviceToken?: string,
) {
  return await startGateway(
    {
      "node.pair.list": {
        pending: [{ requestId: "request-1", nodeId: "node-1", commands: [] }],
        paired: [],
      },
      "node.list": { nodes: [] },
      "node.pair.approve": { approved: true },
    },
    authenticate(
      expectedAuth,
      ["node.pair.list", "node.pair.approve", "node.list"],
      issuedDeviceToken,
    ),
  );
}

export async function startGatewayStabilityRpcServer(
  expectedAuth: ExpectedGatewayAuth,
  issuedDeviceToken: string,
) {
  const authInputs: unknown[] = [];
  const connect = authenticate(
    expectedAuth,
    ["diagnostics.stability", "status"],
    issuedDeviceToken,
  );
  const gateway = await startGateway(
    {
      "diagnostics.stability": EMPTY_STABILITY_SNAPSHOT,
      status: { runtimeVersion: "2026.8.17-test", status: "ok" },
    },
    (frame) => {
      const hello = connect(frame);
      authInputs.push(frame.params?.auth);
      return hello;
    },
    "0.0.0.0",
  );
  // A private non-loopback target keeps shared-secret auth from bypassing device identity.
  const host = pickMatchingExternalInterfaceAddress(os.networkInterfaces(), {
    family: "IPv4",
    matches: (candidate) =>
      isPrivateOrLoopbackIpAddress(candidate) && !isLoopbackIpAddress(candidate),
  });
  if (!host) {
    throw new Error("test host has no non-loopback private IPv4 address");
  }
  return { authInputs, calls: gateway.calls, url: "ws://" + host + ":" + gateway.port };
}

export async function startStateDirStatusGateway(target: {
  stateDir: string;
  configPath: string;
}): Promise<{ url: string }> {
  return await startGateway({ status: { status: "ok" } }, () => ({
    methods: ["status"],
    snapshot: target,
  }));
}

export async function startAgentTurnGateway(params: { status: "ok" | "error"; text: string }) {
  const token = "agent-turn-token";
  const gateway = await startGateway(
    (ws, frame) => {
      if (frame.method !== "agent") {
        return;
      }
      const runId = "agent-turn-run";
      sendMinimalGatewayResponse(ws, frame.id, {
        runId,
        status: "accepted",
        sessionKey: "agent:main:main",
      });
      setImmediate(() => {
        sendMinimalGatewayResponse(ws, frame.id, {
          runId,
          status: params.status,
          summary: params.status === "ok" ? "completed" : "failed",
          result: {
            payloads: [
              { text: params.text, ...(params.status === "error" ? { isError: true } : {}) },
            ],
            meta: {},
          },
        });
      });
    },
    authenticate(token, ["agent"]),
  );
  return { url: gateway.url, token };
}

export async function closeActiveGatewayServers(): Promise<void> {
  await Promise.all(Array.from(activeServers, closeMinimalGatewayServer));
  activeServers.clear();
}
