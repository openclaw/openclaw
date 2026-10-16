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
  const proxyUrl = "http://private-proxy.example:8080/proxy-value-marker";
  it.each<
    [
      string,
      NodeJS.ProcessEnv,
      Record<string, string> | undefined,
      "reachable" | "unreachable",
      string[],
    ]
  >([
    [
      "service",
      {},
      { HTTPS_PROXY: proxyUrl },
      "unreachable",
      ["installed Gateway service: HTTPS_PROXY"],
    ],
    ["process", { http_proxy: proxyUrl }, undefined, "reachable", ["doctor process: http_proxy"]],
    [
      "Kubernetes",
      {
        HTTPS_PROXY: proxyUrl,
        KUBERNETES_SERVICE_HOST: "10.96.0.1",
        KUBERNETES_SERVICE_PORT: "443",
      },
      { HTTPS_PROXY: proxyUrl },
      "reachable",
      ["doctor process: HTTPS_PROXY"],
    ],
    [
      "both",
      { HTTP_PROXY: proxyUrl },
      { HTTPS_PROXY: proxyUrl },
      "reachable",
      ["doctor process: HTTP_PROXY", "installed Gateway service: HTTPS_PROXY"],
    ],
  ])(
    "reports %s proxy routing without exposing values",
    async (source, env, serviceEnv, connectivity, sources) => {
      const service = serviceWithEnv(serviceEnv);
      const noteFn = vi.fn();
      await noteWebFetchProxyDiagnostic({
        cfg: {},
        env,
        service,
        noteFn,
        probeDirectConnectivity: vi.fn(async () => connectivity),
      });
      expect(noteFn).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining("web_fetch"),
        "Web fetch proxy",
      );
      const diagnostic = noteFn.mock.calls[0]?.[0];
      for (const expected of sources) {
        expect(diagnostic).toContain(`HTTP(S) proxy environment detected in the ${expected}`);
      }
      expect(diagnostic).toContain("web_fetch still uses direct connections");
      expect(diagnostic).toContain("tools.web.fetch.useTrustedEnvProxy is not enabled");
      expect(diagnostic).toContain(
        `Direct TLS connectivity to docs.openclaw.ai:443 ${connectivity === "reachable" ? "succeeded" : "failed"}`,
      );
      expect(diagnostic).toContain("openclaw config set tools.web.fetch.useTrustedEnvProxy true");
      expect(diagnostic).not.toContain(proxyUrl);
      expect(diagnostic).not.toContain("proxy-value-marker");
      if (source === "Kubernetes") {
        expect(diagnostic).not.toContain("installed Gateway service");
        expect(service.readCommand).not.toHaveBeenCalled();
      }
    },
  );

  it.each<{ name: string; cfg: OpenClawConfig; proxy: boolean }>([
    { name: "no HTTP(S) proxy is effective", cfg: {}, proxy: false },
    {
      name: "trusted proxy opt-in is enabled",
      cfg: { tools: { web: { fetch: { useTrustedEnvProxy: true } } } },
      proxy: true,
    },
    {
      name: "web_fetch is disabled",
      cfg: { tools: { web: { fetch: { enabled: false } } } },
      proxy: true,
    },
    { name: "Gateway mode is remote", cfg: { gateway: { mode: "remote" } }, proxy: true },
  ])("does nothing when $name", async ({ cfg, proxy }) => {
    const service = serviceWithEnv(proxy ? { HTTPS_PROXY: proxyUrl } : undefined);
    const probe = vi.fn(async () => "unreachable" as const);
    await expect(
      collectDiagnostic({
        cfg,
        env: proxy ? {} : { ALL_PROXY: "socks5://proxy.example:1080" },
        service,
        probeDirectConnectivity: probe,
      }),
    ).resolves.toBeNull();
    if (proxy) {
      expect(service.readCommand).not.toHaveBeenCalled();
    }
    expect(probe).not.toHaveBeenCalled();
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
