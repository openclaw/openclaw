import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { expect, it } from "vitest";
import { createMockServerResponse } from "../test-utils/mock-http-response.js";
import { handleBrowserPairHttpRequest } from "./browser-pair-http.js";

it.each([
  ["refuses a remote socket claiming", "localhost:18789", "203.0.113.9", 403],
  ["lets a LAN socket reach body validation from", "192.168.1.20:18789", "192.168.1.30", 400],
])("%s the page %s", async (_name, host, remoteAddress, status) => {
  const req = Object.assign(Readable.from(["{}"]), {
    method: "POST",
    headers: { host, origin: `http://${host}` },
    socket: { remoteAddress },
  }) as unknown as IncomingMessage;
  const res = createMockServerResponse();
  await handleBrowserPairHttpRequest({
    req,
    res,
    action: "start",
    config: {},
    clientIp: remoteAddress,
  });
  expect(res.statusCode).toBe(status);
  expect(String(res.body).includes("origin_not_allowed")).toBe(status === 403);
});
