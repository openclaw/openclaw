import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";

vi.mock("../infra/update-runner.js", () => ({
  runGatewayUpdate: vi.fn(async () => ({
    status: "ok",
    mode: "git",
    root: "/repo",
    steps: [],
    durationMs: 12,
  })),
}));

import {
  connectOk,
  installGatewayTestHooks,
  rpcReq,
  startServerWithClient,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

let server: Awaited<ReturnType<typeof startServerWithClient>>["server"];
let ws: WebSocket;
let port: number;
let nodeWs: WebSocket;
let nodeId: string;

beforeAll(async () => {
  const token = "test-gateway-token-1234567890";
  const started = await startServerWithClient(token);
  server = started.server;
  ws = started.ws;
  port = started.port;
  await connectOk(ws, { token });

  nodeWs = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((resolve) => nodeWs.once("open", resolve));

  const identity = loadOrCreateDeviceIdentity();
  nodeId = identity.deviceId;
  await connectOk(nodeWs, {
    role: "node",
    client: {
      id: GATEWAY_CLIENT_NAMES.NODE_HOST,
      version: "1.0.0",
      platform: "darwin",
      mode: GATEWAY_CLIENT_MODES.NODE,
    },
    commands: ["canvas.snapshot"],
    token,
  });
});

afterAll(async () => {
  nodeWs.close();
  ws.close();
  await server.close();
});

describe("late-arriving invoke results", () => {
  test("returns success for unknown invoke ids for both success and error payloads", async () => {
    const cases = [
      {
        id: "unknown-invoke-id-12345",
        ok: true,
        payloadJSON: JSON.stringify({ result: "late" }),
      },
      {
        id: "another-unknown-invoke-id",
        ok: false,
        error: { code: "FAILED", message: "test error" },
      },
    ] as const;

    for (const params of cases) {
      const result = await rpcReq<{ ok?: boolean; ignored?: boolean }>(
        nodeWs,
        "node.invoke.result",
        {
          ...params,
          nodeId,
        },
      );

      // Late-arriving results return success instead of error to reduce log noise.
      expect(result.ok).toBe(true);
      expect(result.payload?.ok).toBe(true);
      expect(result.payload?.ignored).toBe(true);
    }
  });
});
