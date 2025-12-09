import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, test } from "vitest";
import { startWebChatServer, stopWebChatServer } from "./server.js";

async function getFreePort(): Promise<number> {
  const { createServer } = await import("node:net");
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      const port = address.port as number;
      server.close((err: Error | null) => (err ? reject(err) : resolve(port)));
    });
  });
}

const fetchText = (url: string) =>
  new Promise<string>((resolve, reject) => {
    http
      .get(url, (res) => {
        const chunks: Buffer[] = [];
        res
          .on("data", (c) =>
            chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)),
          )
          .on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")))
          .on("error", reject);
      })
      .on("error", reject);
  });

describe("webchat server (static only)", () => {
  test("serves index.html over loopback", { timeout: 8000 }, async () => {
    const port = await getFreePort();
    await startWebChatServer(port);
    try {
      const body = await fetchText(`http://127.0.0.1:${port}/`);
      expect(body.toLowerCase()).toContain("<html");
    } finally {
      await stopWebChatServer();
    }
  });
});
