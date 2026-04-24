import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayClientOptions } from "./client.js";
import { APPROVALS_SCOPE } from "./method-scopes.js";
import { PROTOCOL_VERSION } from "./protocol/index.js";
import { createDesktopEventsBridge, type DesktopEventsGatewayClient } from "./desktop-events-helper.js";

const { loadConfigMock } = vi.hoisted(() => ({
  loadConfigMock: vi.fn(() => ({
    gateway: {
      mode: "local",
      port: 18789,
      tls: { enabled: false },
      auth: { mode: "none" },
    },
  })),
}));

vi.mock("../config/config.js", () => ({
  loadConfig: loadConfigMock,
  resolveConfigPath: () => "C:\\Users\\testuser\\.openclaw\\openclaw.json",
  resolveGatewayPort: (config: { gateway?: { port?: number } }) => config.gateway?.port ?? 18789,
  resolveStateDir: () => "C:\\Users\\testuser\\.openclaw",
}));

vi.mock("../infra/tls/gateway.js", () => ({
  loadGatewayTlsRuntime: vi.fn(async () => ({ enabled: false })),
}));

type CapturedClient = DesktopEventsGatewayClient & {
  options: Record<string, unknown>;
  requestMock: ReturnType<typeof vi.fn>;
};

function createOutputCapture() {
  const lines: unknown[] = [];
  return {
    output: {
      write: (chunk: string) => {
        const trimmed = chunk.trim();
        if (trimmed) {
          lines.push(JSON.parse(trimmed));
        }
        return true;
      },
    },
    lines,
  };
}

function createFakeClientFactory() {
  const clients: CapturedClient[] = [];
  const factory = vi.fn((options: GatewayClientOptions) => {
    const requestMock = vi.fn(async () => ({ ok: true }));
    const client: CapturedClient = {
      options,
      start: vi.fn(),
      stop: vi.fn(),
      request: requestMock as unknown as DesktopEventsGatewayClient["request"],
      requestMock,
    };
    clients.push(client);
    return client;
  });
  return { factory, clients };
}

describe("desktop-events-helper", () => {
  beforeEach(() => {
    loadConfigMock.mockClear();
  });

  it("connects through GatewayClient with protocol v3 and operator.approvals", async () => {
    const capture = createOutputCapture();
    const { factory, clients } = createFakeClientFactory();
    const bridge = createDesktopEventsBridge({
      url: "ws://127.0.0.1:18789",
      stdout: capture.output,
      clientFactory: factory,
      instanceId: "test-instance",
    });

    await bridge.start();

    expect(factory).toHaveBeenCalledOnce();
    expect(clients[0].options).toMatchObject({
      url: "ws://127.0.0.1:18789",
      instanceId: "test-instance",
      role: "operator",
      scopes: [APPROVALS_SCOPE],
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      clientDisplayName: "Jarvis Desktop Live Bridge",
    });
    expect(clients[0].start).toHaveBeenCalledOnce();
    expect(capture.lines[0]).toMatchObject({
      type: "bridge.state",
      state: "connecting",
      gatewayUrl: "ws://127.0.0.1:18789",
      protocol: PROTOCOL_VERSION,
      scopes: [APPROVALS_SCOPE],
    });
  });

  it("writes bridge.ready after hello", async () => {
    const capture = createOutputCapture();
    const { clients, factory } = createFakeClientFactory();
    const bridge = createDesktopEventsBridge({
      stdout: capture.output,
      clientFactory: factory,
    });

    await bridge.start();

    const onHelloOk = clients[0].options.onHelloOk as (hello: unknown) => void;
    onHelloOk({ protocol: PROTOCOL_VERSION, server: { name: "openclaw" } });

    expect(capture.lines.at(-1)).toMatchObject({
      type: "bridge.ready",
      protocol: PROTOCOL_VERSION,
      role: "operator",
      scopes: [APPROVALS_SCOPE],
    });
  });

  it("emits gateway.event for exec.approval.requested", async () => {
    const capture = createOutputCapture();
    const { clients, factory } = createFakeClientFactory();
    const bridge = createDesktopEventsBridge({
      stdout: capture.output,
      clientFactory: factory,
    });

    await bridge.start();

    const onEvent = clients[0].options.onEvent as (event: unknown) => void;
    onEvent({
      type: "event",
      event: "exec.approval.requested",
      seq: 12,
      payload: { id: "approval-1", request: { command: "npm test" } },
    });

    expect(capture.lines.at(-1)).toMatchObject({
      type: "gateway.event",
      event: "exec.approval.requested",
      seq: 12,
      payload: {
        id: "approval-1",
        request: { command: "npm test" },
      },
    });
  });

  it("stdin approval.resolve calls exec.approval.resolve", async () => {
    const capture = createOutputCapture();
    const { clients, factory } = createFakeClientFactory();
    const bridge = createDesktopEventsBridge({
      stdout: capture.output,
      clientFactory: factory,
    });

    await bridge.start();
    await bridge.handleCommandLine(
      JSON.stringify({
        type: "approval.resolve",
        requestId: "req-1",
        id: "approval-1",
        decision: "allow-once",
      }),
    );

    expect(clients[0].requestMock).toHaveBeenCalledWith("exec.approval.resolve", {
      id: "approval-1",
      decision: "allow-once",
    });
    expect(capture.lines.at(-1)).toMatchObject({
      type: "approval.resolve.result",
      requestId: "req-1",
      id: "approval-1",
      decision: "allow-once",
      ok: true,
    });
  });

  it("malformed stdin returns a structured error without stopping the client", async () => {
    const capture = createOutputCapture();
    const { clients, factory } = createFakeClientFactory();
    const bridge = createDesktopEventsBridge({
      stdout: capture.output,
      clientFactory: factory,
    });

    await bridge.start();
    await bridge.handleCommandLine("{not-json");

    expect(clients[0].stop).not.toHaveBeenCalled();
    expect(capture.lines.at(-1)).toMatchObject({
      type: "bridge.error",
      code: "invalid_json",
    });
  });
});
