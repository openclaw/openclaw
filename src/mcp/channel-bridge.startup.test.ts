import { expect, it, vi } from "vitest";
import type { resolveGatewayClientBootstrap } from "../gateway/client-bootstrap.js";

const mockState = vi.hoisted(() => ({
  clientOptions: null as Record<string, unknown> | null,
}));

// mock-isolation: Startup fixtures supply endpoint/auth facts without reading operator config.
vi.mock("../gateway/client-bootstrap.js", () => ({
  resolveGatewayClientBootstrap: vi.fn<typeof resolveGatewayClientBootstrap>(async () => ({
    url: "wss://127.0.0.1:18789",
    urlSource: "local loopback",
    connectionDetails: {
      url: "wss://127.0.0.1:18789",
      urlSource: "local loopback",
      message: "Gateway target: wss://127.0.0.1:18789",
    },
    tlsFingerprint: "sha256:local",
    auth: { token: undefined, password: undefined },
  })),
}));

// mock-isolation: The hello handshake is controlled without opening a real Gateway connection.
vi.mock("../gateway/client.js", () => ({
  GatewayClient: class MockGatewayClient {
    constructor(options: Record<string, unknown>) {
      mockState.clientOptions = options;
    }

    start(): void {}
    async request(): Promise<void> {}
    async stopAndWait(): Promise<void> {}
  },
}));
// mock-isolation: Start the synthetic client directly without the real event-loop readiness wait.
vi.mock("../../packages/gateway-client/src/readiness.js", () => ({
  startGatewayClientWhenEventLoopReady: vi.fn(async (client: { start: () => void }) => {
    client.start();
    return { ready: true, aborted: false, elapsedMs: 0, maxDriftMs: 0, checks: 1 };
  }),
}));

vi.mock("../gateway/method-scopes.js", () => ({
  APPROVALS_SCOPE: "operator.approvals",
  READ_SCOPE: "operator.read",
  WRITE_SCOPE: "operator.write",
}));

vi.mock("../../packages/gateway-protocol/src/client-info.js", () => ({
  GATEWAY_CLIENT_CAPS: { APPROVALS: "approvals" },
  GATEWAY_CLIENT_MODES: { CLI: "cli" },
  GATEWAY_CLIENT_NAMES: { CLI: "cli" },
}));

const { OpenClawChannelBridge } = await import("./channel-bridge.js");
it("passes resolved TLS identity and waits for the Gateway hello before completing startup", async () => {
  const bridge = new OpenClawChannelBridge({}, { claudeChannelMode: "off", verbose: false });
  const onStarted = vi.fn();
  const started = bridge.start().then(onStarted);
  await vi.waitFor(() => expect(mockState.clientOptions).not.toBeNull());
  expect(onStarted).not.toHaveBeenCalled();
  expect(mockState.clientOptions).toMatchObject({ tlsFingerprint: "sha256:local" });
  expect(mockState.clientOptions?.notifyOnStartupRetry).not.toBe(true);

  const onHelloOk = mockState.clientOptions?.onHelloOk;
  if (typeof onHelloOk !== "function") {
    throw new Error("Expected Gateway hello callback");
  }
  onHelloOk();

  await expect(started).resolves.toBeUndefined();
  await bridge.close();
});
