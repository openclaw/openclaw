import { fetch as realFetch } from "undici";
import { describe, expect, it } from "vitest";
import {
  getBrowserControlServerBaseUrl,
  installBrowserControlServerHooks,
  setBrowserControlServerAttachOnly,
  setBrowserControlServerReachable,
  startBrowserControlServerFromConfig,
} from "./server.control-server.test-harness.js";

describe("browser control server status diagnostics", () => {
  installBrowserControlServerHooks();

  it("includes CDP reachability diagnostics in GET /", async () => {
    setBrowserControlServerAttachOnly(true);
    setBrowserControlServerReachable(false);

    await startBrowserControlServerFromConfig();
    const base = getBrowserControlServerBaseUrl();

    const response = await realFetch(`${base}/`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      diagnostics?: Array<{ code?: string; layer?: string; level?: string; summary?: string }>;
    };

    expect(body.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "LOCAL_CDP_HTTP_UNREACHABLE",
          layer: "cdp",
          level: "warn",
          summary: expect.stringContaining("/json/version"),
        }),
      ]),
    );
  });
});
