// Shared process-test harness: mock Gateway servers used by CLI exit-code proofs.
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

async function startGateway(
  handle: (
    ws: WebSocket,
    frame: ReturnType<typeof parseMinimalGatewayRequestFrame> & { id: string },
  ) => void,
  host = "127.0.0.1",
  connected = () => {},
): Promise<{ url: string; port: number }> {
  const wss = new WebSocketServer({ host, port: 0 });
  activeServers.add(wss);
  wss.on("connection", (ws) => {
    connected();
    sendMinimalGatewayConnectChallenge(ws);
    ws.on("message", (data) => {
      const frame = parseMinimalGatewayRequestFrame(data);
      if (frame.type === "req" && frame.id) {
        handle(ws, { ...frame, id: frame.id });
      }
    });
  });
  await once(wss, "listening");
  const { port } = wss.address() as AddressInfo;
  return { url: `ws://${host}:${port}`, port };
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

function hello(
  ws: WebSocket,
  id: string,
  methods: string[],
  auth?: NonNullable<Parameters<typeof buildMinimalGatewayHelloOkPayload>[0]>["auth"],
) {
  sendMinimalGatewayResponse(ws, id, buildMinimalGatewayHelloOkPayload({ methods, auth }));
}

// Cached device credentials must not also claim shared auth and suppress human identity.
type ExpectedGatewayAuth =
  | { token: string; deviceToken?: never }
  | { token?: never; deviceToken: string };

export const EMPTY_STABILITY_SNAPSHOT = {
  capacity: 100,
  count: 0,
  dropped: 0,
  events: [],
  summary: { byType: {} },
};

export async function startCliReadGateway(token?: string): Promise<{ url: string }> {
  return await startGateway((ws, frame) => {
    if (frame.method === "connect") {
      expect(frame.params?.auth?.token).toBe(token);
      hello(ws, frame.id, ["cron.list", "cron.status", "message.action"], {
        role: "operator",
        scopes: ["operator.admin"],
      });
      return;
    }
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
  });
}

/** Fake Gateway whose automation store never contains the requested job id. */
export async function startCronLookupMissGateway(
  token: string,
  jobId: string,
): Promise<{ calls: string[]; url: string }> {
  const calls: string[] = [];
  const gateway = await startGateway((ws, frame) => {
    if (frame.method === "connect") {
      expect(frame.params?.auth?.token).toBe(token);
      hello(ws, frame.id, ["cron.get", "cron.list"], {
        role: "operator",
        scopes: ["operator.admin"],
      });
      return;
    }
    if (typeof frame.method !== "string") {
      return;
    }
    calls.push(frame.method);
    if (frame.method === "cron.get") {
      // The typed lookup miss a real Gateway emits for an unknown automation id.
      ws.send(
        JSON.stringify({
          type: "res",
          id: frame.id,
          ok: false,
          error: {
            code: "INVALID_REQUEST",
            message: `cron job not found: ${jobId}`,
            details: { code: "CRON_JOB_NOT_FOUND", jobId },
          },
        }),
      );
      return;
    }
    if (frame.method === "cron.list") {
      sendMinimalGatewayResponse(ws, frame.id, emptyCronList);
    }
  });
  return { calls, url: gateway.url };
}

export async function startRateLimitedGateway(): Promise<{ url: string }> {
  return await startGateway((ws, frame) => {
    if (frame.method !== "connect") {
      return;
    }
    const message = "unauthorized: too many failed authentication attempts (retry later)";
    ws.send(
      JSON.stringify({
        type: "res",
        id: frame.id,
        ok: false,
        error: {
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
      }),
      () => ws.close(1008, message),
    );
  });
}

export async function startNodePairingGateway(
  expectedAuth: ExpectedGatewayAuth,
  issuedDeviceToken?: string,
): Promise<{
  calls: string[];
  readonly connectionCount: number;
  url: string;
}> {
  const calls: string[] = [];
  let connectionCount = 0;
  const gateway = await startGateway(
    (ws, frame) => {
      if (frame.method === "connect") {
        expect(frame.params?.auth).toEqual(expectedAuth);
        hello(ws, frame.id, ["node.pair.list", "node.pair.approve", "node.list"], {
          role: "operator",
          scopes: ["operator.admin"],
          ...(issuedDeviceToken ? { deviceToken: issuedDeviceToken } : {}),
        });
        return;
      }
      if (typeof frame.method !== "string") {
        return;
      }
      calls.push(frame.method);
      if (frame.method === "node.pair.list") {
        sendMinimalGatewayResponse(ws, frame.id, {
          pending: [{ requestId: "request-1", nodeId: "node-1", commands: [] }],
          paired: [],
        });
        return;
      }
      if (frame.method === "node.list") {
        sendMinimalGatewayResponse(ws, frame.id, { nodes: [] });
        return;
      }
      if (frame.method === "node.pair.approve") {
        sendMinimalGatewayResponse(ws, frame.id, { approved: true });
      }
    },
    "127.0.0.1",
    () => {
      connectionCount += 1;
    },
  );
  return {
    calls,
    get connectionCount() {
      return connectionCount;
    },
    url: gateway.url,
  };
}

export async function startGatewayStabilityRpcServer(
  expectedAuth: ExpectedGatewayAuth,
  issuedDeviceToken: string,
): Promise<{
  authInputs: unknown[];
  calls: string[];
  url: string;
}> {
  const authInputs: unknown[] = [];
  const calls: string[] = [];
  const gateway = await startGateway((ws, frame) => {
    if (frame.method === "connect") {
      expect(frame.params?.auth).toEqual(expectedAuth);
      authInputs.push(frame.params?.auth);
      hello(ws, frame.id, ["diagnostics.stability", "status"], {
        role: "operator",
        scopes: ["operator.admin"],
        deviceToken: issuedDeviceToken,
      });
      return;
    }
    if (typeof frame.method !== "string") {
      return;
    }
    calls.push(frame.method);
    if (frame.method === "diagnostics.stability") {
      sendMinimalGatewayResponse(ws, frame.id, EMPTY_STABILITY_SNAPSHOT);
      return;
    }
    if (frame.method === "status") {
      sendMinimalGatewayResponse(ws, frame.id, {
        runtimeVersion: "2026.8.17-test",
        status: "ok",
      });
    }
  }, "0.0.0.0");
  // A private non-loopback target keeps shared-secret auth from bypassing device identity.
  const host = pickMatchingExternalInterfaceAddress(os.networkInterfaces(), {
    family: "IPv4",
    matches: (candidate) =>
      isPrivateOrLoopbackIpAddress(candidate) && !isLoopbackIpAddress(candidate),
  });
  if (!host) {
    throw new Error("test host has no non-loopback private IPv4 address");
  }
  return { authInputs, calls, url: `ws://${host}:${gateway.port}` };
}

export async function startStateDirStatusGateway(target: {
  stateDir: string;
  configPath: string;
}): Promise<{ url: string }> {
  return await startGateway((ws, frame) => {
    if (frame.method === "connect") {
      sendMinimalGatewayResponse(
        ws,
        frame.id,
        buildMinimalGatewayHelloOkPayload({ methods: ["status"], snapshot: target }),
      );
      return;
    }
    if (frame.method === "status") {
      sendMinimalGatewayResponse(ws, frame.id, { status: "ok" });
    }
  });
}

/** Mock Gateway that answers one agent turn with the requested terminal status. */
export async function startAgentTurnGateway(params: {
  status: "ok" | "error";
  text: string;
}): Promise<{ url: string; token: string }> {
  const token = "agent-turn-token";
  const gateway = await startGateway((ws, frame) => {
    if (frame.method === "connect") {
      expect(frame.params?.auth?.token).toBe(token);
      hello(ws, frame.id, ["agent"], { role: "operator", scopes: ["operator.admin"] });
      return;
    }
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
      sendMinimalGatewayResponse(ws, frame.id!, {
        runId,
        status: params.status,
        summary: params.status === "ok" ? "completed" : "failed",
        result: {
          payloads: [
            {
              text: params.text,
              ...(params.status === "error" ? { isError: true } : {}),
            },
          ],
          meta: {},
        },
      });
    });
  });
  return { url: gateway.url, token };
}

/** Closes every mock Gateway started by these helpers; call from the suite afterEach. */
export async function closeActiveGatewayServers(): Promise<void> {
  await Promise.all(Array.from(activeServers, closeMinimalGatewayServer));
  activeServers.clear();
}
