import { writeFileSync, symlinkSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { ModelProviderConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readImageProbeFromHeader } from "../media/image-ops.js";
import { resolveProviderPresentation } from "./provider-presentation.js";
import { AUTH_TOKEN, sendRequest, withGatewayServer } from "./server-http.test-harness.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGMwSJiAFTEMLQkACmxIAasRElQAAAAASUVORK5CYII=",
  "base64",
);
const AUTH = "Bearer test-token";
function configuration(
  icon: NonNullable<ModelProviderConfig["icon"]>,
  provider = "workstation",
): OpenClawConfig {
  return {
    models: {
      providers: {
        [provider]: {
          baseUrl: "http://127.0.0.1:11434/v1",
          models: [],
          name: "Workstation",
          icon,
        },
      },
    },
  };
}
function iconUrl(cfg: OpenClawConfig): string {
  const icon = resolveProviderPresentation(cfg, "workstation").providerIcon;
  if (icon?.source !== "asset") {
    throw new Error("expected scoped icon asset");
  }
  return icon.url;
}
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("provider artwork through authenticated Gateway HTTP", () => {
  it("serves only configured raster files, strips artwork to PNG, and observes presentation reloads", async () => {
    const dir = dirs.make("provider-icon-");
    writeFileSync(path.join(dir, "workstation.png"), PNG);
    let cfg = configuration({ source: "file", path: "workstation.png" });
    await withGatewayServer({
      prefix: "provider-artwork-",
      resolvedAuth: AUTH_TOKEN,
      overrides: {
        controlUiEnabled: true,
        controlUiBasePath: "/dashboard",
        getRuntimeConfig: () => cfg,
      },
      run: async (server) => {
        vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(dir, "openclaw.json"));
        const url = "/dashboard" + iconUrl(cfg);
        cfg = configuration({ source: "file", path: "workstation.png" }, " Workstation ");
        expect(url).not.toContain("workstation.png");
        const unauthorized = await sendRequest(server, { path: url });
        expect(unauthorized.res.statusCode).toBe(401);
        const response = await sendRequest(server, { path: url, authorization: AUTH });
        expect(response.res.statusCode).toBe(200);
        expect(response.setHeader).toHaveBeenCalledWith("content-type", "image/png");
        const body = response.end.mock.calls[0]?.[0];
        if (!Buffer.isBuffer(body)) {
          throw new Error("expected sanitized PNG bytes");
        }
        expect(readImageProbeFromHeader(body)).toMatchObject({
          format: "png",
          width: 8,
          height: 8,
        });
        const etag = response.setHeader.mock.calls.find(([key]) => key === "etag")?.[1];
        const unchanged = await sendRequest(server, {
          path: url,
          authorization: AUTH,
          headers: { "if-none-match": String(etag) },
        });
        expect(unchanged.res.statusCode).toBe(304);
        const head = await sendRequest(server, { path: url, authorization: AUTH, method: "HEAD" });
        expect(head.res.statusCode).toBe(200);
        expect(head.getBody()).toBe("");
        const denied = await sendRequest(server, {
          path: url,
          authorization: AUTH,
          method: "POST",
        });
        expect(denied.res.statusCode).toBe(405);
        const unknown = await sendRequest(server, {
          path: url.replace("workstation?", "another?"),
          authorization: AUTH,
        });
        expect(unknown.res.statusCode).toBe(404);
        const unversioned = await sendRequest(server, {
          path: url.replace(/v=[^&]+/, "v=arbitrary"),
          authorization: AUTH,
        });
        expect(unversioned.res.statusCode).toBe(404);
        const ignoredPath = await sendRequest(server, {
          path: url + "&path=/etc/passwd",
          authorization: AUTH,
        });
        expect(ignoredPath.res.statusCode).toBe(200);
        expect(ignoredPath.end.mock.calls[0]?.[0]).toEqual(body);
        cfg = configuration({ source: "file", path: "missing.png" });
        const retired = await sendRequest(server, { path: url, authorization: AUTH });
        expect(retired.res.statusCode).toBe(404);
        const unavailable = await sendRequest(server, {
          path: "/dashboard" + iconUrl(cfg),
          authorization: AUTH,
        });
        expect(unavailable.res.statusCode).toBe(404);
      },
    });
  });

  it("rejects active, malformed, oversized, and symlinked file payloads without serving source bytes", async () => {
    const dir = dirs.make("provider-invalid-icon-");
    writeFileSync(
      path.join(dir, "active.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>',
    );
    writeFileSync(path.join(dir, "broken.png"), PNG.subarray(0, 20));
    writeFileSync(path.join(dir, "large.png"), Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]));
    writeFileSync(path.join(dir, "valid.png"), PNG);
    const outside = dirs.make("provider-icon-outside-namespace-");
    writeFileSync(path.join(outside, "valid.png"), PNG);
    symlinkSync(path.join(outside, "valid.png"), path.join(dir, "linked.png"));
    let cfg = configuration({ source: "file", path: "active.svg" });
    await withGatewayServer({
      prefix: "provider-invalid-artwork-",
      resolvedAuth: AUTH_TOKEN,
      overrides: { controlUiEnabled: true, controlUiBasePath: "", getRuntimeConfig: () => cfg },
      run: async (server) => {
        for (const name of ["active.svg", "broken.png", "large.png", "linked.png"]) {
          cfg = configuration({ source: "file", path: path.join(dir, name) });
          const response = await sendRequest(server, { path: iconUrl(cfg), authorization: AUTH });
          expect(response.res.statusCode, name).toBe(404);
          expect(response.getBody(), name).not.toContain("<svg");
        }
      },
    });
  });

  it("fetches public HTTPS artwork but blocks private targets before network I/O", async () => {
    // Fixed network response only: real fetch guard, raster decoding, and HTTP response.
    const network = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(
        async () => new Response(PNG, { headers: { "content-type": "image/png" } }),
      );
    let cfg = configuration({ source: "url", url: "https://1.1.1.1/provider-icon.png" });
    await withGatewayServer({
      prefix: "provider-remote-artwork-",
      resolvedAuth: AUTH_TOKEN,
      overrides: { controlUiEnabled: true, controlUiBasePath: "", getRuntimeConfig: () => cfg },
      run: async (server) => {
        const publicImage = await sendRequest(server, { path: iconUrl(cfg), authorization: AUTH });
        expect(publicImage.res.statusCode).toBe(200);
        expect(network).toHaveBeenCalledOnce();
        network.mockClear();
        cfg = configuration({ source: "url", url: "https://127.0.0.1/private.png" });
        const blocked = await sendRequest(server, { path: iconUrl(cfg), authorization: AUTH });
        expect(blocked.res.statusCode).toBe(404);
        expect(network).not.toHaveBeenCalled();
      },
    });
  });
});
