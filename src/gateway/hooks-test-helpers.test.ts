import { describe, expect, test } from "vitest";
import { createGatewayRequest } from "./hooks-test-helpers.js";

describe("createGatewayRequest", () => {
  test("preserves custom headers and applies explicit authorization last", () => {
    const req = createGatewayRequest({
      path: "/hooks/wake",
      headers: {
        authorization: "Bearer header-token",
        "content-type": "application/json",
      },
      authorization: "Bearer explicit-token",
    });

    expect(req.headers.authorization).toBe("Bearer explicit-token");
    expect(req.headers["content-type"]).toBe("application/json");
  });
});
