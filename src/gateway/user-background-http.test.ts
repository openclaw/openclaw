import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { getRuntimeConfig } from "../config/io.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { removeUserBackground, uploadUserBackground } from "../state/user-background.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { handleUserBackgroundHttpRequest } from "./user-background-http.js";

// Configuration and image computation are fixtures; HTTP identity, scope and origin checks are real.
vi.mock("../config/io.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/io.js")>()),
  getRuntimeConfig: vi.fn(() => ({})),
}));
vi.mock("../state/user-background-image.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/user-background-image.js")>()),
  normalizeUserBackgroundImage: vi.fn(async () => ({
    image: Buffer.from([255, 216, 255, 217]),
    width: 1,
    height: 1,
  })),
}));
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
});

const auth = {
  mode: "trusted-proxy" as const,
  allowTailscale: false,
  trustedProxy: {
    userHeader: "x-forwarded-user",
    requiredHeaders: ["x-forwarded-proto"],
    allowLoopback: true,
  },
};
function headers(
  user = "one@example.test",
  scopes = "operator.read",
  origin = "https://control.example.test",
) {
  return {
    "x-forwarded-for": "198.51.100.23",
    "x-forwarded-user": user,
    "x-forwarded-proto": "https",
    "x-openclaw-scopes": scopes,
    Origin: origin,
  };
}

describe("private background byte route with real HTTP authentication", () => {
  it("authorizes ordinary profile readers, denies foreign/admin access, and supports configured remote UI origins", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("background-http-"));
    vi.mocked(getRuntimeConfig).mockReturnValue({
      gateway: {
        auth,
        trustedProxies: ["127.0.0.1"],
        controlUi: { allowedOrigins: ["https://control.example.test"] },
      },
    });
    const first = ensureProfileForEmail("one@example.test").id;
    ensureProfileForEmail("two@example.test");
    const uploaded = await uploadUserBackground(first, {
      expectedAssetId: null,
      expectedPreference: null,
      imageBase64: "fixture",
    });
    if (uploaded.status !== "ok" || !uploaded.asset) {
      throw new Error("Missing fixture");
    }
    const path = "/control/__openclaw__/users/background/" + uploaded.asset.assetId;
    const expected = {
      expectedAssetId: uploaded.asset.assetId,
      expectedPreference: uploaded.preference,
    };
    const server = createServer((req, res) => {
      void handleUserBackgroundHttpRequest(
        req,
        res,
        new URL(req.url!, "http://localhost").pathname,
        { auth, basePath: "/control", trustedProxies: ["127.0.0.1"], publishedPort: 19123 },
      )
        .then((handled) => {
          if (!handled) {
            res.writeHead(404);
            res.end();
          }
        })
        .catch(() => {
          res.writeHead(500);
          res.end();
        });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const url = "http://127.0.0.1:" + (server.address() as AddressInfo).port + path;
    try {
      const result = await fetch(url, { headers: headers() });
      expect(result.status).toBe(200);
      expect(result.headers.get("content-type")).toBe("image/jpeg");
      expect(result.headers.get("cache-control")).toBe("private, no-store");
      expect(result.headers.get("access-control-allow-origin")).toBe(
        "https://control.example.test",
      );
      expect(result.headers.get("access-control-allow-credentials")).toBe("true");
      expect(new Uint8Array(await result.arrayBuffer())).toEqual(
        new Uint8Array([255, 216, 255, 217]),
      );
      const head = await fetch(url, { method: "HEAD", headers: headers() });
      expect(head.status).toBe(200);
      expect(await head.text()).toBe("");
      const preflight = await fetch(url, {
        method: "OPTIONS",
        headers: {
          Origin: "https://control.example.test",
          "Access-Control-Request-Headers": "authorization",
        },
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("access-control-allow-headers")).toBe("Authorization");
      const cfg = getRuntimeConfig();
      vi.mocked(getRuntimeConfig).mockReturnValue({
        gateway: {
          auth,
          trustedProxies: ["127.0.0.1"],
          publicOrigin: "https://rotated.example.test",
        },
      });
      const mapped = await fetch(url, {
        headers: headers("one@example.test", "operator.read", "http://localhost:19123"),
      });
      expect(mapped.status).toBe(200);
      expect(mapped.headers.get("access-control-allow-origin")).toBe("http://localhost:19123");
      await mapped.arrayBuffer();
      vi.mocked(getRuntimeConfig).mockReturnValue({
        gateway: { auth, trustedProxies: ["127.0.0.1"], controlUi: { allowedOrigins: [] } },
      });
      const denied = await fetch(url, {
        method: "OPTIONS",
        headers: { Origin: "http://localhost:19123" },
      });
      expect(denied.status).toBe(403);
      expect(denied.headers.get("access-control-allow-origin")).toBeNull();
      await denied.arrayBuffer();
      vi.mocked(getRuntimeConfig).mockReturnValue(cfg);
      expect(
        (await fetch(url, { headers: headers("two@example.test", "operator.admin") })).status,
      ).toBe(404);
      expect((await fetch(url, { headers: headers("one@example.test", "") })).status).toBe(403);
      expect(
        (
          await fetch(url, {
            headers: headers("one@example.test", "operator.read", "https://untrusted.example.test"),
          })
        ).status,
      ).toBe(401);
      expect((await fetch(url)).status).toBe(401);
      expect((await fetch(url + "?token=not-authority")).status).toBe(401);
      await removeUserBackground(first, expected);
      expect((await fetch(url, { headers: headers() })).status).toBe(404);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
