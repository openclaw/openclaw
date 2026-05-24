import { beforeEach, describe, expect, it, vi } from "vitest";

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
  auth: { token: "secret" as string | undefined, password: undefined as string | undefined },
}));

class MockGatewayClient {
  private readonly opts: Record<string, unknown>;

  constructor(opts: Record<string, unknown>) {
    this.opts = opts;
    clientState.options = opts;
  }

  start(): void {
    void Promise.resolve()
      .then(async () => {
        if (clientState.startMode === "close") {
          const onClose = this.opts.onClose;
          if (typeof onClose === "function") {
            onClose(clientState.close.code, clientState.close.reason);
          }
          return;
        }
        const onHelloOk = this.opts.onHelloOk;
        if (typeof onHelloOk === "function") {
          await onHelloOk();
        }
      })
      .catch(() => {});
  }

  async request(method: string, params: unknown): Promise<unknown> {
    return await clientState.requestSpy(method, params);
  }

  stop(): void {
    clientState.stopSpy();
  }

  async stopAndWait(): Promise<void> {
    await clientState.stopAndWaitSpy();
  }
}

vi.mock("./client-bootstrap.js", () => ({
  resolveGatewayClientBootstrap: vi.fn(async () => ({
    url: bootstrapState.url,
    auth: bootstrapState.auth,
  })),
}));

vi.mock("./client.js", () => ({
  GatewayClient: MockGatewayClient,
}));

const { injectChatMessageOverGateway } = await import("./operator-chat-client.js");

describe("injectChatMessageOverGateway", () => {
  beforeEach(() => {
    clientState.options = null;
    clientState.startMode = "hello";
    clientState.close = { code: 1008, reason: "pairing required" };
    clientState.requestSpy.mockReset().mockResolvedValue({ ok: true, messageId: "msg-123" });
    clientState.stopSpy.mockReset();
    clientState.stopAndWaitSpy.mockReset().mockResolvedValue(undefined);
    bootstrapState.url = "ws://127.0.0.1:18789";
    bootstrapState.auth = { token: "secret", password: undefined };
  });

  it("injects a metadata-bearing chat message through a narrow admin-scoped helper", async () => {
    const result = await injectChatMessageOverGateway({
      config: {} as never,
      clientDisplayName: "AgentKit approval update",
      sessionKey: "session-123",
      message: "World verification failed.",
      label: "AgentKit",
      idempotencyKey: "plugin-approval:req-123:world-failure",
      command: true,
      interactive: { kind: "approval", approvalId: "req-123" },
      channelData: { approvalKind: "plugin", approvalId: "req-123" },
    });

    expect(result).toEqual({ ok: true, messageId: "msg-123" });
    expect(clientState.options?.scopes).toEqual(["operator.admin"]);
    expect(clientState.options).not.toHaveProperty("approvalRuntimeToken");
    expect(clientState.options?.deviceIdentity).toBeNull();
    expect(clientState.requestSpy).toHaveBeenCalledWith("chat.inject", {
      sessionKey: "session-123",
      message: "World verification failed.",
      label: "AgentKit",
      idempotencyKey: "plugin-approval:req-123:world-failure",
      command: true,
      interactive: { kind: "approval", approvalId: "req-123" },
      channelData: { approvalKind: "plugin", approvalId: "req-123" },
    });
    expect(clientState.stopAndWaitSpy).toHaveBeenCalledTimes(1);
  });

  it("returns successful duplicate injections without a message id", async () => {
    clientState.requestSpy.mockResolvedValueOnce({ ok: true, deduped: true });

    await expect(
      injectChatMessageOverGateway({
        config: {} as never,
        sessionKey: "session-123",
        message: "World verification failed.",
        idempotencyKey: "plugin-approval:req-123:world-failure",
      }),
    ).resolves.toEqual({ ok: true, deduped: true });
  });

  it("rejects invalid chat.inject response payloads", async () => {
    clientState.requestSpy.mockResolvedValueOnce({ ok: true });

    await expect(
      injectChatMessageOverGateway({
        config: {} as never,
        sessionKey: "session-123",
        message: "World verification failed.",
      }),
    ).rejects.toThrow("Gateway chat.inject returned an invalid response.");
  });

  it("keeps device identity for remote shared-auth clients", async () => {
    bootstrapState.url = "wss://gateway.example/ws";

    await injectChatMessageOverGateway({
      config: {} as never,
      sessionKey: "session-123",
      message: "World verification failed.",
    });

    expect(clientState.options).not.toHaveProperty("deviceIdentity", null);
    expect(clientState.options?.deviceIdentity).toBeUndefined();
  });

  it("keeps device identity for loopback clients without shared auth", async () => {
    bootstrapState.auth = { token: undefined, password: undefined };

    await injectChatMessageOverGateway({
      config: {} as never,
      sessionKey: "session-123",
      message: "World verification failed.",
    });

    expect(clientState.options?.deviceIdentity).toBeUndefined();
  });

  it("surfaces close failures before hello", async () => {
    clientState.startMode = "close";

    await expect(
      injectChatMessageOverGateway({
        config: {} as never,
        sessionKey: "session-123",
        message: "World verification failed.",
      }),
    ).rejects.toThrow("gateway closed (1008): pairing required");
  });

  it("falls back to stop when stopAndWait rejects", async () => {
    clientState.stopAndWaitSpy.mockRejectedValueOnce(new Error("close failed"));

    await injectChatMessageOverGateway({
      config: {} as never,
      sessionKey: "session-123",
      message: "World verification failed.",
    });

    expect(clientState.stopAndWaitSpy).toHaveBeenCalledTimes(1);
    expect(clientState.stopSpy).toHaveBeenCalledTimes(1);
  });
});
