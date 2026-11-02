import type { IncomingMessage } from "node:http";
import { expect, it } from "vitest";
import { createMockServerResponse } from "../test-utils/mock-http-response.js";
import { handleBrowserPairHttpRequest } from "./browser-pair-http.js";

it("refuses a remote socket that claims a loopback page", async () => {
  const req = {
    method: "POST",
    headers: { host: "localhost:18789", origin: "http://localhost:18789" },
    socket: { remoteAddress: "203.0.113.9" },
  } as unknown as IncomingMessage;
  const res = createMockServerResponse();
  await handleBrowserPairHttpRequest({
    req,
    res,
    action: "start",
    config: {},
    clientIp: "203.0.113.9",
  });
  expect(res.statusCode).toBe(403);
  expect(res.body).toBe(JSON.stringify({ error: "origin_not_allowed" }));
});
