/* @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import { GatewayBrowserClient } from "./gateway.ts";
import { downloadSessionFile } from "./session-file-download.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([
  { remote: false, proxy: false },
  { remote: true, proxy: false },
  { remote: false, proxy: true },
  { remote: true, proxy: true },
])(
  "binds native downloads to the serving Gateway (remote: $remote, proxy: $proxy)",
  async ({ remote, proxy }) => {
    const gatewayUrl = "ws://127.0.0.1:18789/control";
    const resourceBasePath = proxy ? "/dev-proxy/control" : "/control";
    vi.stubGlobal(
      "OPENCLAW_UI_DEV_GATEWAY",
      proxy ? { gatewayUrl, proxyPath: "/dev-proxy" } : undefined,
    );
    const client = new GatewayBrowserClient({
      url: remote
        ? "wss://other-gateway.example.test"
        : proxy
          ? gatewayUrl
          : location.origin.replace(/^http/u, "ws"),
    });
    const request = vi.spyOn(client, "request").mockResolvedValue({
      filename: "report.md",
      mimeType: "text/markdown",
      url: "/api/artifacts/download/connection/ticket",
      expiresAt: "2099-01-01T00:00:00Z",
    });
    const params = { sessionKey: "agent:main:main", path: "report.md" };
    const result = downloadSessionFile(
      {
        client,
        connected: true,
        connectionEpoch: 1,
        sessionKey: params.sessionKey,
        resourceBasePath,
      },
      params,
      new AbortController().signal,
    );
    if (remote) {
      await expect(result).rejects.toThrow("same-origin Gateway connection");
      expect(request).not.toHaveBeenCalled();
    } else {
      await expect(result).resolves.toEqual({
        filename: "report.md",
        url: `${resourceBasePath}/api/artifacts/download/connection/ticket`,
      });
      expect(request).toHaveBeenCalledWith("sessions.files.download", params);
    }
  },
);

it("discards a development-proxy download when the active session changes", async () => {
  const gatewayUrl = "ws://127.0.0.1:18789/control";
  vi.stubGlobal("OPENCLAW_UI_DEV_GATEWAY", { gatewayUrl, proxyPath: "/dev-proxy" });
  const client = new GatewayBrowserClient({ url: gatewayUrl });
  const params = { sessionKey: "agent:main:main", path: "report.md" };
  const state = {
    client,
    connected: true,
    connectionEpoch: 1,
    sessionKey: params.sessionKey,
    resourceBasePath: "/dev-proxy/control",
  };
  const response = Promise.withResolvers<{
    filename: string;
    url: string;
  }>();
  vi.spyOn(client, "request").mockReturnValue(response.promise);
  const download = downloadSessionFile(state, params, new AbortController().signal);
  state.sessionKey = "agent:main:other";
  response.resolve({ filename: "report.md", url: "/api/artifacts/download/connection/ticket" });
  await expect(download).resolves.toBeNull();
});
