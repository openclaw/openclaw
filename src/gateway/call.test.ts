import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loadConfig = vi.fn();
const resolveGatewayPort = vi.fn();
const pickPrimaryTailnetIPv4 = vi.fn();

let lastClientOptions: {
  url?: string;
  onHelloOk?: () => void | Promise<void>;
  onClose?: (code: number, reason: string) => void;
} | null = null;
type StartMode = "hello" | "close" | "silent";
let startMode: StartMode = "hello";
let closeCode = 1006;
let closeReason = "";

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
  describeGatewayCloseCode: (code: number) => {
    if (code === 1000) return "normal closure";
    if (code === 1006) return "abnormal closure (no close frame)";
    return undefined;
  },
  GatewayClient: class {
    constructor(opts: {
      url?: string;
      onHelloOk?: () => void | Promise<void>;
      onClose?: (code: number, reason: string) => void;
    }) {
      lastClientOptions = opts;
    }
    async request() {
      return { ok: true };
    }
    start() {
      if (startMode === "hello") {
        void lastClientOptions?.onHelloOk?.();
      } else if (startMode === "close") {
        lastClientOptions?.onClose?.(closeCode, closeReason);
      }
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
    startMode = "hello";
    closeCode = 1006;
    closeReason = "";
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

describe("callGateway error details", () => {
  beforeEach(() => {
    loadConfig.mockReset();
    resolveGatewayPort.mockReset();
    pickPrimaryTailnetIPv4.mockReset();
    lastClientOptions = null;
    startMode = "hello";
    closeCode = 1006;
    closeReason = "";
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("includes connection details when the gateway closes", async () => {
    startMode = "close";
    closeCode = 1006;
    closeReason = "";
    loadConfig.mockReturnValue({ gateway: { mode: "local", bind: "loopback" } });
    resolveGatewayPort.mockReturnValue(18789);
    pickPrimaryTailnetIPv4.mockReturnValue(undefined);

    let err: Error | null = null;
    try {
      await callGateway({ method: "health" });
    } catch (caught) {
      err = caught as Error;
    }

    expect(err?.message).toContain("gateway closed (1006");
    expect(err?.message).toContain("Gateway target: ws://127.0.0.1:18789");
    expect(err?.message).toContain("Source: local loopback");
    expect(err?.message).toContain("Bind: loopback");
  });

  it("includes connection details on timeout", async () => {
    startMode = "silent";
    loadConfig.mockReturnValue({ gateway: { mode: "local", bind: "loopback" } });
    resolveGatewayPort.mockReturnValue(18789);
    pickPrimaryTailnetIPv4.mockReturnValue(undefined);

    vi.useFakeTimers();
    let err: Error | null = null;
    const promise = callGateway({ method: "health", timeoutMs: 5 }).catch(
      (caught) => {
        err = caught as Error;
      },
    );

    await vi.advanceTimersByTimeAsync(5);
    await promise;

    expect(err?.message).toContain("gateway timeout after 5ms");
    expect(err?.message).toContain("Gateway target: ws://127.0.0.1:18789");
    expect(err?.message).toContain("Source: local loopback");
    expect(err?.message).toContain("Bind: loopback");
  });
});
