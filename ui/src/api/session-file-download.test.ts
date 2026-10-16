/* @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import { GatewayBrowserClient } from "./gateway.ts";
import { downloadSessionFile } from "./session-file-download.ts";

afterEach(() => vi.restoreAllMocks());

it.each([false, true])(
  "binds native downloads to the serving Gateway (remote: %s)",
  async (remote) => {
    const client = new GatewayBrowserClient({
      url: remote ? "wss://other-gateway.example.test" : location.origin.replace(/^http/u, "ws"),
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
        resourceBasePath: "/control",
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
        url: "/control/api/artifacts/download/connection/ticket",
      });
      expect(request).toHaveBeenCalledWith("sessions.files.download", params);
    }
  },
);
