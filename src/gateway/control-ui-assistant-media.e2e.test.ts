import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { readHttp } from "./control-ui-fixture.test-support.js";
import { installGatewayTestHooks, testState, withGatewayServer } from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });
const auth = { mode: "token", token: "test-gateway-token-1234567890" } as const;
const mediaBody = "ticketed control ui media\n";
const authorized = { headers: { Authorization: `Bearer ${auth.token}` } };

test("serves local assistant media through scoped tickets over the gateway HTTP route", async () => {
  const stateDir = process.env.OPENCLAW_STATE_DIR;
  if (!stateDir) {
    throw new Error("OPENCLAW_STATE_DIR is required for gateway e2e media fixtures");
  }
  testState.gatewayAuth = { ...auth };
  const mediaDir = path.join(stateDir, "media", "control-ui-assistant-media-e2e");
  await fs.mkdir(mediaDir, { recursive: true });
  const write = async (name: string, body: string) => {
    const target = path.join(mediaDir, name);
    await fs.writeFile(target, body, "utf8");
    return target;
  };
  const filePath = await write("测试 ticketed (final).txt", mediaBody);
  await withGatewayServer(
    async ({ port }) => {
      const route = `http://127.0.0.1:${port}/__openclaw__/assistant-media`;
      const url = (params: Record<string, string>) => `${route}?${new URLSearchParams(params)}`;
      const metadata = await readHttp(url({ meta: "1", source: filePath }), authorized);
      expect(metadata.status).toBe(200);
      const payload = metadata.json() as {
        available?: boolean;
        mediaTicket?: string;
        mediaTicketExpiresAt?: string;
      };
      expect(payload).toMatchObject({
        available: true,
        mediaTicket: expect.stringMatching(/^v1\./),
      });
      expect(Date.parse(payload.mediaTicketExpiresAt ?? "")).not.toBeNaN();
      const read = (
        options: Parameters<typeof readHttp>[1] = {},
        source = filePath,
        ticket: string | null = payload.mediaTicket ?? null,
      ) => readHttp(url({ source, ...(ticket === null ? {} : { mediaTicket: ticket }) }), options);
      expect((await read({}, filePath, null)).status).toBe(401);
      expect((await read({}, filePath, payload.mediaTicket?.slice(0, -1) ?? "")).status).toBe(401);
      const refresh = await readHttp(
        url({ meta: "1", source: filePath, mediaTicket: payload.mediaTicket ?? "" }),
      );
      expect(refresh).toMatchObject({ status: 401, text: expect.stringContaining("Unauthorized") });
      const delivered = { status: 200, text: mediaBody };
      expect(await read()).toMatchObject({
        ...delivered,
        headers: {
          "content-disposition": `attachment; filename="__ ticketed (final).txt"; filename*=UTF-8''%E6%B5%8B%E8%AF%95%20ticketed%20%28final%29.txt`,
        },
      });
      const fileUrl = pathToFileURL(filePath).href.replace(/^file:\/\//u, "FILE:");
      expect(await read({}, fileUrl)).toMatchObject(delivered);
      expect((await read(authorized, "FILE://evil-host/etc/hostname", null)).status).toBe(404);
      const validators = { etag: null, "last-modified": null, "accept-ranges": "bytes" };
      expect(await read({ headers: { Range: "bytes=9-15" } })).toMatchObject({
        status: 206,
        text: "control",
        headers: { ...validators, "content-range": "bytes 9-15/26", "content-length": "7" },
      });
      expect(await read({ method: "HEAD" })).toMatchObject({
        status: 200,
        text: "",
        headers: { ...validators, "content-length": "26" },
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
        expect(fresh).toMatchObject({
          status: 200,
          text: method === "GET" ? mediaBody : "",
          headers: { etag: null, "content-length": "26" },
        });
        expect(
          await read({ method, headers: { "If-None-Match": "*", Range: "bytes=9-15" } }),
        ).toMatchObject({
          status: 304,
          text: "",
          headers: { "content-length": null },
        });
      }
      expect(await read(authorized, await write("empty.bin", ""), null)).toMatchObject({
        status: 200,
        byteLength: 0,
        headers: { "content-length": "0" },
      });
      expect((await read({}, await write("other-preview.txt", "other media\n"))).status).toBe(401);
    },
    { serverOptions: { auth: { ...auth }, controlUiEnabled: true } },
  );
});
