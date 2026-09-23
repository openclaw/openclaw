import { createServer } from "node:http";
import { expect, it } from "vitest";
import { readRemoteMediaBuffer } from "./fetch.js";

it.each(["__proto__", "constructor", "application/x-openclaw-probe"])(
  "readRemoteMediaBuffer preserves extensionless bytes with Content-Type %s",
  async (contentType) => {
    const bytes = Buffer.from("OpenClaw MIME attachment probe\n");
    const server = createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": contentType }).end(bytes);
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected an HTTP fixture address");
      }
      const origin = `http://127.0.0.1:${address.port}`;
      const result = await readRemoteMediaBuffer({
        url: `${origin}/attachment`,
        ssrfPolicy: { allowedOrigins: [origin] },
      });
      expect(result.buffer).toEqual(bytes);
      expect(result.contentType).toBe(contentType);
      expect(result.fileName).toBe("attachment");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  },
);
