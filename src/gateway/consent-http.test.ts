import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import { resetConsentGateResolverForTests, resolveConsentGateApi } from "../consent/resolve.js";

const TEST_GATEWAY_TOKEN = "test-gateway-token-1234567890";

let cfg: OpenClawConfig = {} as OpenClawConfig;

vi.mock("../config/config.js", () => ({
  loadConfig: () => cfg,
}));

vi.mock("./auth.js", () => ({
  authorizeGatewayConnect: async () => ({ ok: true }),
}));

const { handleConsentHttpRequest } = await import("./consent-http.js");

let sharedPort = 0;
let sharedServer: ReturnType<typeof createServer> | undefined;

beforeAll(async () => {
  sharedServer = createServer((req, res) => {
    void (async () => {
      const handled = await handleConsentHttpRequest(req, res, {
        auth: { mode: "token", token: TEST_GATEWAY_TOKEN, allowTailscale: false },
        trustedProxies: [],
      });
      if (handled) return;
      res.statusCode = 404;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ ok: false }));
    })();
  });
  await new Promise<void>((resolve) => sharedServer!.listen(0, "127.0.0.1", resolve));
  sharedPort = (sharedServer!.address() as AddressInfo).port;
});

afterAll(async () => {
  if (!sharedServer) return;
  await new Promise<void>((resolve) => sharedServer!.close(() => resolve()));
});

beforeEach(() => {
  resetConsentGateResolverForTests();
  cfg = {
    gateway: {
      consentGate: {
        enabled: true,
        observeOnly: false,
        gatedTools: ["exec", "write"],
      },
    },
  } as OpenClawConfig;
});

describe("consent http", () => {
  it("returns global token list when sessionKey is omitted", async () => {
    const api = resolveConsentGateApi(cfg);
    const token = await api.issue({
      tool: "exec",
      trustTier: "T0",
      sessionKey: "session-a",
      contextHash: "ctx-a",
      ttlMs: 60_000,
      issuedBy: "test",
      policyVersion: "1",
      tenantId: "tenant-a",
    });
    expect(token).not.toBeNull();

    const res = await fetch(`http://127.0.0.1:${sharedPort}/api/consent/status?limit=100`, {
      headers: { authorization: `Bearer ${TEST_GATEWAY_TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tokens: Array<{ jti: string }> };
    expect(body.tokens.some((t) => t.jti === token!.jti)).toBe(true);
  });

  it("revokes issued tokens by tenant across sessions", async () => {
    const api = resolveConsentGateApi(cfg);
    const t1 = await api.issue({
      tool: "exec",
      trustTier: "T0",
      sessionKey: "session-a",
      contextHash: "ctx-a",
      ttlMs: 60_000,
      issuedBy: "test",
      policyVersion: "1",
      tenantId: "tenant-a",
    });
    const t2 = await api.issue({
      tool: "write",
      trustTier: "T0",
      sessionKey: "session-b",
      contextHash: "ctx-b",
      ttlMs: 60_000,
      issuedBy: "test",
      policyVersion: "1",
      tenantId: "tenant-a",
    });
    const t3 = await api.issue({
      tool: "exec",
      trustTier: "T0",
      sessionKey: "session-c",
      contextHash: "ctx-c",
      ttlMs: 60_000,
      issuedBy: "test",
      policyVersion: "1",
      tenantId: "tenant-b",
    });
    expect(t1).not.toBeNull();
    expect(t2).not.toBeNull();
    expect(t3).not.toBeNull();

    const revokeRes = await fetch(`http://127.0.0.1:${sharedPort}/api/consent/revoke`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TEST_GATEWAY_TOKEN}`,
      },
      body: JSON.stringify({ tenantId: "tenant-a" }),
    });
    expect(revokeRes.status).toBe(200);
    const revoked = (await revokeRes.json()) as { revoked: number };
    expect(revoked.revoked).toBe(2);

    const statusTenantA = await fetch(
      `http://127.0.0.1:${sharedPort}/api/consent/status?tenantId=tenant-a&limit=100`,
      {
        headers: { authorization: `Bearer ${TEST_GATEWAY_TOKEN}` },
      },
    );
    const tenantA = (await statusTenantA.json()) as { tokens: Array<{ jti: string; status: string }> };
    const s1 = tenantA.tokens.find((t) => t.jti === t1!.jti)?.status;
    const s2 = tenantA.tokens.find((t) => t.jti === t2!.jti)?.status;
    expect(s1).toBe("revoked");
    expect(s2).toBe("revoked");
  });

  it("validates numeric query params for status", async () => {
    const res = await fetch(`http://127.0.0.1:${sharedPort}/api/consent/status?limit=abc`, {
      headers: { authorization: `Bearer ${TEST_GATEWAY_TOKEN}` },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { message?: string } };
    expect(body.error?.message).toContain("limit must be an integer");
  });
});

