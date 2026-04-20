import { describe, expect, it } from "vitest";
import type { GatewayHttpCorsConfig } from "../config/types.gateway.js";
import {
  AUTH_NONE,
  AUTH_TOKEN,
  createRequest,
  createResponse,
  dispatchRequest,
  withGatewayServer,
} from "./server-http.test-harness.js";

function findHeader(setHeader: { mock: { calls: unknown[][] } }, name: string): string | undefined {
  const call = setHeader.mock.calls.find(
    ([n]: unknown[]) => typeof n === "string" && n.toLowerCase() === name.toLowerCase(),
  );
  return call ? String(call[1]) : undefined;
}

const CORS_ENABLED: GatewayHttpCorsConfig = {
  enabled: true,
  allowedOrigins: ["https://a.example"],
};

describe("gateway CORS HTTP integration", () => {
  it("no CORS headers when cors config is absent", async () => {
    await withGatewayServer({
      prefix: "cors-default",
      resolvedAuth: AUTH_NONE,
      overrides: { openAiChatCompletionsEnabled: true },
      run: async (server) => {
        const req = createRequest({
          method: "GET",
          path: "/v1/models",
          headers: { origin: "https://a.example" },
        });
        const { res, setHeader } = createResponse();
        await dispatchRequest(server, req, res);
        expect(findHeader(setHeader, "Access-Control-Allow-Origin")).toBeUndefined();
      },
    });
  });

  it("sets CORS headers when enabled and origin matches on GET /v1/models", async () => {
    await withGatewayServer({
      prefix: "cors-models",
      resolvedAuth: AUTH_NONE,
      overrides: {
        openAiChatCompletionsEnabled: true,
        corsConfig: CORS_ENABLED,
      },
      run: async (server) => {
        const req = createRequest({
          method: "GET",
          path: "/v1/models",
          headers: { origin: "https://a.example" },
        });
        const { res, setHeader } = createResponse();
        await dispatchRequest(server, req, res);
        expect(findHeader(setHeader, "Access-Control-Allow-Origin")).toBe("https://a.example");
        expect(findHeader(setHeader, "Vary")).toBe("Origin");
      },
    });
  });

  it("no CORS headers when origin does not match", async () => {
    await withGatewayServer({
      prefix: "cors-no-match",
      resolvedAuth: AUTH_NONE,
      overrides: {
        openAiChatCompletionsEnabled: true,
        corsConfig: CORS_ENABLED,
      },
      run: async (server) => {
        const req = createRequest({
          method: "GET",
          path: "/v1/models",
          headers: { origin: "https://b.example" },
        });
        const { res, setHeader } = createResponse();
        await dispatchRequest(server, req, res);
        expect(findHeader(setHeader, "Access-Control-Allow-Origin")).toBeUndefined();
        // Vary: Origin must still be present so intermediate caches partition
        // by origin even when the origin fails the allowlist.
        expect(findHeader(setHeader, "Vary")).toBe("Origin");
      },
    });
  });

  it("OPTIONS preflight returns 204 with full headers", async () => {
    await withGatewayServer({
      prefix: "cors-preflight",
      resolvedAuth: AUTH_NONE,
      overrides: {
        openAiChatCompletionsEnabled: true,
        corsConfig: CORS_ENABLED,
      },
      run: async (server) => {
        const req = createRequest({
          method: "OPTIONS",
          path: "/v1/chat/completions",
          headers: {
            origin: "https://a.example",
            "access-control-request-method": "POST",
          },
        });
        const { res, setHeader, end } = createResponse();
        await dispatchRequest(server, req, res);
        expect(res.statusCode).toBe(204);
        expect(end).toHaveBeenCalled();
        expect(findHeader(setHeader, "Access-Control-Allow-Origin")).toBe("https://a.example");
        expect(findHeader(setHeader, "Access-Control-Allow-Methods")).toBe("POST, OPTIONS");
        expect(findHeader(setHeader, "Access-Control-Allow-Headers")).toContain("Authorization");
        expect(findHeader(setHeader, "Access-Control-Max-Age")).toBe("600");
        expect(findHeader(setHeader, "Vary")).toBe("Origin");
      },
    });
  });

  it("wildcard returns Access-Control-Allow-Origin: *", async () => {
    await withGatewayServer({
      prefix: "cors-wildcard",
      resolvedAuth: AUTH_NONE,
      overrides: {
        openAiChatCompletionsEnabled: true,
        corsConfig: { enabled: true, allowedOrigins: ["*"] },
      },
      run: async (server) => {
        const req = createRequest({
          method: "GET",
          path: "/v1/models",
          headers: { origin: "https://any.site" },
        });
        const { res, setHeader } = createResponse();
        await dispatchRequest(server, req, res);
        expect(findHeader(setHeader, "Access-Control-Allow-Origin")).toBe("*");
        expect(findHeader(setHeader, "Access-Control-Allow-Credentials")).toBeUndefined();
      },
    });
  });

  it("no CORS headers on non-covered path", async () => {
    await withGatewayServer({
      prefix: "cors-uncovered",
      resolvedAuth: AUTH_NONE,
      overrides: {
        corsConfig: CORS_ENABLED,
      },
      run: async (server) => {
        const req = createRequest({
          method: "GET",
          path: "/ready",
          headers: { origin: "https://a.example" },
        });
        const { res, setHeader } = createResponse();
        await dispatchRequest(server, req, res);
        expect(findHeader(setHeader, "Access-Control-Allow-Origin")).toBeUndefined();
      },
    });
  });

  it("auth still enforced: 401 with CORS headers present", async () => {
    await withGatewayServer({
      prefix: "cors-auth",
      resolvedAuth: AUTH_TOKEN,
      overrides: {
        openAiChatCompletionsEnabled: true,
        corsConfig: CORS_ENABLED,
      },
      run: async (server) => {
        const req = createRequest({
          method: "GET",
          path: "/v1/models",
          headers: { origin: "https://a.example" },
        });
        const { res, setHeader } = createResponse();
        await dispatchRequest(server, req, res);
        // Auth should reject (no token) but CORS headers should still be present
        expect(res.statusCode).toBe(401);
        expect(findHeader(setHeader, "Access-Control-Allow-Origin")).toBe("https://a.example");
      },
    });
  });
});
