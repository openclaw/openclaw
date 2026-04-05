import { describe, expect, it, vi } from "vitest";
import { resolveNodeCommandAllowlist } from "../node-command-policy.js";
import { nodeHandlers } from "./nodes.js";

describe("http.request node command", () => {
  it("includes http.request in Android platform allowlist", () => {
    const allowlist = resolveNodeCommandAllowlist(
      {},
      { platform: "android 16", deviceFamily: "Android" },
    );
    expect(allowlist.has("http.request")).toBe(true);
  });

  it("does NOT include http.request in iOS allowlist", () => {
    const allowlist = resolveNodeCommandAllowlist(
      {},
      { platform: "ios 26.0", deviceFamily: "iPhone" },
    );
    expect(allowlist.has("http.request")).toBe(false);
  });

  it("does NOT include http.request in macOS allowlist", () => {
    const allowlist = resolveNodeCommandAllowlist(
      {},
      { platform: "macos 14", deviceFamily: "Mac" },
    );
    expect(allowlist.has("http.request")).toBe(false);
  });

  it("rejects http.request when node is not connected", async () => {
    const respond = vi.fn();
    await nodeHandlers["node.invoke"]({
      params: {
        nodeId: "android-node-1",
        command: "http.request",
        params: { url: "https://example.com" },
        timeoutMs: 5000,
        idempotencyKey: "idem-http-request",
      },
      respond: respond as never,
      context: {
        nodeRegistry: {
          get: vi.fn(() => undefined),
          invoke: vi.fn(),
        },
        execApprovalManager: undefined,
        logGateway: { info: vi.fn(), warn: vi.fn() },
      } as never,
      client: null,
      req: { type: "req", id: "req-node-invoke", method: "node.invoke" },
      isWebchatConnect: () => false,
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "UNAVAILABLE",
        message: "node not connected",
      }),
    );
  });

  it("returns success when http.request is invoked on connected Android node", async () => {
    const respond = vi.fn();
    const mockInvoke = vi.fn().mockResolvedValue({
      ok: true,
      payload: { status: 200, body: "response body" },
      payloadJSON: '{"status":200,"body":"response body"}',
    });

    await nodeHandlers["node.invoke"]({
      params: {
        nodeId: "android-node-1",
        command: "http.request",
        params: { url: "https://example.com" },
        timeoutMs: 5000,
        idempotencyKey: "idem-http-request",
      },
      respond: respond as never,
      context: {
        nodeRegistry: {
          get: vi.fn(() => ({
            nodeId: "android-node-1",
            commands: ["http.request"],
            platform: "Android 16",
          })),
          invoke: mockInvoke,
        },
        execApprovalManager: undefined,
        logGateway: { info: vi.fn(), warn: vi.fn() },
      } as never,
      client: {
        connect: {
          minProtocol: 1,
          maxProtocol: 3,
          commands: ["http.request"],
          role: "node",
          client: {
            id: "test",
            mode: "node",
            displayName: "android-test",
            platform: "Android 16",
            version: "test",
          },
        },
      },
      req: { type: "req", id: "req-node-invoke", method: "node.invoke" },
      isWebchatConnect: () => false,
    });

    expect(mockInvoke).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeId: "android-node-1",
        command: "http.request",
        params: { url: "https://example.com" },
      }),
    );

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        ok: true,
        nodeId: "android-node-1",
        payload: { status: 200, body: "response body" },
      }),
      undefined,
    );
  });

  it("rejects http.request when command not in allowlist", async () => {
    const respond = vi.fn();
    await nodeHandlers["node.invoke"]({
      params: {
        nodeId: "ios-node-1",
        command: "http.request",
        params: { url: "https://example.com" },
        timeoutMs: 5000,
        idempotencyKey: "idem-http-request",
      },
      respond: respond as never,
      context: {
        nodeRegistry: {
          get: vi.fn(() => ({
            nodeId: "ios-node-1",
            commands: ["http.request"],
            platform: "iOS 26.0",
          })),
          invoke: vi.fn(),
        },
        execApprovalManager: undefined,
        logGateway: { info: vi.fn(), warn: vi.fn() },
      } as never,
      client: {
        connect: {
          minProtocol: 1,
          maxProtocol: 3,
          commands: ["http.request"],
          role: "node",
          client: {
            id: "test",
            mode: "node",
            displayName: "ios-test",
            platform: "iOS 26.0",
            version: "test",
          },
        },
      },
      req: { type: "req", id: "req-node-invoke", method: "node.invoke" },
      isWebchatConnect: () => false,
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: expect.stringContaining("not in the allowlist"),
      }),
    );
  });

  it("returns error when http.request node returns an error", async () => {
    const respond = vi.fn();
    const mockInvoke = vi.fn().mockResolvedValue({
      ok: false,
      error: {
        code: "INVALID_URL",
        message: "Invalid URL provided",
      },
    });

    await nodeHandlers["node.invoke"]({
      params: {
        nodeId: "android-node-1",
        command: "http.request",
        params: { url: "not-a-valid-url" },
        timeoutMs: 5000,
        idempotencyKey: "idem-http-request-error",
      },
      respond: respond as never,
      context: {
        nodeRegistry: {
          get: vi.fn(() => ({
            nodeId: "android-node-1",
            commands: ["http.request"],
            platform: "Android 16",
          })),
          invoke: mockInvoke,
        },
        execApprovalManager: undefined,
        logGateway: { info: vi.fn(), warn: vi.fn() },
      } as never,
      client: {
        connect: {
          minProtocol: 1,
          maxProtocol: 3,
          commands: ["http.request"],
          role: "node",
          client: {
            id: "test",
            mode: "node",
            displayName: "android-test",
            platform: "Android 16",
            version: "test",
          },
        },
      },
      req: { type: "req", id: "req-node-invoke", method: "node.invoke" },
      isWebchatConnect: () => false,
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "UNAVAILABLE",
        message: expect.stringContaining("Invalid URL provided"),
      }),
    );
  });
});
