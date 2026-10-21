import { Socket } from "node:net";
import tls from "node:tls";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as noteRuntime from "../../packages/terminal-core/src/note.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as serviceRuntime from "../daemon/service.js";
import { fetchWithRuntimeDispatcher } from "../infra/net/runtime-fetch.js";
import { noteWebFetchProxyDiagnostic } from "./doctor-web-fetch-proxy.js";

vi.mock("../infra/net/runtime-fetch.js", () => ({ fetchWithRuntimeDispatcher: vi.fn() }));
const noteFn = vi.fn();
const service = { readCommand: vi.fn() };
const proxyUrl = "http://private-proxy.example:8080/proxy-value-marker";
const proxyEnv = { HTTPS_PROXY: proxyUrl };
const webFetchDisabled = { web: { fetch: { enabled: false } } };
type Options = Parameters<typeof noteWebFetchProxyDiagnostic>[0];
const resolveService = serviceRuntime.resolveGatewayService;

function mockDirectConnectivity(outcome: "reachable" | "unreachable") {
  vi.spyOn(tls, "connect").mockImplementation(() => {
    const socket = new tls.TLSSocket(new Socket());
    queueMicrotask(() => socket.emit(outcome === "reachable" ? "secureConnect" : "timeout"));
    return socket;
  });
}

beforeEach(() => {
  noteFn.mockReset();
  service.readCommand.mockReset().mockResolvedValue(null);
  vi.mocked(fetchWithRuntimeDispatcher).mockReset();
  vi.spyOn(noteRuntime, "note").mockImplementation(noteFn);
  vi.spyOn(serviceRuntime, "resolveGatewayService").mockImplementation(() => ({
    ...resolveService(),
    readCommand: service.readCommand,
  }));
  mockDirectConnectivity("reachable");
});
afterEach(() => vi.restoreAllMocks());

async function diagnose(options: Partial<Options> = {}) {
  await noteWebFetchProxyDiagnostic({ cfg: {}, env: {}, ...options });
  return noteFn.mock.calls[0]?.[0] ?? null;
}
function expectNote(title: string, ...fragments: string[]) {
  expect(noteFn).toHaveBeenCalledExactlyOnceWith(expect.any(String), title);
  for (const fragment of fragments) {
    expect(noteFn.mock.calls[0]?.[0]).toContain(fragment);
  }
}
it.each([
  ["service", {}, proxyEnv, "unreachable", ["installed Gateway service: HTTPS_PROXY"]],
  ["process", { http_proxy: proxyUrl }, undefined, "reachable", ["doctor process: http_proxy"]],
  [
    "Kubernetes",
    { ...proxyEnv, KUBERNETES_SERVICE_HOST: "10.96.0.1", KUBERNETES_SERVICE_PORT: "443" },
    proxyEnv,
    "reachable",
    ["doctor process: HTTPS_PROXY"],
  ],
  [
    "both",
    { HTTP_PROXY: proxyUrl },
    proxyEnv,
    "reachable",
    ["doctor process: HTTP_PROXY", "installed Gateway service: HTTPS_PROXY"],
  ],
] as const)(
  "reports %s proxy routing without exposing values",
  async (source, env, serviceEnv, connectivity, sources) => {
    service.readCommand.mockResolvedValue(serviceEnv ? { environment: serviceEnv } : null);
    mockDirectConnectivity(connectivity);
    const diagnostic = await diagnose({ env });
    expectNote(
      "Web fetch proxy",
      "web_fetch",
      ...sources.map((label) => "HTTP(S) proxy environment detected in the " + label),
      "web_fetch still uses direct connections",
      "tools.web.fetch.useTrustedEnvProxy is not enabled",
      "Direct TLS connectivity to docs.openclaw.ai:443 " +
        (connectivity === "reachable" ? "succeeded" : "failed"),
      "openclaw config set tools.web.fetch.useTrustedEnvProxy true",
    );
    expect(diagnostic).not.toContain("proxy-value-marker");
    if (source === "Kubernetes") {
      expect(diagnostic).not.toContain("installed Gateway service");
      expect(service.readCommand).not.toHaveBeenCalled();
    }
  },
);

it.each<[string, OpenClawConfig, boolean]>([
  ["no HTTP(S) proxy is effective", {}, false],
  [
    "trusted proxy opt-in is enabled",
    { tools: { web: { fetch: { useTrustedEnvProxy: true } } } },
    true,
  ],
  ["web_fetch is disabled", { tools: webFetchDisabled }, true],
  ["Gateway mode is remote", { gateway: { mode: "remote" } }, true],
])("does nothing when %s", async (_name, cfg, proxy) => {
  await diagnose({
    cfg,
    env: proxy ? {} : { ALL_PROXY: "socks5://proxy.example:1080" },
  });
  expect(noteFn).not.toHaveBeenCalled();
  if (proxy) {
    expect(service.readCommand).not.toHaveBeenCalled();
  }
  expect(tls.connect).not.toHaveBeenCalled();
});

const managedProxyUrl = "http://proxy.example.test:8080";
const diagnoseManaged = (options: Partial<Options> = {}) =>
  diagnose({
    cfg: { tools: webFetchDisabled },
    env: { OPENCLAW_PROXY_URL: managedProxyUrl },
    ...options,
  });

it.each([
  ["a proxy HTTP error", new Response("private-value", { status: 502 })],
  ["a response from another listener", new Response(null, { status: 204 })],
  ["a transport error", undefined],
] as const)(
  "reports %s with actionable recovery before web_fetch gating",
  async (_name, response) => {
    vi.mocked(fetchWithRuntimeDispatcher).mockImplementation(() =>
      response ? Promise.resolve(response) : Promise.reject(new Error(managedProxyUrl)),
    );
    const message = await diagnoseManaged();
    expectNote(
      "Managed proxy loopback",
      "proxy.enabled",
      "openclaw config get proxy",
      "openclaw config set proxy.enabled false",
      "openclaw gateway restart",
    );
    expect(message).not.toContain("private-value");
    expect(message).not.toContain("proxy.example");
  },
);

it("stays silent when the runtime reaches its own loopback listener", async () => {
  vi.mocked(fetchWithRuntimeDispatcher).mockImplementation((input, init) => fetch(input, init));
  await diagnoseManaged({
    cfg: { proxy: { enabled: true, proxyUrl: managedProxyUrl }, tools: webFetchDisabled },
    env: {},
  });
  expect(fetchWithRuntimeDispatcher).toHaveBeenCalledOnce();
  expect(noteFn).not.toHaveBeenCalled();
});

it.each(["proxy", "block"] as const)(
  "explains how to restore local routing with explicit %s mode",
  async (loopbackMode) => {
    vi.mocked(fetchWithRuntimeDispatcher).mockRejectedValue(new Error("connect failed"));
    const diagnostic = await diagnoseManaged({
      cfg: { proxy: { proxyUrl: managedProxyUrl, loopbackMode }, tools: webFetchDisabled },
      env: {},
    });
    expectNote(
      "Managed proxy loopback",
      "proxy.loopbackMode=" + loopbackMode,
      "openclaw config set proxy.loopbackMode gateway-only",
    );
    expect(diagnostic).not.toContain("openclaw config set proxy.enabled false");
  },
);

it.each([
  { proxy: { enabled: false, proxyUrl: managedProxyUrl } },
  { proxy: { proxyUrl: managedProxyUrl }, gateway: { mode: "remote" as const } },
])("does not probe disabled managed routing or a remote Gateway", async (cfg) => {
  expect(await diagnoseManaged({ cfg: { ...cfg, tools: webFetchDisabled } })).toBeNull();
  expect(noteFn).not.toHaveBeenCalled();
  expect(fetchWithRuntimeDispatcher).not.toHaveBeenCalled();
});
