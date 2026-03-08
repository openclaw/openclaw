import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock device-pairing before importing handler
vi.mock("../infra/device-pairing.js", () => ({
  listDevicePairing: vi.fn(),
  approveDevicePairing: vi.fn(),
}));

vi.mock("./http-auth-helpers.js", () => ({
  authorizeGatewayBearerRequestOrReply: vi.fn(),
}));

vi.mock("./http-common.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    sendJson: vi.fn(),
    sendMethodNotAllowed: vi.fn(),
    sendInvalidRequest: vi.fn(),
    readJsonBodyOrError: vi.fn(),
  };
});

const { listDevicePairing, approveDevicePairing } = await import("../infra/device-pairing.js");
const { authorizeGatewayBearerRequestOrReply } = await import("./http-auth-helpers.js");
const { sendJson, sendMethodNotAllowed, sendInvalidRequest, readJsonBodyOrError } =
  await import("./http-common.js");
import type { ResolvedGatewayAuth } from "./auth.js";
import { handleDevicesHttpRequest } from "./devices-http.js";

function fakeReq(url: string, method = "GET"): IncomingMessage {
  return { url, method, headers: { host: "localhost" } } as unknown as IncomingMessage;
}

const fakeRes = {} as unknown as ServerResponse;
const fakeAuth = {} as unknown as ResolvedGatewayAuth;

describe("handleDevicesHttpRequest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns false for non-matching paths", async () => {
    const result = await handleDevicesHttpRequest(fakeReq("/other"), fakeRes, {
      auth: fakeAuth,
    });
    expect(result).toBe(false);
  });

  describe("GET /api/devices", () => {
    it("rejects non-GET methods", async () => {
      const result = await handleDevicesHttpRequest(fakeReq("/api/devices", "POST"), fakeRes, {
        auth: fakeAuth,
      });
      expect(result).toBe(true);
      expect(vi.mocked(sendMethodNotAllowed)).toHaveBeenCalledWith(fakeRes, "GET");
    });

    it("rejects unauthorized requests", async () => {
      vi.mocked(authorizeGatewayBearerRequestOrReply).mockResolvedValue(false);
      const result = await handleDevicesHttpRequest(fakeReq("/api/devices"), fakeRes, {
        auth: fakeAuth,
      });
      expect(result).toBe(true);
    });

    it("returns device list on success", async () => {
      vi.mocked(authorizeGatewayBearerRequestOrReply).mockResolvedValue(true);
      vi.mocked(listDevicePairing).mockResolvedValue({
        pending: [
          {
            requestId: "req-1",
            deviceId: "dev-1",
            publicKey: "pk",
            displayName: "Chrome",
            platform: "web",
            remoteIp: "1.2.3.4",
            ts: 1000,
          },
        ],
        paired: [
          {
            deviceId: "dev-2",
            publicKey: "pk2",
            displayName: "Safari",
            platform: "web",
            remoteIp: "5.6.7.8",
            createdAtMs: 500,
            approvedAtMs: 600,
          },
        ],
      });

      const result = await handleDevicesHttpRequest(fakeReq("/api/devices"), fakeRes, {
        auth: fakeAuth,
      });
      expect(result).toBe(true);
      expect(vi.mocked(sendJson)).toHaveBeenCalledWith(fakeRes, 200, {
        devices: [
          {
            id: "req-1",
            deviceId: "dev-1",
            displayName: "Chrome",
            platform: "web",
            ip: "1.2.3.4",
            status: "pending",
            createdAt: 1000,
          },
          {
            id: "dev-2",
            deviceId: "dev-2",
            displayName: "Safari",
            platform: "web",
            ip: "5.6.7.8",
            status: "paired",
            createdAt: 500,
          },
        ],
      });
    });
  });

  describe("POST /api/devices/approve", () => {
    it("rejects non-POST methods", async () => {
      const result = await handleDevicesHttpRequest(
        fakeReq("/api/devices/approve", "GET"),
        fakeRes,
        { auth: fakeAuth },
      );
      expect(result).toBe(true);
      expect(vi.mocked(sendMethodNotAllowed)).toHaveBeenCalledWith(fakeRes, "POST");
    });

    it("rejects unauthorized requests", async () => {
      vi.mocked(authorizeGatewayBearerRequestOrReply).mockResolvedValue(false);
      const result = await handleDevicesHttpRequest(
        fakeReq("/api/devices/approve", "POST"),
        fakeRes,
        { auth: fakeAuth },
      );
      expect(result).toBe(true);
    });

    it("rejects missing requestId", async () => {
      vi.mocked(authorizeGatewayBearerRequestOrReply).mockResolvedValue(true);
      vi.mocked(readJsonBodyOrError).mockResolvedValue({});
      const result = await handleDevicesHttpRequest(
        fakeReq("/api/devices/approve", "POST"),
        fakeRes,
        { auth: fakeAuth },
      );
      expect(result).toBe(true);
      expect(vi.mocked(sendInvalidRequest)).toHaveBeenCalledWith(fakeRes, "requestId is required");
    });

    it("returns 404 for unknown requestId", async () => {
      vi.mocked(authorizeGatewayBearerRequestOrReply).mockResolvedValue(true);
      vi.mocked(readJsonBodyOrError).mockResolvedValue({ requestId: "nope" });
      vi.mocked(approveDevicePairing).mockResolvedValue(null);
      const result = await handleDevicesHttpRequest(
        fakeReq("/api/devices/approve", "POST"),
        fakeRes,
        { auth: fakeAuth },
      );
      expect(result).toBe(true);
      expect(vi.mocked(sendJson)).toHaveBeenCalledWith(fakeRes, 404, {
        error: { message: "device not found", type: "not_found" },
      });
    });

    it("approves a device on success", async () => {
      vi.mocked(authorizeGatewayBearerRequestOrReply).mockResolvedValue(true);
      vi.mocked(readJsonBodyOrError).mockResolvedValue({ requestId: "req-1" });
      vi.mocked(approveDevicePairing).mockResolvedValue({
        requestId: "req-1",
        device: {
          deviceId: "dev-1",
          publicKey: "pk",
          createdAtMs: 1000,
          approvedAtMs: 2000,
        },
      });
      const result = await handleDevicesHttpRequest(
        fakeReq("/api/devices/approve", "POST"),
        fakeRes,
        { auth: fakeAuth },
      );
      expect(result).toBe(true);
      expect(vi.mocked(sendJson)).toHaveBeenCalledWith(fakeRes, 200, { ok: true });
    });
  });
});
