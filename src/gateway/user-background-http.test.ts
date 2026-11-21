import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { getRuntimeConfig } from "../config/io.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { removeUserBackground, uploadUserBackground } from "../state/user-background.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { createTestGatewayHttpServer } from "./http-server.test-support.js";
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
  const server = createTestGatewayHttpServer((req, res) =>
    handleUserBackgroundHttpRequest(req, res, new URL(req.url!, "http://localhost").pathname, {
      auth,
      basePath: "/control",
      trustedProxies: ["127.0.0.1"],
    }),
  );
  const url = `http://127.0.0.1:${await server.listen()}${path}`;
  const expectStatus = async (status: number, init?: RequestInit, suffix = "") => {
    expect((await fetch(url + suffix, init)).status).toBe(status);
  };
  try {
    const result = await fetch(url, { headers: headers() });
    expect(result.status).toBe(200);
    expect(Object.fromEntries(result.headers)).toMatchObject({
      "content-type": "image/jpeg",
      "cache-control": "private, no-store",
      "access-control-allow-origin": "https://control.example.test",
      "access-control-allow-credentials": "true",
    });
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
    await expectStatus(404, { headers: headers("two@example.test", "operator.admin") });
    await expectStatus(403, { headers: headers("one@example.test", "") });
    await expectStatus(401, {
      headers: headers("one@example.test", "operator.read", "https://untrusted.example.test"),
    });
    await expectStatus(401);
    await expectStatus(401, undefined, "?token=not-authority");
    await removeUserBackground(first, expected);
    await expectStatus(404, { headers: headers() });
  } finally {
    await server.close();
  }
});
