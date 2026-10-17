import { beforeEach, describe, expect, it, vi } from "vitest";
import type { resolveGatewayClientBootstrap } from "./client-bootstrap.js";

const clientState = vi.hoisted(() => ({
  options: null as Record<string, unknown> | null,
  startMode: "hello" as "hello" | "close",
  close: { code: 1008, reason: "pairing required" },
  requestSpy: vi.fn(),
  stopSpy: vi.fn(),
  stopAndWaitSpy: vi.fn(async () => undefined),
}));

const bootstrapState = vi.hoisted(() => ({
  url: "ws://127.0.0.1:18789",
  urlSource: "local loopback",
  auth: { token: "secret" as string | undefined, password: undefined as string | undefined },
  tlsFingerprint: undefined as string | undefined,
}));

class MockGatewayClient {
  constructor(private readonly opts: Record<string, unknown>) {
    clientState.options = opts;
  }

  start(): void {
    void Promise.resolve()
      .then(async () => {
        const { onClose, onHelloOk } = this.opts;
        if (clientState.startMode === "close") {
          if (typeof onClose === "function") {
            onClose(clientState.close.code, clientState.close.reason);
          }
          return;
        }
        if (typeof onHelloOk === "function") {
          await onHelloOk();
        }
      })
      .catch(() => {});
  }

  request = clientState.requestSpy;
  stop = clientState.stopSpy;
  stopAndWait = clientState.stopAndWaitSpy;
}

vi.mock("./client-bootstrap.js", () => ({
  resolveGatewayClientBootstrap: async () =>
    ({
      url: bootstrapState.url,
      urlSource: bootstrapState.urlSource,
      connectionDetails: {
        url: bootstrapState.url,
        urlSource: bootstrapState.urlSource,
        message: `Gateway target: ${bootstrapState.url}`,
      },
      auth: bootstrapState.auth,
      tlsFingerprint: bootstrapState.tlsFingerprint,
    }) satisfies Awaited<ReturnType<typeof resolveGatewayClientBootstrap>>,
}));

vi.mock("./client.js", () => ({
  GatewayClient: MockGatewayClient,
}));

const { withOperatorApprovalsGatewayClient } = await import("./operator-approvals-client.js");

async function runOperatorApprovalsGatewayClient(
  params: { gatewayUrl?: string } = {},
  callback: Parameters<typeof withOperatorApprovalsGatewayClient>[1] = async () => undefined,
) {
  await withOperatorApprovalsGatewayClient(
    {
      config: {},
      clientDisplayName: "Matrix approval (@owner:example.org)",
      ...params,
    },
    callback,
  );
}

describe("withOperatorApprovalsGatewayClient", () => {
  beforeEach(() => {
    clientState.options = null;
    clientState.startMode = "hello";
    clientState.close = { code: 1008, reason: "pairing required" };
    clientState.requestSpy.mockReset().mockResolvedValue(undefined);
    clientState.stopSpy.mockReset();
    clientState.stopAndWaitSpy.mockReset().mockResolvedValue(undefined);
    bootstrapState.url = "ws://127.0.0.1:18789";
    bootstrapState.urlSource = "local loopback";
    bootstrapState.auth = { token: "secret", password: undefined };
    bootstrapState.tlsFingerprint = undefined;
  });

  it("waits for hello before running the callback and stops cleanly", async () => {
    const request = { id: "req-123", decision: "allow-once" };
    await runOperatorApprovalsGatewayClient({}, async (client) => {
      await client.request("exec.approval.resolve", request);
    });

    expect(clientState.options?.scopes).toEqual(["operator.approvals"]);
    expect(clientState.options?.caps).toEqual(["approvals"]);
    expect(typeof clientState.options?.approvalRuntimeToken).toBe("string");
    expect(clientState.options?.deviceIdentity).toBeNull();
    expect(clientState.requestSpy).toHaveBeenCalledWith("exec.approval.resolve", request);
    expect(clientState.stopAndWaitSpy).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["config gateway.remote.url", "wss://gateway.example/ws", undefined, "sha256:remote"],
    ["env OPENCLAW_GATEWAY_URL", "ws://127.0.0.1:18789", undefined, undefined],
    ["cli --url", "ws://127.0.0.1:18789", "ws://127.0.0.1:18789", undefined],
    ["cli --url", "wss://gateway.example/ws", "wss://gateway.example/ws", undefined],
    ["config gateway.remote.url", "ws://127.0.0.1:18789", undefined, undefined],
  ] as const)(
    "omits process-local authority for %s (%s)",
    async (urlSource, url, gatewayUrl, fingerprint) => {
      bootstrapState.url = url;
      bootstrapState.urlSource = urlSource;
      bootstrapState.tlsFingerprint = fingerprint;

      await runOperatorApprovalsGatewayClient(gatewayUrl ? { gatewayUrl } : {});
      expect(clientState.options).not.toHaveProperty("deviceIdentity", null);
      expect(clientState.options?.deviceIdentity).toBeUndefined();
      expect(clientState.options).not.toHaveProperty("approvalRuntimeToken");
      expect(clientState.options?.tlsFingerprint).toBe(fingerprint);
    },
  );

  it("keeps approval runtime token for local fallback gateway URLs", async () => {
    bootstrapState.url = "ws://127.0.0.1:18789";
    bootstrapState.urlSource = "missing gateway.remote.url (fallback local)";

    await runOperatorApprovalsGatewayClient();

    expect(typeof clientState.options?.approvalRuntimeToken).toBe("string");
    expect(clientState.options?.deviceIdentity).toBeNull();
  });

  it("surfaces close failures before hello", async () => {
    clientState.startMode = "close";

    await expect(runOperatorApprovalsGatewayClient()).rejects.toThrow(
      "gateway closed (1008): pairing required",
    );
  });

  it("falls back to stop when stopAndWait rejects", async () => {
    clientState.stopAndWaitSpy.mockRejectedValueOnce(new Error("close failed"));

    await runOperatorApprovalsGatewayClient();

    expect(clientState.stopAndWaitSpy).toHaveBeenCalledTimes(1);
    expect(clientState.stopSpy).toHaveBeenCalledTimes(1);
  });
});
