import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { installGatewayTestHooks, testState, withGatewayServer } from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const auth = { mode: "token", token: "test-gateway-token-1234567890" } as const;
const mediaBody = "ticketed control ui media\n";
type HeaderValues = Record<string, string | null>;

async function checkReply(res: Response, code: number, body: string, headers: HeaderValues = {}) {
  expect(res.status).toBe(code);
  expect(await res.text()).toBe(body);
  for (const [name, value] of Object.entries(headers)) {
    expect(res.headers.get(name), name).toBe(value);
  }
}

test("serves local assistant media through scoped tickets over the gateway HTTP route", async () => {
  const stateDir = process.env.OPENCLAW_STATE_DIR;
  if (!stateDir) {
    throw new Error("OPENCLAW_STATE_DIR is required for gateway e2e media fixtures");
  }
  testState.gatewayAuth = { ...auth };

  const mediaDir = path.join(stateDir, "media", "control-ui-assistant-media-e2e");
  await fs.mkdir(mediaDir, { recursive: true });
  const filePath = path.join(mediaDir, "测试 ticketed (final).txt");
  await fs.writeFile(filePath, mediaBody, "utf8");

  await withGatewayServer(
    async ({ port }) => {
      const route = `http://127.0.0.1:${port}/__openclaw__/assistant-media`;
      const sourceParam = encodeURIComponent(filePath);
      const metadata = await fetch(`${route}?meta=1&source=${sourceParam}`, {
        headers: { Authorization: `Bearer ${auth.token}` },
      });
      expect(metadata.status).toBe(200);
      const payload = (await metadata.json()) as {
        available?: boolean;
        mediaTicket?: string;
        mediaTicketExpiresAt?: string;
      };
      expect(payload.available).toBe(true);
      expect(payload.mediaTicket).toMatch(/^v1\./);
      expect(Date.parse(payload.mediaTicketExpiresAt ?? "")).not.toBeNaN();
      const read = (options: RequestInit = {}, source = filePath, ticket = payload.mediaTicket) =>
        fetch(
          `${route}?source=${encodeURIComponent(source)}&mediaTicket=${encodeURIComponent(ticket ?? "")}`,
          options,
        );

      const withoutTicket = await fetch(`${route}?source=${sourceParam}`);
      expect(withoutTicket.status).toBe(401);
      expect((await read({}, filePath, payload.mediaTicket?.slice(0, -1))).status).toBe(401);
      const refresh = await fetch(
        `${route}?meta=1&source=${sourceParam}&mediaTicket=${encodeURIComponent(payload.mediaTicket ?? "")}`,
      );
      expect(refresh.status).toBe(401);
      expect(await refresh.text()).toContain("Unauthorized");

      await checkReply(await read(), 200, mediaBody, {
        "content-disposition": `attachment; filename="__ ticketed (final).txt"; filename*=UTF-8''%E6%B5%8B%E8%AF%95%20ticketed%20%28final%29.txt`,
      });

      const fileUrl = pathToFileURL(filePath).href;
      for (const source of [
        fileUrl,
        fileUrl.replace(/^file:/u, "FILE:"),
        fileUrl.replace(/^file:\/\//u, "file:"),
        fileUrl.replace(/^file:\/\//u, "FILE:"),
      ]) {
        await checkReply(await read({}, source), 200, mediaBody);
      }
      for (const source of ["file://evil-host/etc/hostname", "FILE://evil-host/etc/hostname"]) {
        const remoteHost = await fetch(`${route}?source=${encodeURIComponent(source)}`, {
          headers: { Authorization: `Bearer ${auth.token}` },
        });
        expect(remoteHost.status, source).toBe(404);
      }

      const validators = { etag: null, "last-modified": null };
      await checkReply(await read({ headers: { Range: "bytes=9-15" } }), 206, "control", {
        ...validators,
        "accept-ranges": "bytes",
        "content-range": "bytes 9-15/26",
        "content-length": "7",
      });
      await checkReply(await read({ method: "HEAD" }), 200, "", {
        ...validators,
        "accept-ranges": "bytes",
        "content-length": "26",
      });

      for (const method of ["GET", "HEAD"]) {
        const fresh = await read({
          method,
          headers: {
            "If-None-Match": 'W/"cached-version"',
            Range: "bytes=9-15",
            "If-Range": '"stale"',
          },
        });
        await checkReply(fresh, 200, method === "GET" ? mediaBody : "", {
          etag: null,
          "content-length": "26",
        });

        const exists = await read({
          method,
          headers: { "If-None-Match": "*", Range: "bytes=9-15" },
        });
        await checkReply(exists, 304, "", { "content-length": null });
      }

      const emptyFilePath = path.join(mediaDir, "empty.bin");
      await fs.writeFile(emptyFilePath, Buffer.alloc(0));
      const empty = await fetch(`${route}?source=${encodeURIComponent(emptyFilePath)}`, {
        headers: { Authorization: `Bearer ${auth.token}` },
      });
      expect(empty.status).toBe(200);
      expect(empty.headers.get("content-length")).toBe("0");
      expect((await empty.arrayBuffer()).byteLength).toBe(0);

      const otherFilePath = path.join(mediaDir, "other-preview.txt");
      await fs.writeFile(otherFilePath, "other media\n", "utf8");
      const wrongSource = await read({}, otherFilePath);
      expect(wrongSource.status).toBe(401);
    },
    {
      serverOptions: {
        auth: { ...auth },
        controlUiEnabled: true,
      },
    },
  );
});
