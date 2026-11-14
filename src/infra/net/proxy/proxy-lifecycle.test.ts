import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { installGlobalProxyMock, proxylineStopMock } = vi.hoisted(() => {
  const stop = vi.fn();
  return { proxylineStopMock: stop, installGlobalProxyMock: vi.fn(() => ({ stop })) };
});

vi.mock("../proxyline-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../proxyline-runtime.js")>()),
  loadProxyline: () => ({ installGlobalProxy: installGlobalProxyMock }),
}));

// mock-isolation: Lifecycle fixtures must not replace the worker's global HTTP dispatcher.
vi.mock("../undici-global-dispatcher.js", () => ({
  forceResetGlobalDispatcher: vi.fn(),
}));

vi.mock("../../../logger.js", () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

import { logInfo, logWarn } from "../../../logger.js";
import {
  getActiveManagedProxyLoopbackMode,
  getActiveManagedProxyTlsOptions,
  getActiveManagedProxyUrl,
} from "./active-proxy-state.js";
import { useProxyCaFiles } from "./proxy-ca.test-support.js";
import {
  ensureInheritedManagedProxyRoutingActive,
  registerManagedProxyBrowserCdpBypass,
  registerManagedProxyGatewayLoopbackBypass,
  startProxy as startProxyRuntime,
  stopProxy,
  type ProxyHandle,
} from "./proxy-lifecycle.js";
import { stopMockedProxylineHandles } from "./proxyline.test-support.js";

const activeProxyHandles: ProxyHandle[] = [];
const proxyUrl = "http://127.0.0.1:3128";

function expectProxyInstall(options: Record<string, unknown>, call = 1) {
  expect(installGlobalProxyMock).toHaveBeenNthCalledWith(
    call,
    expect.objectContaining({ mode: "managed", ...options }),
  );
}

async function startProxy(
  config: Parameters<typeof startProxyRuntime>[0] = { proxyUrl },
): Promise<ProxyHandle> {
  const handle = await startProxyRuntime(config);
  if (handle === null) {
    throw new Error("Expected managed proxy handle");
  }
  activeProxyHandles.push(handle);
  return handle;
}

function expectEnv(values: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(values)) {
    expect(process.env[key], key).toBe(value);
  }
}

function inheritProxy(inheritedUrl: string, caFile?: string) {
  process.env.OPENCLAW_PROXY_ACTIVE = "1";
  process.env.OPENCLAW_PROXY_LOOPBACK_MODE = "gateway-only";
  process.env.HTTP_PROXY = inheritedUrl;
  if (caFile) {
    process.env.OPENCLAW_PROXY_CA_FILE = caFile;
  }
  ensureInheritedManagedProxyRoutingActive();
}

describe("startProxy", () => {
  const envKeysToClean = ["http_proxy", "https_proxy", "all_proxy", "no_proxy"]
    .flatMap((key) => [key, key.toUpperCase()])
    .concat(["ACTIVE", "CA_FILE", "LOOPBACK_MODE", "URL"].map((key) => `OPENCLAW_PROXY_${key}`));
  const writeTempCa = useProxyCaFiles();

  beforeEach(() => {
    for (const key of envKeysToClean) {
      vi.stubEnv(key, undefined);
    }
    vi.clearAllMocks();
  });

  afterEach(async () => {
    for (const handle of activeProxyHandles.splice(0).toReversed()) {
      await stopProxy(handle);
    }
    stopMockedProxylineHandles(installGlobalProxyMock.mock.results);
    vi.unstubAllEnvs();
    expect(getActiveManagedProxyUrl()).toBeUndefined();
  });

  it("returns null silently and does not touch env when not explicitly enabled", async () => {
    const handle = await startProxyRuntime(undefined);
    expect(handle).toBeNull();
    expect(process.env["http_proxy"]).toBeUndefined();
    expect(installGlobalProxyMock).not.toHaveBeenCalled();
    expect(logInfo).not.toHaveBeenCalled();
    expect(logWarn).not.toHaveBeenCalled();
    await expect(stopProxy(handle)).resolves.toBeUndefined();
  });

  it("uses HTTPS proxy URLs from OPENCLAW_PROXY_URL", async () => {
    process.env["OPENCLAW_PROXY_URL"] = "https://127.0.0.1:3128";
    const handle = await startProxy({});
    expect(handle.proxyUrl).toBe("https://127.0.0.1:3128");
    expect(process.env["HTTP_PROXY"]).toBe("https://127.0.0.1:3128");
    expectProxyInstall({ proxyUrl: "https://127.0.0.1:3128" });
  });

  it("passes configured proxy CA trust to Proxyline", async () => {
    const caFile = writeTempCa("active-proxy-ca");
    const handle = await startProxy({
      proxyUrl: "https://127.0.0.1:3128",
      tls: { caFile },
    });
    expect(getActiveManagedProxyTlsOptions()).toEqual({ ca: "active-proxy-ca" });
    expect(process.env["OPENCLAW_PROXY_CA_FILE"]).toBe(caFile);
    expectProxyInstall({ proxyTls: { ca: "active-proxy-ca" } });
    await stopProxy(handle);
  });

  it("loads inherited HTTPS proxy CA trust for child routing", () => {
    const caFile = writeTempCa("inherited-https-proxy-ca");
    inheritProxy("https://proxy.example:8443", caFile);
    expect(process.env["NO_PROXY"]).toContain("127.0.0.1");
    expect(process.env["no_proxy"]).toBe(process.env["NO_PROXY"]);
    expect(getActiveManagedProxyTlsOptions()).toBeUndefined();
    expectProxyInstall({
      ifActive: "reuse-compatible",
      proxyTls: { ca: "inherited-https-proxy-ca" },
      proxyUrl: "https://proxy.example:8443",
    });
  });

  it("enforces block mode and preserves loopback policy for child CLIs", async () => {
    const handle = await startProxy({ proxyUrl, loopbackMode: "block" });
    expect(process.env["OPENCLAW_PROXY_LOOPBACK_MODE"]).toBe("block");
    expect(getActiveManagedProxyLoopbackMode()).toBe("block");
    expectEnv({ NO_PROXY: "", no_proxy: "" });
    expect(() => registerManagedProxyGatewayLoopbackBypass("ws://127.0.0.1:18789")).toThrow(
      "blocked by proxy.loopbackMode",
    );
    await stopProxy(handle);
    process.env["OPENCLAW_PROXY_ACTIVE"] = "1";
    process.env["OPENCLAW_PROXY_LOOPBACK_MODE"] = "proxy";
    expect(getActiveManagedProxyLoopbackMode()).toBe("proxy");
  });

  it("redacts proxy credentials before logging the active proxy URL", async () => {
    const authenticatedUrl = new URL(proxyUrl);
    authenticatedUrl.username = "user";
    authenticatedUrl.password = "pass";
    await startProxy({ proxyUrl: authenticatedUrl.href });
    expect(logInfo).toHaveBeenCalledWith(expect.stringContaining(proxyUrl));
    expect(
      vi
        .mocked(logInfo)
        .mock.calls.some((call) =>
          call.some((value) => typeof value === "string" && value.includes("user:pass")),
        ),
    ).toBe(false);
  });

  it("replaces ambient NO_PROXY with only runtime loopback destinations", async () => {
    process.env["NO_PROXY"] = "127.0.0.1,localhost,corp.example.com";
    process.env["no_proxy"] = "localhost";
    await startProxy();
    expect(process.env["NO_PROXY"]).toContain("127.0.0.1,localhost");
    expect(process.env["NO_PROXY"]).toContain("::1");
    expect(process.env["NO_PROXY"]).not.toContain("corp.example.com");
    expect(process.env["no_proxy"]).toBe(process.env["NO_PROXY"]);
  });

  it("reuses inherited Proxyline routing and replaces it when startProxy takes ownership", async () => {
    inheritProxy("http://127.0.0.1:3111");
    const inheritedInstall = {
      ifActive: "reuse-compatible",
      proxyUrl: "http://127.0.0.1:3111",
      undici: expect.objectContaining({ allowH2: false }),
    };
    expectProxyInstall(inheritedInstall);
    expect(proxylineStopMock).not.toHaveBeenCalled();
    const handle = await startProxy({ proxyUrl: "http://127.0.0.1:3222" });
    expect(installGlobalProxyMock).toHaveBeenCalledTimes(2);
    expectProxyInstall(
      { ...inheritedInstall, ifActive: "replace", proxyUrl: "http://127.0.0.1:3222" },
      2,
    );
    expect(process.env["HTTP_PROXY"]).toBe("http://127.0.0.1:3222");
    await stopProxy(handle);
    expect(proxylineStopMock).toHaveBeenCalledOnce();
    expectEnv({ HTTP_PROXY: "http://127.0.0.1:3111", OPENCLAW_PROXY_ACTIVE: "1" });
    expect(installGlobalProxyMock).toHaveBeenCalledTimes(3);
    expectProxyInstall(inheritedInstall, 3);
  });

  it.each([
    [{ proxyUrl: "http://127.0.0.1:3129" }, "cannot activate a managed proxy"],
    [
      { proxyUrl, loopbackMode: "block" },
      "cannot activate a managed proxy with a different proxy.loopbackMode",
    ],
  ] as const)("rejects overlapping handles: %j", async (config, message) => {
    const firstHandle = await startProxy();
    await expect(startProxy(config)).rejects.toThrow(message);
    expectEnv({ HTTP_PROXY: proxyUrl, OPENCLAW_PROXY_ACTIVE: "1" });
    await stopProxy(firstHandle);
  });

  it("restores env and throws when Proxyline activation fails", async () => {
    installGlobalProxyMock.mockImplementationOnce(() => {
      throw new Error("install failed");
    });
    await expect(startProxy()).rejects.toThrow("failed to activate external proxy routing");
    expectEnv({ http_proxy: undefined, OPENCLAW_PROXY_ACTIVE: undefined });
  });

  it("kill restores env synchronously during hard process exit", async () => {
    process.env["NO_PROXY"] = "corp.example.com";
    const handle = await startProxy();
    handle.kill("SIGTERM");
    expectEnv({ HTTP_PROXY: undefined, NO_PROXY: "corp.example.com" });
  });

  it("returns undefined when no managed proxy is active (bypass is a no-op)", () => {
    expect(registerManagedProxyBrowserCdpBypass("http://127.0.0.1:18800")).toBeUndefined();
  });
});
