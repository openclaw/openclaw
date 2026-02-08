import { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { handleControlUiHttpRequest } from "./control-ui.js";

function createMockRequest(method: string, url: string): IncomingMessage {
  return {
    method,
    url,
    headers: { host: "localhost" },
  } as IncomingMessage;
}

describe("handleControlUiHttpRequest", () => {
  it("skips /api paths when the Control UI is served at root", () => {
    const req = createMockRequest("GET", "/api/health");
    const res = new ServerResponse(req);
    const handled = handleControlUiHttpRequest(req, res, { basePath: "" });
    expect(handled).toBe(false);
  });

  it("skips /api paths when nested under a Control UI base path", () => {
    const req = createMockRequest("GET", "/openclaw/api/health");
    const res = new ServerResponse(req);
    const handled = handleControlUiHttpRequest(req, res, { basePath: "/openclaw" });
    expect(handled).toBe(false);
  });
});
