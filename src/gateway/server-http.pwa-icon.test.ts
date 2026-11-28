import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeEach, expect, it, vi } from "vitest";
import {
  closeHttpServer,
  listenLoopback,
} from "../../test/helpers/gateway-integration-fixtures.js";
import { createSolidPngBuffer } from "../../test/helpers/image-fixtures.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { approveDevicePairing } from "../infra/device-pairing-approval.js";
import { ensureDeviceToken } from "../infra/device-pairing-tokens.js";
import { requestDevicePairing } from "../infra/device-pairing.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { createPwaIconStore } from "./pwa-icon-store.js";
import { AUTH_TOKEN, createTestGatewayServer } from "./server-http.test-harness.js";
import { resolveSharedGatewaySessionGeneration } from "./server/ws-shared-generation.js";
const tempDirs = useAutoCleanupTempDirTracker(afterAll);
const state = tempDirs.make("pwa-install-");
beforeEach(() => {
  vi.stubEnv("OPENCLAW_STATE_DIR", state);
});
afterAll(() => {
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
});

it("publishes only a writer's flattened raster and a deployment-scoped install manifest", async () => {
  const auth = {
    mode: "trusted-proxy" as const,
    allowTailscale: false,
    trustedProxy: { userHeader: "x-forwarded-user", allowLoopback: true },
  };
  const cfg = {
    gateway: { auth, trustedProxies: ["127.0.0.1"], controlUi: { allowedOrigins: ["*"] } },
  };
  ensureProfileForEmail("installer@example.test");
  const basePath = "/gateway";
  const server = createTestGatewayServer({
    resolvedAuth: auth,
    overrides: {
      getRuntimeConfig: () => cfg,
      controlUiEnabled: true,
      controlUiBasePath: basePath,
      controlUiRoot: {
        kind: "resolved",
        path: fileURLToPath(new URL("../../ui/public", import.meta.url)),
      },
    },
  });
  const origin = await listenLoopback(server);
  const upload = origin + basePath + "/pwa-icon";
  const marker = "must not retain arbitrary source payload";
  const png = createSolidPngBuffer(512, 512, { r: 48, g: 35, b: 132 });
  const body = Uint8Array.from(Buffer.concat([png, Buffer.from(marker)]));
  const headers = {
    Origin: origin,
    "x-openclaw-install-device": "a".repeat(64),
    "Content-Type": "image/png",
    "x-openclaw-scopes": "operator.write",
    "x-forwarded-user": "installer@example.test",
    "x-forwarded-for": "198.51.100.24",
    "x-forwarded-proto": "http",
    "sec-fetch-site": "same-origin",
  };
  const post = (extra: Record<string, string>, input = body) =>
    fetch(upload, { method: "POST", body: input, headers: { ...headers, ...extra } });
  const reset = (extra: Record<string, string> = {}) =>
    fetch(upload, { method: "DELETE", headers: { ...headers, ...extra } });
  try {
    for (const slot of ["", "abc", "F".repeat(64), "../elsewhere"]) {
      expect((await post({ "x-openclaw-install-device": slot })).status).toBe(400);
      expect((await reset({ "x-openclaw-install-device": slot })).status).toBe(400);
    }
    expect((await reset({ "x-forwarded-user": "" })).status).toBe(401);
    expect((await reset({ "x-openclaw-scopes": "operator.read" })).status).toBe(403);
    expect((await post({ Origin: "https://other.example.test" })).status).toBe(403);
    expect((await post({ Origin: "" })).status).toBe(403);
    expect((await post({ "x-openclaw-scopes": "operator.read" })).status).toBe(403);
    expect((await post({ "x-forwarded-user": "" })).status).toBe(401);
    const wrongType = await post({ "Content-Type": "image/svg+xml" });
    expect(wrongType.status, await wrongType.text()).toBe(415);
    expect((await post({}, new Uint8Array([1, 2, 3]))).status).toBe(400);
    expect((await post({}, new Uint8Array(2 * 1024 * 1024 + 1))).status).toBe(413);
    const created = await post({});
    const receipt = await created.text();
    expect(created.status, receipt).toBe(200);
    const { iconUrl, manifestUrl } = JSON.parse(receipt);
    expect(iconUrl).toMatch(/^\/gateway\/pwa-icon\/[0-9a-f]{64}\/icon\.png$/u);
    const icon = await fetch(origin + iconUrl);
    expect(icon.headers.get("content-type")).toBe("image/png");
    const bytes = Buffer.from(await icon.arrayBuffer());
    expect(bytes.readUInt32BE(16)).toBe(512);
    expect(bytes.readUInt32BE(20)).toBe(512);
    expect(bytes.includes(marker)).toBe(false);
    const manifest = await fetch(origin + manifestUrl);
    expect(manifest.headers.get("content-type")).toBe("application/manifest+json");
    const content = await manifest.json();
    expect(content).toMatchObject({
      name: "OpenClaw Control",
      id: "/gateway/",
      start_url: "/gateway/",
      scope: "/gateway/",
      icons: [
        { src: "./icon.png", sizes: "512x512", type: "image/png" },
        { src: "./icon-192.png", sizes: "192x192", type: "image/png" },
      ],
    });
    expect(new URL(content.icons[0].src, manifest.url).pathname).toBe(iconUrl);
    expect((await fetch(origin + iconUrl, { method: "HEAD" })).headers.get("content-length")).toBe(
      String(bytes.length),
    );
    expect((await fetch(upload + "/missing/manifest.webmanifest")).status).toBe(404);
    expect((await fetch(upload + "/" + "0".repeat(64) + "/icon.png")).status).toBe(404);
    for (const [file, size] of [
      ["icon-192.png", 192],
      ["apple-touch-icon.png", 180],
    ] as const) {
      const variant = await fetch(new URL(file, manifest.url));
      const image = Buffer.from(await variant.arrayBuffer());
      expect([image.readUInt32BE(16), image.readUInt32BE(20)]).toEqual([size, size]);
    }
    const second = await post({ "x-openclaw-install-device": "b".repeat(64) });
    expect(second.status).toBe(200);
    const otherDevice = await second.json();
    expect(otherDevice.iconUrl).not.toBe(iconUrl);
    expect((await fetch(origin + iconUrl)).status).toBe(200);
    const replaced = await post(
      {},
      Uint8Array.from(createSolidPngBuffer(512, 512, { r: 0, g: 0, b: 0 })),
    );
    expect(replaced.status).toBe(200);
    const replacement = await replaced.json();
    expect(replacement.iconUrl).not.toBe(iconUrl);
    expect((await fetch(origin + iconUrl)).status).toBe(404);
    const directory = path.join(state, "pwa-icons");
    expect(await readdir(directory)).toHaveLength(8);
    const secondPerson = await post({ "x-forwarded-user": "another@example.test" });
    expect(secondPerson.status).toBe(200);
    expect((await secondPerson.json()).iconUrl).not.toBe(iconUrl);
    expect(await readdir(directory)).toHaveLength(12);
    expect((await reset({ "x-forwarded-user": "another@example.test" })).status).toBe(204);
    const durable = createPwaIconStore(directory);
    const token = replacement.iconUrl.split("/").at(-2);
    expect(await durable.read(token, 512)).toEqual(
      Buffer.from(await (await fetch(origin + replacement.iconUrl)).arrayBuffer()),
    );
    expect((await reset({ "x-forwarded-user": "colleague@example.test" })).status).toBe(204);
    expect((await fetch(origin + replacement.iconUrl)).status).toBe(200);
    expect((await reset()).status).toBe(204);
    expect((await reset()).status).toBe(204);
    for (const file of [
      "icon.png",
      "icon-192.png",
      "apple-touch-icon.png",
      "manifest.webmanifest",
    ]) {
      expect((await fetch(new URL(file, origin + replacement.iconUrl))).status).toBe(404);
    }
    expect((await fetch(origin + otherDevice.iconUrl)).status).toBe(200);
    expect(await readdir(directory)).toHaveLength(4);
    expect(await createPwaIconStore(directory).has(token)).toBe(false);
  } finally {
    await closeHttpServer(server);
  }
});

it("accepts a paired writer or gateway secret, not anonymous or read-only devices", async () => {
  const png = Uint8Array.from(createSolidPngBuffer(512, 512, { r: 7, g: 8, b: 9 }));
  for (const auth of [AUTH_TOKEN, { mode: "none", allowTailscale: false } as const]) {
    const server = createTestGatewayServer({
      resolvedAuth: auth,
      overrides: {
        controlUiEnabled: true,
        controlUiBasePath: "",
        getRuntimeConfig: () => ({ gateway: { auth } }),
      },
    });
    const origin = await listenLoopback(server);
    const mutate = (method: "POST" | "DELETE", token?: string) =>
      fetch(origin + "/pwa-icon", {
        method,
        body: method === "POST" ? png : undefined,
        headers: {
          Origin: origin,
          "sec-fetch-site": "same-origin",
          "Content-Type": "image/png",
          "x-openclaw-install-device": "c".repeat(64),
          "x-openclaw-scopes": "operator.admin",
          ...(token ? { Authorization: "Bearer " + token } : {}),
        },
      });
    try {
      for (const method of ["POST", "DELETE"] as const) {
        expect([401, 403]).toContain((await mutate(method)).status);
      }
      if (auth.mode === "none") {
        continue;
      }
      const upload = await mutate("POST", AUTH_TOKEN.token);
      expect(upload.status, await upload.clone().text()).toBe(200);
      const { iconUrl } = await upload.json();
      expect(iconUrl).toMatch(/^\/pwa-icon\//u);
      for (const scope of ["operator.read", "operator.write"]) {
        const identity = { deviceId: "pwa-" + scope, role: "operator", scopes: [scope] };
        const pair = await requestDevicePairing({
          ...identity,
          publicKey: "fixture-key-" + scope,
          clientId: "openclaw-control-ui",
          clientMode: "webchat",
        });
        await approveDevicePairing(pair.request.requestId, { callerScopes: [scope] });
        const bearer = await ensureDeviceToken({
          ...identity,
          issuer: {
            kind: "shared-gateway-auth",
            generation: resolveSharedGatewaySessionGeneration(auth, [])!,
          },
        });
        expect(bearer).not.toBeNull();
        const response = await mutate("DELETE", bearer!.token);
        expect(response.status, await response.text()).toBe(scope === "operator.write" ? 204 : 403);
      }
      expect((await fetch(origin + iconUrl)).status).toBe(404);
    } finally {
      await closeHttpServer(server);
    }
  }
});

it("bounds new slots without preventing replacement or reset at quota", async () => {
  const dir = tempDirs.make("pwa-quota-");
  const store = createPwaIconStore(dir);
  const png = Buffer.from("opaque fixture");
  const rasters = { 512: png, 192: png, 180: png };
  const slot = (i: number) => i.toString(16).padStart(64, "0");
  for (let p = 0; p < 16; ++p) {
    for (let d = 0; d < 8; ++d) {
      expect((await store.set(String(p), slot(d), rasters)).status).toBe("ok");
    }
    expect((await store.set(String(p), slot(8), rasters)).status).toBe("full");
  }
  expect((await store.set("new-profile", slot(0), rasters)).status).toBe("full");
  expect((await store.set("0", slot(0), rasters)).status).toBe("ok");
  expect((await store.set("0", slot(0), null)).status).toBe("ok");
  expect((await store.set("new-profile", slot(0), rasters)).status).toBe("ok");
});
