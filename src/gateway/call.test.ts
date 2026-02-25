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
  allowStoredDeviceToken?: boolean;
  deviceIdentity?: unknown;
  onHelloOk?: () => void | Promise<void>;
  onClose?: (code: number, reason: string) => void;
} | null = null;
type StartMode = "hello" | "close" | "silent";
let startMode: StartMode = "hello";
let closeCode = 1006;
let closeReason = "";
const clientOptionsHistory: Array<{
  url?: string;
  token?: string;
  password?: string;
  scopes?: string[];
  allowStoredDeviceToken?: boolean;
  deviceIdentity?: unknown;
  onHelloOk?: () => void | Promise<void>;
  onClose?: (code: number, reason: string) => void;
}> = [];
const startSequence: Array<{ mode: StartMode; closeCode?: number; closeReason?: string }> = [];
let startSequenceIndex = 0;

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
      allowStoredDeviceToken?: boolean;
      deviceIdentity?: unknown;
      onHelloOk?: () => void | Promise<void>;
      onClose?: (code: number, reason: string) => void;
    }) {
      lastClientOptions = opts;
      clientOptionsHistory.push(opts);
    }
    async request() {
      return { ok: true };
    }
    start() {
      const next = startSequence[startSequenceIndex];
      if (next) {
        startSequenceIndex += 1;
        if (next.mode === "hello") {
          void lastClientOptions?.onHelloOk?.();
          return;
        }
        if (next.mode === "close") {
          lastClientOptions?.onClose?.(next.closeCode ?? 1006, next.closeReason ?? "");
          return;
        }
        return;
      }
      if (startMode === "hello") {
        void lastClientOptions?.onHelloOk?.();
      } else if (startMode === "close") {
        lastClientOptions?.onClose?.(closeCode, closeReason);
      }
    }
    stop() {}
  },
}));

const {
  buildGatewayConnectionDetails,
  callGateway,
  callGatewayCli,
  callGatewayScoped,
  isLocalLoopbackGateway,
} = await import("./call.js");

function resetGatewayCallMocks() {
  loadConfig.mockClear();
  resolveGatewayPort.mockClear();
  pickPrimaryTailnetIPv4.mockClear();
  pickPrimaryLanIPv4.mockClear();
  lastClientOptions = null;
  clientOptionsHistory.length = 0;
  startMode = "hello";
  closeCode = 1006;
  closeReason = "";
  startSequence.length = 0;
  startSequenceIndex = 0;
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
      expectedUrl: "wss://127.0.0.1:18800",
    },
    {
      label: "lan without TLS",
      gateway: { mode: "local", bind: "lan" },
      tailnetIp: undefined,
      lanIp: "192.168.1.42",
      expectedUrl: "ws://127.0.0.1:18800",
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
      expectedUrl: "wss://127.0.0.1:18800",
    },
    {
      label: "without TLS",
      gateway: { mode: "local", bind: "lan" },
      expectedUrl: "ws://127.0.0.1:18800",
    },
  ])("uses loopback URL for bind=lan $label", ({ gateway, expectedUrl }) => {
    loadConfig.mockReturnValue({ gateway });
    resolveGatewayPort.mockReturnValue(18800);
    pickPrimaryTailnetIPv4.mockReturnValue(undefined);
    pickPrimaryLanIPv4.mockReturnValue("10.0.0.5");

    const details = buildGatewayConnectionDetails();

    expect(details.url).toBe(expectedUrl);
    expect(details.urlSource).toBe("local loopback");
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

describe("callGateway stale device token recovery", () => {
  beforeEach(() => {
    resetGatewayCallMocks();
    setLocalLoopbackGatewayConfig();
  });

  it("retries once on device token mismatch when shared auth is present", async () => {
    startSequence.push(
      {
        mode: "close",
        closeCode: 1008,
        closeReason: "unauthorized: device token mismatch (rotate/reissue device token)",
      },
      { mode: "hello" },
    );

    const result = await callGateway({ method: "health", token: "explicit-token" });
    expect(result).toEqual({ ok: true });
    expect(clientOptionsHistory).toHaveLength(2);
    expect(clientOptionsHistory[0]?.allowStoredDeviceToken).toBe(true);
    expect(clientOptionsHistory[1]?.allowStoredDeviceToken).toBe(false);
  });

  it("does not retry on non-mismatch close reasons", async () => {
    startSequence.push({
      mode: "close",
      closeCode: 1008,
      closeReason: "unauthorized: signature invalid",
    });

    await expect(callGateway({ method: "health", token: "explicit-token" })).rejects.toThrow(
      "signature invalid",
    );
    expect(clientOptionsHistory).toHaveLength(1);
  });

  it("does not retry mismatch when shared auth is missing", async () => {
    startSequence.push({
      mode: "close",
      closeCode: 1008,
      closeReason: "unauthorized: device token mismatch (rotate/reissue device token)",
    });

    await expect(callGateway({ method: "health" })).rejects.toThrow("device token mismatch");
    expect(clientOptionsHistory).toHaveLength(1);
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

describe("callGateway config token fallback on env/config drift", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;

  beforeEach(() => {
    envSnapshot = captureEnv(["OPENCLAW_GATEWAY_TOKEN", "CLAWDBOT_GATEWAY_TOKEN"]);
    resetGatewayCallMocks();
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
    delete process.env.CLAWDBOT_GATEWAY_TOKEN;
    setGatewayNetworkDefaults(18789);
  });

  afterEach(() => {
    envSnapshot.restore();
  });

  it("falls back to config token on env/config double-mismatch", async () => {
    process.env.OPENCLAW_GATEWAY_TOKEN = "env-token";
    loadConfig.mockReturnValue({
      gateway: { mode: "local", bind: "loopback", auth: { token: "config-token" } },
    });
    startSequence.push(
      {
        mode: "close",
        closeCode: 1008,
        closeReason: "unauthorized: device token mismatch (rotate/reissue device token)",
      },
      {
        mode: "close",
        closeCode: 1008,
        closeReason: "unauthorized: device token mismatch (rotate/reissue device token)",
      },
      { mode: "hello" },
    );

    const result = await callGateway({ method: "health" });
    expect(result).toEqual({ ok: true });
    expect(clientOptionsHistory).toHaveLength(3);
    expect(clientOptionsHistory[0]?.token).toBe("env-token");
    expect(clientOptionsHistory[0]?.allowStoredDeviceToken).toBe(true);
    expect(clientOptionsHistory[1]?.token).toBe("env-token");
    expect(clientOptionsHistory[1]?.allowStoredDeviceToken).toBe(false);
    expect(clientOptionsHistory[2]?.token).toBe("config-token");
    expect(clientOptionsHistory[2]?.allowStoredDeviceToken).toBe(false);
  });

  it("does not use config fallback when env and config tokens are identical", async () => {
    process.env.OPENCLAW_GATEWAY_TOKEN = "same-token";
    loadConfig.mockReturnValue({
      gateway: { mode: "local", bind: "loopback", auth: { token: "same-token" } },
    });
    startSequence.push(
      {
        mode: "close",
        closeCode: 1008,
        closeReason: "unauthorized: device token mismatch (rotate/reissue device token)",
      },
      {
        mode: "close",
        closeCode: 1008,
        closeReason: "unauthorized: device token mismatch (rotate/reissue device token)",
      },
    );

    await expect(callGateway({ method: "health" })).rejects.toThrow("device token mismatch");
    expect(clientOptionsHistory).toHaveLength(2);
  });

  it("does not use config fallback when config token is missing", async () => {
    process.env.OPENCLAW_GATEWAY_TOKEN = "env-token";
    loadConfig.mockReturnValue({
      gateway: { mode: "local", bind: "loopback", auth: {} },
    });
    startSequence.push(
      {
        mode: "close",
        closeCode: 1008,
        closeReason: "unauthorized: device token mismatch (rotate/reissue device token)",
      },
      {
        mode: "close",
        closeCode: 1008,
        closeReason: "unauthorized: device token mismatch (rotate/reissue device token)",
      },
    );

    await expect(callGateway({ method: "health" })).rejects.toThrow("device token mismatch");
    expect(clientOptionsHistory).toHaveLength(2);
  });

  it("does not use config fallback in remote mode", async () => {
    loadConfig.mockReturnValue({
      gateway: {
        mode: "remote",
        remote: { url: "wss://remote.example:18789", token: "remote-token" },
        auth: { token: "config-token" },
      },
    });
    startSequence.push(
      {
        mode: "close",
        closeCode: 1008,
        closeReason: "unauthorized: device token mismatch (rotate/reissue device token)",
      },
      {
        mode: "close",
        closeCode: 1008,
        closeReason: "unauthorized: device token mismatch (rotate/reissue device token)",
      },
    );

    await expect(callGateway({ method: "health" })).rejects.toThrow("device token mismatch");
    expect(clientOptionsHistory).toHaveLength(2);
  });

  it("does not use config fallback when second error is not a mismatch", async () => {
    process.env.OPENCLAW_GATEWAY_TOKEN = "env-token";
    loadConfig.mockReturnValue({
      gateway: { mode: "local", bind: "loopback", auth: { token: "config-token" } },
    });
    startSequence.push(
      {
        mode: "close",
        closeCode: 1008,
        closeReason: "unauthorized: device token mismatch (rotate/reissue device token)",
      },
      {
        mode: "close",
        closeCode: 1008,
        closeReason: "unauthorized: signature invalid",
      },
    );

    await expect(callGateway({ method: "health" })).rejects.toThrow("signature invalid");
    expect(clientOptionsHistory).toHaveLength(2);
  });
});

describe("isLocalLoopbackGateway", () => {
  beforeEach(() => {
    resetGatewayCallMocks();
    setGatewayNetworkDefaults(18789);
  });

  it("returns true for local mode without url override", () => {
    loadConfig.mockReturnValue({ gateway: { mode: "local", bind: "loopback" } });
    expect(isLocalLoopbackGateway()).toBe(true);
  });

  it("returns false for remote mode", () => {
    loadConfig.mockReturnValue({
      gateway: { mode: "remote", remote: { url: "wss://remote.example:18789" } },
    });
    expect(isLocalLoopbackGateway()).toBe(false);
  });

  it("returns false when url override is set", () => {
    loadConfig.mockReturnValue({ gateway: { mode: "local", bind: "loopback" } });
    expect(isLocalLoopbackGateway({ url: "wss://override.example/ws" })).toBe(false);
  });

  it("returns true when url override is empty string", () => {
    loadConfig.mockReturnValue({ gateway: { mode: "local", bind: "loopback" } });
    expect(isLocalLoopbackGateway({ url: "" })).toBe(true);
  });
});
