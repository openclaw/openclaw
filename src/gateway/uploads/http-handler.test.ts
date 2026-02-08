import { afterEach, describe, expect, it } from "vitest";
import {
  approveDevicePairing,
  ensureDeviceToken,
  requestDevicePairing,
} from "../../infra/device-pairing.js";
import {
  getFreePort,
  installGatewayTestHooks,
  startGatewayServer,
} from "../test-helpers.server.js";

installGatewayTestHooks({ scope: "suite" });

async function createOperatorDeviceToken(deviceId: string): Promise<string> {
  const pending = await requestDevicePairing({
    deviceId,
    publicKey: `pk-${deviceId}`,
    role: "operator",
    scopes: ["operator.admin"],
  });
  await approveDevicePairing(pending.request.requestId);
  const token = await ensureDeviceToken({
    deviceId,
    role: "operator",
    scopes: ["operator.admin"],
  });
  if (!token?.token) {
    throw new Error("failed to create device token for test");
  }
  return token.token;
}

describe("POST /uploads", () => {
  let closeServer: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (closeServer) {
      await closeServer();
      closeServer = null;
    }
  });

  it("accepts shared gateway token auth", async () => {
    const port = await getFreePort();
    const server = await startGatewayServer(port, {
      bind: "loopback",
      auth: { mode: "token", token: "secret" },
    });
    closeServer = async () => {
      await server.close();
    };

    const res = await fetch(`http://127.0.0.1:${port}/uploads`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "x-file-name": "note.txt",
        "content-type": "text/plain",
      },
      body: Buffer.from("hello upload"),
    });

    expect(res.status).toBe(200);
    const payload = (await res.json()) as { ok?: boolean; path?: string; size?: number };
    expect(payload.ok).toBe(true);
    expect(typeof payload.path).toBe("string");
    expect((payload.path ?? "").length).toBeGreaterThan(0);
    expect(payload.size).toBeGreaterThan(0);
  });

  it("rejects device token auth when device id header is missing", async () => {
    const port = await getFreePort();
    const server = await startGatewayServer(port, {
      bind: "loopback",
      auth: { mode: "token", token: "secret" },
    });
    closeServer = async () => {
      await server.close();
    };

    const deviceToken = await createOperatorDeviceToken("device-upload-no-header");
    const res = await fetch(`http://127.0.0.1:${port}/uploads`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${deviceToken}`,
        "x-file-name": "no-header.txt",
        "content-type": "text/plain",
      },
      body: Buffer.from("payload"),
    });

    expect(res.status).toBe(401);
  });

  it("accepts paired device token auth with device id header", async () => {
    const port = await getFreePort();
    const server = await startGatewayServer(port, {
      bind: "loopback",
      auth: { mode: "token", token: "secret" },
    });
    closeServer = async () => {
      await server.close();
    };

    const deviceId = "device-upload-ok";
    const deviceToken = await createOperatorDeviceToken(deviceId);

    const res = await fetch(`http://127.0.0.1:${port}/uploads`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${deviceToken}`,
        "x-openclaw-device-id": deviceId,
        "x-file-name": "with-device-token.txt",
        "content-type": "text/plain",
      },
      body: Buffer.from("device token upload"),
    });

    expect(res.status).toBe(200);
    const payload = (await res.json()) as { ok?: boolean; path?: string };
    expect(payload.ok).toBe(true);
    expect(typeof payload.path).toBe("string");
    expect((payload.path ?? "").length).toBeGreaterThan(0);
  });
});
