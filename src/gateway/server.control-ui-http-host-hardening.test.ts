import { describe, expect, test } from "vitest";
import { AUTH_NONE, createTestGatewayServer, sendRequest } from "./server-http.test-harness.js";
import { withTempConfig } from "./test-temp-config.js";

describe("gateway control ui HTTP host hardening", () => {
  test("rejects root-mounted control ui requests when Host is outside allowedOrigins", async () => {
    await withTempConfig({
      cfg: {
        gateway: {
          trustedProxies: [],
          controlUi: {
            allowedOrigins: ["https://control.example.com"],
          },
        },
      },
      prefix: "openclaw-control-ui-http-host-reject-",
      run: async () => {
        const server = createTestGatewayServer({
          resolvedAuth: AUTH_NONE,
          overrides: {
            controlUiEnabled: true,
            controlUiBasePath: "",
            controlUiRoot: { kind: "missing" },
          },
        });

        const response = await sendRequest(server, {
          path: "/chat",
          host: "evil.example",
        });
        expect(response.res.statusCode).toBe(403);
        expect(response.getBody()).toBe("Forbidden");
      },
    });
  });

  test("allows root-mounted control ui requests when Host matches allowedOrigins", async () => {
    await withTempConfig({
      cfg: {
        gateway: {
          trustedProxies: [],
          controlUi: {
            allowedOrigins: ["https://control.example.com"],
          },
        },
      },
      prefix: "openclaw-control-ui-http-host-allow-",
      run: async () => {
        const server = createTestGatewayServer({
          resolvedAuth: AUTH_NONE,
          overrides: {
            controlUiEnabled: true,
            controlUiBasePath: "",
            controlUiRoot: { kind: "missing" },
          },
        });

        const response = await sendRequest(server, {
          path: "/chat",
          host: "control.example.com",
        });
        expect(response.res.statusCode).toBe(503);
        expect(response.getBody()).toContain("Control UI assets not found");
      },
    });
  });

  test("preserves loopback access without configured allowedOrigins", async () => {
    await withTempConfig({
      cfg: {
        gateway: {
          trustedProxies: [],
        },
      },
      prefix: "openclaw-control-ui-http-host-loopback-",
      run: async () => {
        const server = createTestGatewayServer({
          resolvedAuth: AUTH_NONE,
          overrides: {
            controlUiEnabled: true,
            controlUiBasePath: "",
            controlUiRoot: { kind: "missing" },
          },
        });

        const response = await sendRequest(server, {
          path: "/chat",
          host: "127.0.0.1:18789",
        });
        expect(response.res.statusCode).toBe(503);
        expect(response.getBody()).toContain("Control UI assets not found");
      },
    });
  });

  test("rejects non-loopback control ui requests without configured allowedOrigins", async () => {
    await withTempConfig({
      cfg: {
        gateway: {
          trustedProxies: [],
        },
      },
      prefix: "openclaw-control-ui-http-host-no-allowlist-reject-",
      run: async () => {
        const server = createTestGatewayServer({
          resolvedAuth: AUTH_NONE,
          overrides: {
            controlUiEnabled: true,
            controlUiBasePath: "",
            controlUiRoot: { kind: "missing" },
          },
        });

        const response = await sendRequest(server, {
          path: "/chat",
          host: "gateway.example.com:18789",
        });
        expect(response.res.statusCode).toBe(403);
        expect(response.getBody()).toBe("Forbidden");
      },
    });
  });
});
