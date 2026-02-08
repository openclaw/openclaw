import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loadConfig = vi.fn();
const resolveGatewayPort = vi.fn();
const pickPrimaryTailnetIPv4 = vi.fn();
const pickPrimaryLanIPv4 = vi.fn();

let lastClientOptions: {
  url?: string;
  token?: string;
  password?: string;
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

vi.mock("./net.js", () => ({
  pickPrimaryLanIPv4,
}));

vi.mock("./client.js", () => ({
  describeGatewayCloseCode: (code: number) => {
    if (code === 1000) {
      return "normal closure";
    }
    if (code === 1006) {
      return "abnormal closure (no close frame)";
    }
    return undefined;
  },
  GatewayClient: class {
    constructor(opts: {
      url?: string;
      token?: string;
      password?: string;
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

const { buildGatewayConnectionDetails, callGateway } = await import("./call.js");

describe("callGateway url resolution", () => {
  beforeEach(() => {
    loadConfig.mockReset();
    resolveGatewayPort.mockReset();
    pickPrimaryTailnetIPv4.mockReset();
    pickPrimaryLanIPv4.mockReset();
    lastClientOptions = null;
    startMode = "hello";
    closeCode = 1006;
    closeReason = "";
  });

  it("keeps loopback when local bind is auto even if tailnet is present", async () => {
    loadConfig.mockReturnValue({ gateway: { mode: "local", bind: "auto" } });
    resolveGatewayPort.mockReturnValue(18800);
    pickPrimaryTailnetIPv4.mockReturnValue("100.64.0.1");

    await callGateway({ method: "health" });

    expect(lastClientOptions?.url).toBe("ws://127.0.0.1:18800");
  });

  it("falls back to loopback when local bind is auto without tailnet IP", async () => {
    loadConfig.mockReturnValue({ gateway: { mode: "local", bind: "auto" } });
    resolveGatewayPort.mockReturnValue(18800);
    pickPrimaryTailnetIPv4.mockReturnValue(undefined);

    await callGateway({ method: "health" });

    expect(lastClientOptions?.url).toBe("ws://127.0.0.1:18800");
  });

  it("uses tailnet IP when local bind is tailnet and tailnet is present", async () => {
    loadConfig.mockReturnValue({ gateway: { mode: "local", bind: "tailnet" } });
    resolveGatewayPort.mockReturnValue(18800);
    pickPrimaryTailnetIPv4.mockReturnValue("100.64.0.1");

    await callGateway({ method: "health" });

    expect(lastClientOptions?.url).toBe("ws://100.64.0.1:18800");
  });

  it("uses LAN IP when bind is lan and LAN IP is available", async () => {
    loadConfig.mockReturnValue({ gateway: { mode: "local", bind: "lan" } });
    resolveGatewayPort.mockReturnValue(18800);
    pickPrimaryTailnetIPv4.mockReturnValue(undefined);
    pickPrimaryLanIPv4.mockReturnValue("192.168.1.42");

    await callGateway({ method: "health" });

    expect(lastClientOptions?.url).toBe("ws://192.168.1.42:18800");
  });

  it("falls back to loopback when bind is lan but no LAN IP found", async () => {
    loadConfig.mockReturnValue({ gateway: { mode: "local", bind: "lan" } });
    resolveGatewayPort.mockReturnValue(18800);
    pickPrimaryTailnetIPv4.mockReturnValue(undefined);
    pickPrimaryLanIPv4.mockReturnValue(undefined);

    await callGateway({ method: "health" });

    expect(lastClientOptions?.url).toBe("ws://127.0.0.1:18800");
  });

  it("uses url override in remote mode even when remote url is missing", async () => {
    loadConfig.mockReturnValue({
      gateway: { mode: "remote", bind: "loopback", remote: {} },
    });
    resolveGatewayPort.mockReturnValue(18789);
    pickPrimaryTailnetIPv4.mockReturnValue(undefined);

    await callGateway({
      method: "health",
      url: "wss://override.example/ws",
      token: "explicit-token",
    });

    expect(lastClientOptions?.url).toBe("wss://override.example/ws");
    expect(lastClientOptions?.token).toBe("explicit-token");
  });
});

describe("buildGatewayConnectionDetails", () => {
  beforeEach(() => {
    loadConfig.mockReset();
    resolveGatewayPort.mockReset();
    pickPrimaryTailnetIPv4.mockReset();
    pickPrimaryLanIPv4.mockReset();
  });

  it("uses explicit url overrides and omits bind details", () => {
    loadConfig.mockReturnValue({
      gateway: { mode: "local", bind: "loopback" },
    });
    resolveGatewayPort.mockReturnValue(18800);
    pickPrimaryTailnetIPv4.mockReturnValue("100.64.0.1");

    const details = buildGatewayConnectionDetails({
      url: "wss://example.com/ws",
    });

    expect(details.url).toBe("wss://example.com/ws");
    expect(details.urlSource).toBe("cli --url");
    expect(details.bindDetail).toBeUndefined();
    expect(details.remoteFallbackNote).toBeUndefined();
    expect(details.message).toContain("Gateway target: wss://example.com/ws");
    expect(details.message).toContain("Source: cli --url");
  });

  it("emits a remote fallback note when remote url is missing", () => {
    loadConfig.mockReturnValue({
      gateway: { mode: "remote", bind: "loopback", remote: {} },
    });
    resolveGatewayPort.mockReturnValue(18789);
    pickPrimaryTailnetIPv4.mockReturnValue(undefined);

    const details = buildGatewayConnectionDetails();

    expect(details.url).toBe("ws://127.0.0.1:18789");
    expect(details.urlSource).toBe("missing gateway.remote.url (fallback local)");
    expect(details.bindDetail).toBe("Bind: loopback");
    expect(details.remoteFallbackNote).toContain(
      "gateway.mode=remote but gateway.remote.url is missing",
    );
    expect(details.message).toContain("Gateway target: ws://127.0.0.1:18789");
  });

  it("uses LAN IP and reports lan source when bind is lan", () => {
    loadConfig.mockReturnValue({
      gateway: { mode: "local", bind: "lan" },
    });
    resolveGatewayPort.mockReturnValue(18800);
    pickPrimaryTailnetIPv4.mockReturnValue(undefined);
    pickPrimaryLanIPv4.mockReturnValue("10.0.0.5");

    const details = buildGatewayConnectionDetails();

    expect(details.url).toBe("ws://10.0.0.5:18800");
    expect(details.urlSource).toBe("local lan 10.0.0.5");
    expect(details.bindDetail).toBe("Bind: lan");
  });

  it("prefers remote url when configured", () => {
    loadConfig.mockReturnValue({
      gateway: {
        mode: "remote",
        bind: "tailnet",
        remote: { url: "wss://remote.example.com/ws" },
      },
    });
    resolveGatewayPort.mockReturnValue(18800);
    pickPrimaryTailnetIPv4.mockReturnValue("100.64.0.9");

    const details = buildGatewayConnectionDetails();

    expect(details.url).toBe("wss://remote.example.com/ws");
    expect(details.urlSource).toBe("config gateway.remote.url");
    expect(details.bindDetail).toBeUndefined();
    expect(details.remoteFallbackNote).toBeUndefined();
  });
});

describe("callGateway error details", () => {
  beforeEach(() => {
    loadConfig.mockReset();
    resolveGatewayPort.mockReset();
    pickPrimaryTailnetIPv4.mockReset();
    pickPrimaryLanIPv4.mockReset();
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
    loadConfig.mockReturnValue({
      gateway: { mode: "local", bind: "loopback" },
    });
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
    loadConfig.mockReturnValue({
      gateway: { mode: "local", bind: "loopback" },
    });
    resolveGatewayPort.mockReturnValue(18789);
    pickPrimaryTailnetIPv4.mockReturnValue(undefined);

    vi.useFakeTimers();
    let err: Error | null = null;
    const promise = callGateway({ method: "health", timeoutMs: 5 }).catch((caught) => {
      err = caught as Error;
    });

    await vi.advanceTimersByTimeAsync(5);
    await promise;

    expect(err?.message).toContain("gateway timeout after 5ms");
    expect(err?.message).toContain("Gateway target: ws://127.0.0.1:18789");
    expect(err?.message).toContain("Source: local loopback");
    expect(err?.message).toContain("Bind: loopback");
  });

  it("fails fast when remote mode is missing remote url", async () => {
    loadConfig.mockReturnValue({
      gateway: { mode: "remote", bind: "loopback", remote: {} },
    });
    await expect(
      callGateway({
        method: "health",
        timeoutMs: 10,
      }),
    ).rejects.toThrow("gateway remote mode misconfigured");
  });
});

describe("callGateway url override auth requirements", () => {
  beforeEach(() => {
    loadConfig.mockReset();
    resolveGatewayPort.mockReset();
    pickPrimaryTailnetIPv4.mockReset();
    pickPrimaryLanIPv4.mockReset();
    lastClientOptions = null;
    startMode = "hello";
    closeCode = 1006;
    closeReason = "";
    resolveGatewayPort.mockReturnValue(18789);
    pickPrimaryTailnetIPv4.mockReturnValue(undefined);
  });

  afterEach(() => {
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
    delete process.env.OPENCLAW_GATEWAY_PASSWORD;
  });

  it("throws when url override is set without explicit credentials", async () => {
    process.env.OPENCLAW_GATEWAY_TOKEN = "env-token";
    process.env.OPENCLAW_GATEWAY_PASSWORD = "env-password";
    loadConfig.mockReturnValue({
      gateway: {
        mode: "local",
        auth: { token: "local-token", password: "local-password" },
      },
    });

    await expect(
      callGateway({ method: "health", url: "wss://override.example/ws" }),
    ).rejects.toThrow("explicit credentials");
  });
});

describe("callGateway password resolution", () => {
  const originalEnvPassword = process.env.OPENCLAW_GATEWAY_PASSWORD;

  beforeEach(() => {
    loadConfig.mockReset();
    resolveGatewayPort.mockReset();
    pickPrimaryTailnetIPv4.mockReset();
    pickPrimaryLanIPv4.mockReset();
    lastClientOptions = null;
    startMode = "hello";
    closeCode = 1006;
    closeReason = "";
    delete process.env.OPENCLAW_GATEWAY_PASSWORD;
    resolveGatewayPort.mockReturnValue(18789);
    pickPrimaryTailnetIPv4.mockReturnValue(undefined);
  });

  afterEach(() => {
    if (originalEnvPassword == null) {
      delete process.env.OPENCLAW_GATEWAY_PASSWORD;
    } else {
      process.env.OPENCLAW_GATEWAY_PASSWORD = originalEnvPassword;
    }
  });

  it("uses local config password when env is unset", async () => {
    loadConfig.mockReturnValue({
      gateway: {
        mode: "local",
        bind: "loopback",
        auth: { password: "secret" },
      },
    });

    await callGateway({ method: "health" });

    expect(lastClientOptions?.password).toBe("secret");
  });

  it("prefers env password over local config password", async () => {
    process.env.OPENCLAW_GATEWAY_PASSWORD = "from-env";
    loadConfig.mockReturnValue({
      gateway: {
        mode: "local",
        bind: "loopback",
        auth: { password: "from-config" },
      },
    });

    await callGateway({ method: "health" });

    expect(lastClientOptions?.password).toBe("from-env");
  });

  it("uses remote password in remote mode when env is unset", async () => {
    loadConfig.mockReturnValue({
      gateway: {
        mode: "remote",
        remote: { url: "ws://remote.example:18789", password: "remote-secret" },
        auth: { password: "from-config" },
      },
    });

    await callGateway({ method: "health" });

    expect(lastClientOptions?.password).toBe("remote-secret");
  });

  it("prefers env password over remote password in remote mode", async () => {
    process.env.OPENCLAW_GATEWAY_PASSWORD = "from-env";
    loadConfig.mockReturnValue({
      gateway: {
        mode: "remote",
        remote: { url: "ws://remote.example:18789", password: "remote-secret" },
        auth: { password: "from-config" },
      },
    });

    await callGateway({ method: "health" });

    expect(lastClientOptions?.password).toBe("from-env");
  });

  it("uses explicit password when url override is set", async () => {
    process.env.OPENCLAW_GATEWAY_PASSWORD = "from-env";
    loadConfig.mockReturnValue({
      gateway: {
        mode: "local",
        auth: { password: "from-config" },
      },
    });

    await callGateway({
      method: "health",
      url: "wss://override.example/ws",
      password: "explicit-password",
    });

    expect(lastClientOptions?.password).toBe("explicit-password");
  });
});

describe("callGateway token resolution", () => {
  const originalEnvToken = process.env.OPENCLAW_GATEWAY_TOKEN;

  beforeEach(() => {
    loadConfig.mockReset();
    resolveGatewayPort.mockReset();
    pickPrimaryTailnetIPv4.mockReset();
    pickPrimaryLanIPv4.mockReset();
    lastClientOptions = null;
    startMode = "hello";
    closeCode = 1006;
    closeReason = "";
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
    resolveGatewayPort.mockReturnValue(18789);
    pickPrimaryTailnetIPv4.mockReturnValue(undefined);
  });

  afterEach(() => {
    if (originalEnvToken == null) {
      delete process.env.OPENCLAW_GATEWAY_TOKEN;
    } else {
      process.env.OPENCLAW_GATEWAY_TOKEN = originalEnvToken;
    }
  });

  it("uses explicit token when url override is set", async () => {
    process.env.OPENCLAW_GATEWAY_TOKEN = "env-token";
    loadConfig.mockReturnValue({
      gateway: {
        mode: "local",
        auth: { token: "local-token" },
      },
    });

    await callGateway({
      method: "health",
      url: "wss://override.example/ws",
      token: "explicit-token",
    });

    expect(lastClientOptions?.token).toBe("explicit-token");
  });
});
