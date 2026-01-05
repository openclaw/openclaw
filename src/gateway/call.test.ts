import { beforeEach, describe, expect, it, vi } from "vitest";

const loadConfig = vi.fn();
const resolveGatewayPort = vi.fn();
const pickPrimaryTailnetIPv4 = vi.fn();

let lastClientOptions: {
  url?: string;
  onHelloOk?: () => void | Promise<void>;
} | null = null;

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig,
    resolveGatewayPort,
  };
});

vi.mock("../infra/tailnet.js", () => ({
  pickPrimaryTailnetIPv4,
}));

vi.mock("./client.js", () => ({
  GatewayClient: class {
    constructor(opts: {
      url?: string;
      onHelloOk?: () => void | Promise<void>;
    }) {
      lastClientOptions = opts;
    }
    async request() {
      return { ok: true };
    }
    start() {
      void lastClientOptions?.onHelloOk?.();
    }
    stop() {}
  },
}));

const { callGateway } = await import("./call.js");

describe("callGateway url resolution", () => {
  beforeEach(() => {
    loadConfig.mockReset();
    resolveGatewayPort.mockReset();
    pickPrimaryTailnetIPv4.mockReset();
    lastClientOptions = null;
  });

  it("uses tailnet IP when local bind is tailnet", async () => {
    loadConfig.mockReturnValue({ gateway: { mode: "local", bind: "tailnet" } });
    resolveGatewayPort.mockReturnValue(18800);
    pickPrimaryTailnetIPv4.mockReturnValue("100.64.0.1");

    await callGateway({ method: "health" });

    expect(lastClientOptions?.url).toBe("ws://100.64.0.1:18800");
  });

  it("uses tailnet IP when local bind is auto and tailnet is present", async () => {
    loadConfig.mockReturnValue({ gateway: { mode: "local", bind: "auto" } });
    resolveGatewayPort.mockReturnValue(18800);
    pickPrimaryTailnetIPv4.mockReturnValue("100.64.0.2");

    await callGateway({ method: "health" });

    expect(lastClientOptions?.url).toBe("ws://100.64.0.2:18800");
  });

  it("falls back to loopback when local bind is auto without tailnet IP", async () => {
    loadConfig.mockReturnValue({ gateway: { mode: "local", bind: "auto" } });
    resolveGatewayPort.mockReturnValue(18800);
    pickPrimaryTailnetIPv4.mockReturnValue(undefined);

    await callGateway({ method: "health" });

    expect(lastClientOptions?.url).toBe("ws://127.0.0.1:18800");
  });
});
