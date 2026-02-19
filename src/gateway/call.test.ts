import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureEnv } from "../test-utils/env.js";
import {
  loadConfigMock as loadConfig,
  pickPrimaryLanIPv4Mock as pickPrimaryLanIPv4,
  pickPrimaryTailnetIPv4Mock as pickPrimaryTailnetIPv4,
  resolveGatewayPortMock as resolveGatewayPort,
} from "./gateway-connection.test-mocks.js";

let lastClientOptions: {
  url?: string;
  token?: string;
  password?: string;
  scopes?: string[];
  onHelloOk?: () => void | Promise<void>;
  onClose?: (code: number, reason: string) => void;
} | null = null;
type StartMode = "hello" | "close" | "silent";
let startMode: StartMode = "hello";
let closeCode = 1006;
let closeReason = "";

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
      scopes?: string[];
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

const { buildGatewayConnectionDetails, callGateway, callGatewayCli, callGatewayScoped } =
  await import("./call.js");

function resetGatewayCallMocks() {
  loadConfig.mockClear();
  resolveGatewayPort.mockClear();
  pickPrimaryTailnetIPv4.mockClear();
  pickPrimaryLanIPv4.mockClear();
  lastClientOptions = null;
  startMode = "hello";
  closeCode = 1006;
  closeReason = "";
}

function setGatewayNetworkDefaults(port = 18789) {
  resolveGatewayPort.mockReturnValue(port);
  pickPrimaryTailnetIPv4.mockReturnValue(undefined);
}

function setLocalLoopbackGatewayConfig(port = 18789) {
  loadConfig.mockReturnValue({ gateway: { mode: "local", bind: "loopback" } });
  setGatewayNetworkDefaults(port);
}

function makeRemotePasswordGatewayConfig(remotePassword: string, localPassword = "from-config") {
  return {
    gateway: {
      mode: "remote",
      remote: { url: "wss://remote.example:18789", password: remotePassword },
      auth: { password: localPassword },
    },
  };
}

describe("callGateway url resolution", () => {
  beforeEach(() => {
    resetGatewayCallMocks();
  });

  it.each([
    {
      label: "keeps loopback when local bind is auto even if tailnet is present",
      tailnetIp: "100.64.0.1",
    },
    {
      label: "falls back to loopback when local bind is auto without tailnet IP",
      tailnetIp: undefined,
    },
  ])("local auto-bind: $label", async ({ tailnetIp }) => {
    loadConfig.mockReturnValue({ gateway: { mode: "local", bind: "auto" } });
    resolveGatewayPort.mockReturnValue(18800);
    pickPrimaryTailnetIPv4.mockReturnValue(tailnetIp);

    await callGateway({ method: "health" });

    expect(lastClientOptions?.url).toBe("ws://127.0.0.1:18800");
  });

  it.each([
    {
      label: "tailnet with TLS",
      gateway: { mode: "local", bind: "tailnet", tls: { enabled: true } },
      tailnetIp: "100.64.0.1",
      lanIp: undefined,
      expectedUrl: "wss://127.0.0.1:18800",
    },
    {
      label: "tailnet without TLS",
      gateway: { mode: "local", bind: "tailnet" },
      tailnetIp: "100.64.0.1",
      lanIp: undefined,
      expectedUrl: "ws://127.0.0.1:18800",
    },
    {
      label: "lan with TLS",
      gateway: { mode: "local", bind: "lan", tls: { enabled: true } },
      tailnetIp: undefined,
      lanIp: "192.168.1.42",
      expectedUrl: "wss://192.168.1.42:18800",
    },
    {
      label: "lan without TLS",
      gateway: { mode: "local", bind: "lan" },
      tailnetIp: undefined,
      lanIp: "192.168.1.42",
      expectedUrl: "ws://192.168.1.42:18800",
    },
    {
      label: "lan without discovered LAN IP",
      gateway: { mode: "local", bind: "lan" },
      tailnetIp: undefined,
      lanIp: undefined,
      expectedUrl: "ws://127.0.0.1:18800",
    },
  ])("uses loopback for $label", async ({ gateway, tailnetIp, lanIp, expectedUrl }) => {
    loadConfig.mockReturnValue({ gateway });
    resolveGatewayPort.mockReturnValue(18800);
    pickPrimaryTailnetIPv4.mockReturnValue(tailnetIp);
    pickPrimaryLanIPv4.mockReturnValue(lanIp);

    await callGateway({ method: "health" });

    expect(lastClientOptions?.url).toBe(expectedUrl);
  });

  it("allows ws:// to LAN IP when bind=lan (locally resolved, Docker-safe)", async () => {
    loadConfig.mockReturnValue({ gateway: { mode: "local", bind: "lan" } });
    resolveGatewayPort.mockReturnValue(18800);
    pickPrimaryTailnetIPv4.mockReturnValue(undefined);
    pickPrimaryLanIPv4.mockReturnValue("192.168.1.42");

    // Should NOT throw SECURITY ERROR — bind=lan means the user opted into
    // LAN binding, and the URL was locally resolved (not user-provided).
    const result = await callGateway({ method: "health" });
    expect(result).toEqual({ ok: true });
  });

  it("blocks user-provided ws:// to private network even when bind=lan", async () => {
    loadConfig.mockReturnValue({ gateway: { mode: "local", bind: "lan" } });
    resolveGatewayPort.mockReturnValue(18789);
    pickPrimaryLanIPv4.mockReturnValue("192.168.1.42");

    // User-provided URL override bypasses locally-resolved exemption —
    // private network ws:// is only safe when locally resolved.
    await expect(
      callGateway({ method: "health", url: "ws://192.168.1.100:18789", token: "t" }),
    ).rejects.toThrow("SECURITY ERROR");
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

  it.each([
    {
      label: "uses least-privilege scopes by default for non-CLI callers",
      call: () => callGateway({ method: "health" }),
      expectedScopes: ["operator.read"],
    },
    {
      label: "keeps legacy admin scopes for explicit CLI callers",
      call: () => callGatewayCli({ method: "health" }),
      expectedScopes: [
        "operator.admin",
        "operator.read",
        "operator.write",
        "operator.approvals",
        "operator.pairing",
      ],
    },
  ])("scope selection: $label", async ({ call, expectedScopes }) => {
    setLocalLoopbackGatewayConfig();
    await call();
    expect(lastClientOptions?.scopes).toEqual(expectedScopes);
  });

  it("passes explicit scopes through, including empty arrays", async () => {
    setLocalLoopbackGatewayConfig();

    await callGatewayScoped({ method: "health", scopes: ["operator.read"] });
    expect(lastClientOptions?.scopes).toEqual(["operator.read"]);

    await callGatewayScoped({ method: "health", scopes: [] });
    expect(lastClientOptions?.scopes).toEqual([]);
  });
});

describe("buildGatewayConnectionDetails", () => {
  beforeEach(() => {
    resetGatewayCallMocks();
  });

  it("uses explicit url overrides and omits bind details", () => {
    setLocalLoopbackGatewayConfig(18800);
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

  it.each([
    {
      label: "with TLS",
      gateway: { mode: "local", bind: "lan", tls: { enabled: true } },
      expectedUrl: "wss://10.0.0.5:18800",
    },
    {
      label: "without TLS",
      gateway: { mode: "local", bind: "lan" },
      expectedUrl: "ws://10.0.0.5:18800",
    },
  ])("uses LAN URL for bind=lan $label", ({ gateway, expectedUrl }) => {
    loadConfig.mockReturnValue({ gateway });
    resolveGatewayPort.mockReturnValue(18800);
    pickPrimaryTailnetIPv4.mockReturnValue(undefined);
    pickPrimaryLanIPv4.mockReturnValue("10.0.0.5");

    const details = buildGatewayConnectionDetails();

    expect(details.url).toBe(expectedUrl);
    expect(details.urlSource).toBe("local lan 10.0.0.5");
    expect(details.bindDetail).toBe("Bind: lan");
  });

  it("allows ws:// to LAN IP when bind=lan (locally resolved, Docker-safe)", () => {
    loadConfig.mockReturnValue({
      gateway: { mode: "local", bind: "lan" },
    });
    resolveGatewayPort.mockReturnValue(18800);
    pickPrimaryTailnetIPv4.mockReturnValue(undefined);
    pickPrimaryLanIPv4.mockReturnValue("10.0.0.5");

    // bind=lan with locally resolved URL should be allowed — traffic
    // stays on the host (Docker bridge, LAN interface).
    const details = buildGatewayConnectionDetails();
    expect(details.url).toBe("ws://10.0.0.5:18800");
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

  it("throws for insecure ws:// remote URLs (CWE-319)", () => {
    loadConfig.mockReturnValue({
      gateway: {
        mode: "remote",
        bind: "loopback",
        remote: { url: "ws://remote.example.com:18789" },
      },
    });
    resolveGatewayPort.mockReturnValue(18789);
    pickPrimaryTailnetIPv4.mockReturnValue(undefined);

    let thrown: unknown;
    try {
      buildGatewayConnectionDetails();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("SECURITY ERROR");
    expect((thrown as Error).message).toContain("plaintext ws://");
    expect((thrown as Error).message).toContain("wss://");
    expect((thrown as Error).message).toContain("Tailscale Serve/Funnel");
    expect((thrown as Error).message).toContain("openclaw doctor --fix");
  });

  it("allows ws:// for loopback addresses in local mode", () => {
    setLocalLoopbackGatewayConfig();

    const details = buildGatewayConnectionDetails();

    expect(details.url).toBe("ws://127.0.0.1:18789");
  });
});

describe("callGateway error details", () => {
  beforeEach(() => {
    resetGatewayCallMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("includes connection details when the gateway closes", async () => {
    startMode = "close";
    closeCode = 1006;
    closeReason = "";
    setLocalLoopbackGatewayConfig();

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
    setLocalLoopbackGatewayConfig();

    vi.useFakeTimers();
    let errMessage = "";
    const promise = callGateway({ method: "health", timeoutMs: 5 }).catch((caught) => {
      errMessage = caught instanceof Error ? caught.message : String(caught);
    });

    await vi.advanceTimersByTimeAsync(5);
    await promise;

    expect(errMessage).toContain("gateway timeout after 5ms");
    expect(errMessage).toContain("Gateway target: ws://127.0.0.1:18789");
    expect(errMessage).toContain("Source: local loopback");
    expect(errMessage).toContain("Bind: loopback");
  });

  it("does not overflow very large timeout values", async () => {
    startMode = "silent";
    setLocalLoopbackGatewayConfig();

    vi.useFakeTimers();
    let errMessage = "";
    const promise = callGateway({ method: "health", timeoutMs: 2_592_010_000 }).catch((caught) => {
      errMessage = caught instanceof Error ? caught.message : String(caught);
    });

    await vi.advanceTimersByTimeAsync(1);
    expect(errMessage).toBe("");

    lastClientOptions?.onClose?.(1006, "");
    await promise;

    expect(errMessage).toContain("gateway closed (1006");
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
  let envSnapshot: ReturnType<typeof captureEnv>;

  beforeEach(() => {
    envSnapshot = captureEnv(["OPENCLAW_GATEWAY_TOKEN", "OPENCLAW_GATEWAY_PASSWORD"]);
    resetGatewayCallMocks();
    setGatewayNetworkDefaults(18789);
  });

  afterEach(() => {
    envSnapshot.restore();
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
  let envSnapshot: ReturnType<typeof captureEnv>;
  const explicitAuthCases = [
    {
      label: "password",
      authKey: "password",
      envKey: "OPENCLAW_GATEWAY_PASSWORD",
      envValue: "from-env",
      configValue: "from-config",
      explicitValue: "explicit-password",
    },
    {
      label: "token",
      authKey: "token",
      envKey: "OPENCLAW_GATEWAY_TOKEN",
      envValue: "env-token",
      configValue: "local-token",
      explicitValue: "explicit-token",
    },
  ] as const;

  beforeEach(() => {
    envSnapshot = captureEnv(["OPENCLAW_GATEWAY_PASSWORD", "OPENCLAW_GATEWAY_TOKEN"]);
    resetGatewayCallMocks();
    delete process.env.OPENCLAW_GATEWAY_PASSWORD;
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
    setGatewayNetworkDefaults(18789);
  });

  afterEach(() => {
    envSnapshot.restore();
  });

  it.each([
    {
      label: "uses local config password when env is unset",
      envPassword: undefined,
      config: {
        gateway: {
          mode: "local",
          bind: "loopback",
          auth: { password: "secret" },
        },
      },
      expectedPassword: "secret",
    },
    {
      label: "prefers env password over local config password",
      envPassword: "from-env",
      config: {
        gateway: {
          mode: "local",
          bind: "loopback",
          auth: { password: "from-config" },
        },
      },
      expectedPassword: "from-env",
    },
    {
      label: "uses remote password in remote mode when env is unset",
      envPassword: undefined,
      config: makeRemotePasswordGatewayConfig("remote-secret"),
      expectedPassword: "remote-secret",
    },
    {
      label: "prefers env password over remote password in remote mode",
      envPassword: "from-env",
      config: makeRemotePasswordGatewayConfig("remote-secret"),
      expectedPassword: "from-env",
    },
  ])("$label", async ({ envPassword, config, expectedPassword }) => {
    if (envPassword !== undefined) {
      process.env.OPENCLAW_GATEWAY_PASSWORD = envPassword;
    }
    loadConfig.mockReturnValue(config);

    await callGateway({ method: "health" });

    expect(lastClientOptions?.password).toBe(expectedPassword);
  });

  it.each(explicitAuthCases)("uses explicit $label when url override is set", async (testCase) => {
    process.env[testCase.envKey] = testCase.envValue;
    const auth = { [testCase.authKey]: testCase.configValue } as {
      password?: string;
      token?: string;
    };
    loadConfig.mockReturnValue({
      gateway: {
        mode: "local",
        auth,
      },
    });

    await callGateway({
      method: "health",
      url: "wss://override.example/ws",
      [testCase.authKey]: testCase.explicitValue,
    });

    expect(lastClientOptions?.[testCase.authKey]).toBe(testCase.explicitValue);
  });
});
