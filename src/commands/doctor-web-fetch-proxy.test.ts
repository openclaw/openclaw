// Doctor web fetch proxy tests cover explicit opt-in diagnostics without exposing proxy values.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { fetchWithRuntimeDispatcher } from "../infra/net/runtime-fetch.js";
import { noteWebFetchProxyDiagnostic } from "./doctor-web-fetch-proxy.js";

vi.mock("../infra/net/runtime-fetch.js", () => ({ fetchWithRuntimeDispatcher: vi.fn() }));

afterEach(() => {
  vi.mocked(fetchWithRuntimeDispatcher).mockReset();
});

function serviceWithEnv(environment?: Record<string, string>) {
  return {
    readCommand: vi.fn(async () =>
      environment ? { programArguments: ["openclaw", "gateway"], environment } : null,
    ),
  };
}

async function collectDiagnostic(
  params: Omit<Parameters<typeof noteWebFetchProxyDiagnostic>[0], "noteFn">,
): Promise<string | null> {
  let diagnostic: string | null = null;
  await noteWebFetchProxyDiagnostic({
    ...params,
    noteFn: (message) => {
      if (typeof message !== "string") {
        throw new TypeError("expected doctor proxy diagnostic to be a string");
      }
      diagnostic = message;
    },
  });
  return diagnostic;
}

describe("web_fetch proxy doctor diagnostic", () => {
  it("reports direct routing for an installed Gateway proxy without exposing its value", async () => {
    const proxyUrl = "http://private-proxy.example:8080/proxy-value-marker";
    const diagnostic = await collectDiagnostic({
      cfg: {},
      env: {},
      service: serviceWithEnv({ HTTPS_PROXY: proxyUrl }),
      probeDirectConnectivity: vi.fn(async () => "unreachable" as const),
    });

    expect(diagnostic).toContain(
      "HTTP(S) proxy environment detected in the installed Gateway service: HTTPS_PROXY",
    );
    expect(diagnostic).toContain("web_fetch still uses direct connections");
    expect(diagnostic).toContain("tools.web.fetch.useTrustedEnvProxy is not enabled");
    expect(diagnostic).toContain("Direct TLS connectivity to docs.openclaw.ai:443 failed");
    expect(diagnostic).toContain("openclaw config set tools.web.fetch.useTrustedEnvProxy true");
    expect(diagnostic).not.toContain(proxyUrl);
    expect(diagnostic).not.toContain("proxy-value-marker");
  });

  it("reports a reachable direct path from the doctor process", async () => {
    const diagnostic = await collectDiagnostic({
      cfg: {},
      env: { http_proxy: "http://proxy.example:8080" },
      service: serviceWithEnv(),
      probeDirectConnectivity: vi.fn(async () => "reachable" as const),
    });

    expect(diagnostic).toContain("proxy environment detected in the doctor process: http_proxy");
    expect(diagnostic).toContain("Direct TLS connectivity to docs.openclaw.ai:443 succeeded");
  });

  it("keeps Kubernetes process proxy diagnostics without inspecting a host service", async () => {
    const service = serviceWithEnv({ HTTPS_PROXY: "http://service-proxy.example:8080" });
    const diagnostic = await collectDiagnostic({
      cfg: {},
      env: {
        HTTPS_PROXY: "http://pod-proxy.example:8080",
        KUBERNETES_SERVICE_HOST: "10.96.0.1",
        KUBERNETES_SERVICE_PORT: "443",
      },
      service,
      probeDirectConnectivity: vi.fn(async () => "reachable" as const),
    });

    expect(diagnostic).toContain("proxy environment detected in the doctor process: HTTPS_PROXY");
    expect(diagnostic).not.toContain("installed Gateway service");
    expect(service.readCommand).not.toHaveBeenCalled();
  });

  it("reports both process and installed service proxy sources", async () => {
    const diagnostic = await collectDiagnostic({
      cfg: {},
      env: { HTTP_PROXY: "http://shell-proxy.example:8080" },
      service: serviceWithEnv({ HTTPS_PROXY: "http://service-proxy.example:8080" }),
      probeDirectConnectivity: vi.fn(async () => "reachable" as const),
    });

    expect(diagnostic).toContain("doctor process: HTTP_PROXY");
    expect(diagnostic).toContain("installed Gateway service: HTTPS_PROXY");
  });

  it("does nothing when no HTTP(S) proxy is effective", async () => {
    const probe = vi.fn(async () => "reachable" as const);

    await expect(
      collectDiagnostic({
        cfg: {},
        env: { ALL_PROXY: "socks5://proxy.example:1080" },
        service: serviceWithEnv(),
        probeDirectConnectivity: probe,
      }),
    ).resolves.toBeNull();
    expect(probe).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "trusted proxy opt-in is enabled",
      cfg: { tools: { web: { fetch: { useTrustedEnvProxy: true } } } },
    },
    {
      name: "web_fetch is disabled",
      cfg: { tools: { web: { fetch: { enabled: false } } } },
    },
    {
      name: "Gateway mode is remote",
      cfg: { gateway: { mode: "remote" } },
    },
  ])("does nothing when $name", async ({ cfg }) => {
    const service = serviceWithEnv({ HTTPS_PROXY: "http://proxy.example:8080" });
    const probe = vi.fn(async () => "unreachable" as const);

    await expect(
      collectDiagnostic({
        cfg: cfg as OpenClawConfig,
        env: {},
        service,
        probeDirectConnectivity: probe,
      }),
    ).resolves.toBeNull();
    expect(service.readCommand).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
  });

  it("emits one titled note", async () => {
    const noteFn = vi.fn();

    await noteWebFetchProxyDiagnostic({
      cfg: {},
      env: { HTTPS_PROXY: "http://proxy.example:8080" },
      service: serviceWithEnv(),
      probeDirectConnectivity: vi.fn(async () => "reachable" as const),
      noteFn,
    });

    expect(noteFn).toHaveBeenCalledTimes(1);
    expect(noteFn).toHaveBeenCalledWith(expect.stringContaining("web_fetch"), "Web fetch proxy");
  });
});

describe("managed proxy loopback doctor diagnostic", () => {
  const proxyUrl = "http://proxy.example.test:8080";
  const webFetchDisabled = { web: { fetch: { enabled: false } } };

  it.each([
    { name: "a proxy HTTP error", response: new Response("private-value", { status: 502 }) },
    { name: "a response from another listener", response: new Response(null, { status: 204 }) },
    { name: "a transport error", response: undefined },
  ])("reports $name with actionable recovery before web_fetch gating", async ({ response }) => {
    if (response) {
      vi.mocked(fetchWithRuntimeDispatcher).mockResolvedValue(response);
    } else {
      vi.mocked(fetchWithRuntimeDispatcher).mockRejectedValue(new Error(proxyUrl));
    }
    const noteFn = vi.fn();

    await noteWebFetchProxyDiagnostic({
      cfg: { tools: webFetchDisabled },
      env: { OPENCLAW_PROXY_URL: proxyUrl },
      noteFn,
    });

    expect(noteFn).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("proxy.enabled"),
      "Managed proxy loopback",
    );
    const message = String(noteFn.mock.calls[0]?.[0]);
    expect(message).toContain("openclaw config get proxy");
    expect(message).toContain("openclaw config set proxy.enabled false");
    expect(message).toContain("openclaw gateway restart");
    expect(message).not.toContain("private-value");
    expect(message).not.toContain("proxy.example");
  });

  it("stays silent when the runtime reaches its own loopback listener", async () => {
    vi.mocked(fetchWithRuntimeDispatcher).mockImplementation((input, init) => fetch(input, init));
    const noteFn = vi.fn();

    await noteWebFetchProxyDiagnostic({
      cfg: { proxy: { enabled: true, proxyUrl }, tools: webFetchDisabled },
      env: {},
      noteFn,
    });

    expect(fetchWithRuntimeDispatcher).toHaveBeenCalledOnce();
    expect(noteFn).not.toHaveBeenCalled();
  });

  it.each(["proxy", "block"] as const)(
    "explains how to restore local routing with explicit %s mode",
    async (loopbackMode) => {
      vi.mocked(fetchWithRuntimeDispatcher).mockRejectedValue(new Error("connect failed"));
      const diagnostic = await collectDiagnostic({
        cfg: { proxy: { proxyUrl, loopbackMode }, tools: webFetchDisabled },
        env: {},
      });

      expect(diagnostic).toContain(`proxy.loopbackMode=${loopbackMode}`);
      expect(diagnostic).toContain("openclaw config set proxy.loopbackMode gateway-only");
      expect(diagnostic).not.toContain("openclaw config set proxy.enabled false");
    },
  );

  it.each([
    { proxy: { enabled: false, proxyUrl } },
    { proxy: { proxyUrl }, gateway: { mode: "remote" as const } },
  ])("does not probe disabled managed routing or a remote Gateway", async (cfg) => {
    const diagnostic = await collectDiagnostic({
      cfg: { ...cfg, tools: webFetchDisabled },
      env: { OPENCLAW_PROXY_URL: proxyUrl },
    });

    expect(fetchWithRuntimeDispatcher).not.toHaveBeenCalled();
    expect(diagnostic).toBeNull();
  });
});
