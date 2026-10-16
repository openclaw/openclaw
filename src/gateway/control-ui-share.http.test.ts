import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { reserveTestPortListener } from "../test-utils/port-claims.js";
import type { ControlUiRootState } from "./server-control-ui-root.js";
import { AUTH_TOKEN, createTestGatewayServer } from "./server-http.test-harness.js";

describe("public Control UI previews", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  it.each(["", "/control"])("serves a private-data-free preview under %s", async (basePath) => {
    const root = tempDirs.make("openclaw-social-preview-");
    const cardBytes = fs.readFileSync(path.resolve("ui/public/apple-touch-icon.png"));
    fs.writeFileSync(path.join(root, "social-card.png"), cardBytes);
    const rootState: ControlUiRootState = { kind: "resolved", path: root };
    const {
      listener: server,
      claim,
      releaseListener,
    } = await reserveTestPortListener({
      offsets: [0],
      createListener: () =>
        createTestGatewayServer({
          resolvedAuth: AUTH_TOKEN,
          overrides: {
            controlUiEnabled: true,
            controlUiBasePath: basePath,
            controlUiRoot: rootState,
            getRuntimeConfig: () => ({
              gateway: { publicOrigin: "https://gateway.example.test" },
            }),
          },
        }),
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Missing test server address");
    }
    const origin = `http://127.0.0.1:${address.port}${basePath}`;
    try {
      const route = "/share/dashboard/example/private-name";
      const response = await fetch(`${origin}${route}?token=secret-value&draft=private-draft`);
      expect(response.status).toBe(200);
      expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
      expect(response.headers.get("content-type")).toContain("text/html");
      const html = await response.text();
      expect(html).toContain('<meta name="robots" content="noindex, nofollow">');
      expect(html).toContain('<meta property="og:title" content="OpenClaw dashboard">');
      expect(html).toContain(`content="https://gateway.example.test${basePath}/share/card.png"`);
      expect(html).toContain(`href="${basePath}/dashboard/example/private-name"`);
      expect(html).not.toMatch(/secret-value|private-draft|<script|openclaw-app/);
      expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      const head = await fetch(`${origin}${route}`, { method: "HEAD" });
      expect(head.status).toBe(200);
      expect(head.headers.get("x-robots-tag")).toBe("noindex, nofollow");
      expect(await head.text()).toBe("");
      expect(Number(head.headers.get("content-length"))).toBe(Buffer.byteLength(html));
      const card = await fetch(`${origin}/share/card.png`);
      expect(card.status).toBe(200);
      expect(card.headers.get("x-robots-tag")).toBe("noindex, nofollow");
      expect(card.headers.get("cache-control")).toBe("no-cache");
      expect(card.headers.get("content-type")).toContain("image/png");
      const png = Buffer.from(await card.arrayBuffer());
      expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      expect(png).toEqual(cardBytes);
      const catalog = await fetch(
        `${origin}/share/chat/example?catalog=example&host=dev%3Amac&thread=a%22%3E%3Cscript%3E&token=secret-value`,
      );
      expect(await catalog.text()).toContain(
        `href="${basePath}/chat/example?catalog=example&amp;host=dev%3Amac&amp;thread=a%22%3E%3Cscript%3E"`,
      );
      const bootstrap = await fetch(`${origin}/control-ui-config.json`);
      expect(bootstrap.status).toBe(401);
      expect(bootstrap.headers.get("x-robots-tag")).toBeNull();
      const escaped = await fetch(`${origin}/share/chat/example/folder%2Ffile%20name`);
      expect(escaped.status).toBe(200);
      expect(await escaped.text()).toContain(
        `href="${basePath}/chat/example/folder%2Ffile%20name"`,
      );
      for (const invalid of [
        "/share",
        "/share/api/private",
        "/share/chat//session",
        "/share/chat/a/~key",
        "/share/chat/a/%FF",
        `/share/chat/a/${"x".repeat(8192)}`,
      ]) {
        const rejected = await fetch(`${origin}${invalid}`);
        expect(rejected.status, invalid).toBe(404);
        expect(rejected.headers.get("x-robots-tag"), invalid).toBe("noindex, nofollow");
      }
      for (const [requestPath, options, status] of [
        ["/share/card.png", { method: "HEAD" }, 200],
        ["/share/card.png", { headers: { "if-none-match": "*" } }, 304],
        ["/share/card.png", { headers: { "accept-encoding": "identity;q=0, *;q=0" } }, 406],
        [route, { method: "POST" }, 404],
        ["/share/card.png", { method: "POST" }, 404],
        ["/share/session?token=invalid", {}, 404],
        ["/share/session/media?token=invalid", {}, 404],
        ["/share/session/card.png?token=invalid", {}, 200],
      ] as const) {
        const reply = await fetch(`${origin}${requestPath}`, options);
        expect(reply.status, requestPath).toBe(status);
        expect(reply.headers.get("x-robots-tag"), requestPath).toBe("noindex, nofollow");
        await reply.arrayBuffer();
      }
      fs.unlinkSync(path.join(root, "social-card.png"));
      for (const requestPath of ["/share/card.png", "/share/session/card.png?token=invalid"]) {
        const missing = await fetch(`${origin}${requestPath}`);
        expect(missing.status).toBe(404);
        expect(missing.headers.get("x-robots-tag")).toBe("noindex, nofollow");
      }
      Object.assign(rootState, { kind: "preparing" });
      const preparing = await fetch(`${origin}/share/card.png`);
      expect(preparing.status).toBe(503);
      expect(preparing.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    } finally {
      server.closeAllConnections();
      try {
        await releaseListener();
      } finally {
        await claim.release();
      }
    }
  });
});
