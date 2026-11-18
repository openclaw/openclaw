import { createServer } from "node:http";
import { expect, it } from "vitest";
import * as httpFixtures from "../../test/helpers/gateway-integration-fixtures.js";
import { readRemoteMediaBuffer } from "./fetch.js";

it("readRemoteMediaBuffer preserves extensionless bytes with a prototype-named Content-Type", async () => {
  const contentType = "__proto__";
  const bytes = Buffer.from("OpenClaw MIME attachment probe\n");
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": contentType }).end(bytes);
  });
  const origin = await httpFixtures.listenLoopback(server);
  try {
    const result = await readRemoteMediaBuffer({
      url: `${origin}/attachment`,
      ssrfPolicy: { allowedOrigins: [origin] },
    });
    expect(result.buffer).toEqual(bytes);
    expect(result.contentType).toBe(contentType);
    expect(result.fileName).toBe("attachment");
  } finally {
    await httpFixtures.closeHttpServer(server);
  }
});
