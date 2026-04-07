import { afterEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";

const gatewayClientState = vi.hoisted(() => ({
  lastOptions: undefined as Record<string, unknown> | undefined,
}));

vi.mock("./client.js", () => ({
  GatewayClient: class MockGatewayClient {
    constructor(options: Record<string, unknown>) {
      gatewayClientState.lastOptions = options;
    }

    start() {
      const options = gatewayClientState.lastOptions as
        | { onHelloOk?: (hello: { type: "hello-ok" }) => void }
        | undefined;
      queueMicrotask(() => options?.onHelloOk?.({ type: "hello-ok" }));
    }

    async stopAndWait() {}
  },
}));

describe("gateway cli backend live helpers", () => {
  afterEach(() => {
    gatewayClientState.lastOptions = undefined;
    delete process.env.OPENCLAW_SKIP_CHANNELS;
    delete process.env.OPENCLAW_SKIP_GMAIL_WATCHER;
    delete process.env.OPENCLAW_SKIP_CRON;
    delete process.env.OPENCLAW_SKIP_CANVAS_HOST;
    delete process.env.OPENCLAW_SKIP_BROWSER_CONTROL_SERVER;
    delete process.env.OPENCLAW_TEST_MINIMAL_GATEWAY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY_OLD;
  });

  it("applies and restores live env including minimal gateway mode", async () => {
    const { applyCliBackendLiveEnv, restoreCliBackendLiveEnv, snapshotCliBackendLiveEnv } =
      await import("./gateway-cli-backend.live-helpers.js");

    process.env.OPENCLAW_SKIP_CHANNELS = "old-channels";
    process.env.OPENCLAW_SKIP_GMAIL_WATCHER = "old-gmail";
    process.env.OPENCLAW_SKIP_CRON = "old-cron";
    process.env.OPENCLAW_SKIP_CANVAS_HOST = "old-canvas";
    process.env.OPENCLAW_SKIP_BROWSER_CONTROL_SERVER = "old-browser";
    process.env.OPENCLAW_TEST_MINIMAL_GATEWAY = "old-minimal";
    process.env.ANTHROPIC_API_KEY = "old-anthropic";
    process.env.ANTHROPIC_API_KEY_OLD = "old-anthropic-old";

    const snapshot = snapshotCliBackendLiveEnv();
    applyCliBackendLiveEnv(new Set<string>());

    expect(process.env.OPENCLAW_SKIP_CHANNELS).toBe("1");
    expect(process.env.OPENCLAW_SKIP_GMAIL_WATCHER).toBe("1");
    expect(process.env.OPENCLAW_SKIP_CRON).toBe("1");
    expect(process.env.OPENCLAW_SKIP_CANVAS_HOST).toBe("1");
    expect(process.env.OPENCLAW_SKIP_BROWSER_CONTROL_SERVER).toBe("1");
    expect(process.env.OPENCLAW_TEST_MINIMAL_GATEWAY).toBe("1");
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(process.env.ANTHROPIC_API_KEY_OLD).toBeUndefined();

    restoreCliBackendLiveEnv(snapshot);

    expect(process.env.OPENCLAW_SKIP_CHANNELS).toBe("old-channels");
    expect(process.env.OPENCLAW_SKIP_GMAIL_WATCHER).toBe("old-gmail");
    expect(process.env.OPENCLAW_SKIP_CRON).toBe("old-cron");
    expect(process.env.OPENCLAW_SKIP_CANVAS_HOST).toBe("old-canvas");
    expect(process.env.OPENCLAW_SKIP_BROWSER_CONTROL_SERVER).toBe("old-browser");
    expect(process.env.OPENCLAW_TEST_MINIMAL_GATEWAY).toBe("old-minimal");
    expect(process.env.ANTHROPIC_API_KEY).toBe("old-anthropic");
    expect(process.env.ANTHROPIC_API_KEY_OLD).toBe("old-anthropic-old");
  });

  it("builds the live gateway client with test identity defaults", async () => {
    const { connectTestGatewayClient } = await import("./gateway-cli-backend.live-helpers.js");

    const client = await connectTestGatewayClient({
      url: "ws://127.0.0.1:18789",
      token: "gateway-token",
    });

    expect(client).toBeTruthy();
    expect(gatewayClientState.lastOptions).toMatchObject({
      url: "ws://127.0.0.1:18789",
      token: "gateway-token",
      clientName: GATEWAY_CLIENT_NAMES.TEST,
      clientDisplayName: "vitest-live",
      clientVersion: "dev",
      mode: GATEWAY_CLIENT_MODES.TEST,
      connectChallengeTimeoutMs: 30_000,
    });
    expect(gatewayClientState.lastOptions).not.toHaveProperty("requestTimeoutMs");
  });
});
