/* @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import { i18n } from "../i18n/index.ts";
import { registerFilePreviewEnglish } from "../i18n/locales/en-file-preview.ts";
import { GatewayBrowserClient } from "./gateway.ts";
import { downloadSessionFile } from "./session-file-download.ts";

registerFilePreviewEnglish();

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([
  { remote: false, proxy: false, change: "none" },
  { remote: true, proxy: false, change: "none" },
  { remote: false, proxy: true, change: "none" },
  { remote: true, proxy: true, change: "none" },
  ...["session", "client", "connection"].map((change) => ({ remote: false, proxy: true, change })),
])(
  "binds native downloads to the serving Gateway and session (remote: $remote, proxy: $proxy, change: $change)",
  async ({ remote, proxy, change }) => {
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
    const payload = {
      filename: "report.md",
      mimeType: "text/markdown",
      url: "/api/artifacts/download/connection/ticket",
      expiresAt: "2099-01-01T00:00:00Z",
    };
    const response = Promise.withResolvers<typeof payload>();
    const request = vi.spyOn(client, "request").mockReturnValue(response.promise);
    const params = { sessionKey: "agent:main:main", path: "report.md" };
    const state = {
      client,
      connected: true,
      connectionEpoch: 1,
      sessionKey: params.sessionKey,
      resourceBasePath,
    };
    const controller = new AbortController();
    const result = downloadSessionFile(state, params, controller.signal);
    if (change === "session") {
      state.sessionKey = "agent:main:other";
    } else if (change === "client") {
      state.client = new GatewayBrowserClient({ url: gatewayUrl });
    } else if (change === "connection") {
      state.connectionEpoch += 1;
    }
    response.resolve(payload);
    if (remote) {
      await expect(result).rejects.toThrow("same-origin Gateway connection");
      expect(request).not.toHaveBeenCalled();
    } else if (change !== "none") {
      await expect(result).resolves.toBeNull();
      // Scope replacement suppresses the stale grant; only its UI owner aborts transport.
      expect(controller.signal.aborted).toBe(false);
    } else {
      await expect(result).resolves.toEqual({
        filename: "report.md",
        url: `${resourceBasePath}/api/artifacts/download/connection/ticket`,
      });
      expect(request).toHaveBeenCalledWith("sessions.files.download", params, {
        signal: expect.any(AbortSignal),
      });
    }
  },
);

it("routes file download connection errors through the catalog", async () => {
  const translate = vi.spyOn(i18n, "t");
  const client = new GatewayBrowserClient({ url: "wss://other-gateway.example.test" });
  const result = downloadSessionFile(
    { client, connected: true, connectionEpoch: 1, sessionKey: "main" },
    { sessionKey: "main", path: "report.pdf" },
    new AbortController().signal,
  );
  await expect(result).rejects.toBeInstanceOf(Error);
  expect(translate).toHaveBeenCalledWith("chat.detailPanel.sameOrigin", undefined);
});
