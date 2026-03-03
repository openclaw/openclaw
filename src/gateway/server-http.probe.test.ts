import { describe, expect, it } from "vitest";
import {
  AUTH_NONE,
  createRequest,
  createResponse,
  dispatchRequest,
  withGatewayServer,
} from "./server-http.test-harness.js";
import type { ReadinessChecker } from "./server/readiness.js";

describe("gateway probe endpoints — /ready with readiness checker", () => {
  it("returns 200 when getReadiness reports ready", async () => {
    const getReadiness: ReadinessChecker = () => ({
      ready: true,
      failing: [],
      uptimeMs: 45_000,
    });

    await withGatewayServer({
      prefix: "probe-ready",
      resolvedAuth: AUTH_NONE,
      overrides: { getReadiness },
      run: async (server) => {
        const req = createRequest({ path: "/ready" });
        const { res, getBody } = createResponse();
        await dispatchRequest(server, req, res);

        expect(res.statusCode).toBe(200);
        expect(JSON.parse(getBody())).toMatchObject({ ready: true, uptimeMs: 45_000 });
      },
    });
  });

  it("returns 503 when getReadiness reports not ready", async () => {
    const getReadiness: ReadinessChecker = () => ({
      ready: false,
      failing: ["discord", "telegram"],
      uptimeMs: 8_000,
    });

    await withGatewayServer({
      prefix: "probe-not-ready",
      resolvedAuth: AUTH_NONE,
      overrides: { getReadiness },
      run: async (server) => {
        const req = createRequest({ path: "/ready" });
        const { res, getBody } = createResponse();
        await dispatchRequest(server, req, res);

        expect(res.statusCode).toBe(503);
        expect(JSON.parse(getBody())).toMatchObject({
          ready: false,
          failing: ["discord", "telegram"],
        });
      },
    });
  });

  it("returns 503 when getReadiness throws", async () => {
    const getReadiness: ReadinessChecker = () => {
      throw new Error("boom");
    };

    await withGatewayServer({
      prefix: "probe-throws",
      resolvedAuth: AUTH_NONE,
      overrides: { getReadiness },
      run: async (server) => {
        const req = createRequest({ path: "/ready" });
        const { res, getBody } = createResponse();
        await dispatchRequest(server, req, res);

        expect(res.statusCode).toBe(503);
        expect(JSON.parse(getBody())).toEqual({ ready: false, failing: ["internal"], uptimeMs: 0 });
      },
    });
  });

  it("returns 200 for /readyz when ready", async () => {
    const getReadiness: ReadinessChecker = () => ({ ready: true, failing: [], uptimeMs: 1_000 });

    await withGatewayServer({
      prefix: "probe-readyz",
      resolvedAuth: AUTH_NONE,
      overrides: { getReadiness },
      run: async (server) => {
        const req = createRequest({ path: "/readyz" });
        const { res } = createResponse();
        await dispatchRequest(server, req, res);
        expect(res.statusCode).toBe(200);
      },
    });
  });

  it("/healthz is unaffected — always 200 regardless of getReadiness", async () => {
    const getReadiness: ReadinessChecker = () => ({
      ready: false,
      failing: ["discord"],
      uptimeMs: 999,
    });

    await withGatewayServer({
      prefix: "probe-healthz-unaffected",
      resolvedAuth: AUTH_NONE,
      overrides: { getReadiness },
      run: async (server) => {
        const req = createRequest({ path: "/healthz" });
        const { res } = createResponse();
        await dispatchRequest(server, req, res);
        expect(res.statusCode).toBe(200);
      },
    });
  });

  it("no auth required — returns real readiness response without credentials", async () => {
    const getReadiness: ReadinessChecker = () => ({ ready: true, failing: [], uptimeMs: 1_000 });

    await withGatewayServer({
      prefix: "probe-no-auth",
      resolvedAuth: { mode: "token", token: "secret", password: undefined, allowTailscale: false },
      overrides: { getReadiness },
      run: async (server) => {
        const req = createRequest({ path: "/ready" });
        const { res } = createResponse();
        await dispatchRequest(server, req, res);
        expect(res.statusCode).toBe(200);
      },
    });
  });

  it("returns 503 for /readyz when not ready", async () => {
    const getReadiness: ReadinessChecker = () => ({
      ready: false,
      failing: ["telegram"],
      uptimeMs: 5_000,
    });

    await withGatewayServer({
      prefix: "probe-readyz-not-ready",
      resolvedAuth: AUTH_NONE,
      overrides: { getReadiness },
      run: async (server) => {
        const req = createRequest({ path: "/readyz" });
        const { res } = createResponse();
        await dispatchRequest(server, req, res);
        expect(res.statusCode).toBe(503);
      },
    });
  });

  it("HEAD /ready returns 200 when ready", async () => {
    const getReadiness: ReadinessChecker = () => ({ ready: true, failing: [], uptimeMs: 1_000 });

    await withGatewayServer({
      prefix: "probe-head-ready",
      resolvedAuth: AUTH_NONE,
      overrides: { getReadiness },
      run: async (server) => {
        const req = createRequest({ path: "/ready", method: "HEAD" });
        const { res, getBody } = createResponse();
        await dispatchRequest(server, req, res);
        expect(res.statusCode).toBe(200);
        expect(getBody()).toBe("");
      },
    });
  });

  it("HEAD /ready returns 503 when not ready", async () => {
    const getReadiness: ReadinessChecker = () => ({
      ready: false,
      failing: ["discord"],
      uptimeMs: 200_000,
    });

    await withGatewayServer({
      prefix: "probe-head-not-ready",
      resolvedAuth: AUTH_NONE,
      overrides: { getReadiness },
      run: async (server) => {
        const req = createRequest({ path: "/ready", method: "HEAD" });
        const { res, getBody } = createResponse();
        await dispatchRequest(server, req, res);
        expect(res.statusCode).toBe(503);
        expect(getBody()).toBe("");
      },
    });
  });
});
