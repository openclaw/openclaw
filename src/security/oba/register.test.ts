import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerKey } from "./register.js";

function makeTestPem(): string {
  const { publicKey } = crypto.generateKeyPairSync("ed25519");
  return publicKey.export({ type: "spki", format: "pem" }).toString();
}

function mockFetchSequence(...responses: Array<{ status: number; body: unknown; ok?: boolean }>) {
  const fn = vi.fn();
  for (const r of responses) {
    fn.mockResolvedValueOnce(
      new Response(JSON.stringify(r.body), {
        status: r.status,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

describe("registerKey", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("registers a key and returns owner URL with username", async () => {
    const pem = makeTestPem();
    mockFetchSequence(
      { status: 200, body: { user: { id: "u1" }, profile: { username: "testuser" } } },
      { status: 201, body: { success: true } },
    );

    const result = await registerKey({
      publicKeyPem: pem,
      token: "oba_" + "a".repeat(64),
      apiUrl: "https://api.openbotauth.org",
    });

    expect(result.ok).toBe(true);
    expect(result.username).toBe("testuser");
    expect(result.ownerUrl).toBe("https://api.openbotauth.org/jwks/testuser.json");
  });

  it("passes is_update flag to POST /keys", async () => {
    const pem = makeTestPem();
    const fn = mockFetchSequence(
      { status: 200, body: { profile: { username: "user1" } } },
      { status: 200, body: { success: true } },
    );

    await registerKey({
      publicKeyPem: pem,
      isUpdate: true,
      token: "oba_" + "b".repeat(64),
      apiUrl: "https://api.openbotauth.org",
    });

    // Verify POST /keys body contains is_update: true.
    const postCall = fn.mock.calls[1];
    const body = JSON.parse(postCall[1].body as string);
    expect(body.is_update).toBe(true);
    expect(body.public_key).toBeTruthy();
  });

  it("returns error when session fetch returns 401", async () => {
    const pem = makeTestPem();
    mockFetchSequence({ status: 401, body: { error: "Unauthorized" } });

    const result = await registerKey({
      publicKeyPem: pem,
      token: "oba_bad",
      apiUrl: "https://api.openbotauth.org",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("authentication failed");
  });

  it("returns error when session fetch returns 500", async () => {
    const pem = makeTestPem();
    mockFetchSequence({ status: 500, body: { error: "Internal Server Error" } });

    const result = await registerKey({
      publicKeyPem: pem,
      token: "oba_" + "c".repeat(64),
      apiUrl: "https://api.openbotauth.org",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("session fetch failed");
  });

  it("returns error when profile has no username", async () => {
    const pem = makeTestPem();
    mockFetchSequence({ status: 200, body: { user: { id: "u1" }, profile: {} } });

    const result = await registerKey({
      publicKeyPem: pem,
      token: "oba_" + "d".repeat(64),
      apiUrl: "https://api.openbotauth.org",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("no username");
  });

  it("rejects username with path traversal characters", async () => {
    const pem = makeTestPem();
    mockFetchSequence({
      status: 200,
      body: { profile: { username: "../../admin" } },
    });

    const result = await registerKey({
      publicKeyPem: pem,
      token: "oba_" + "e".repeat(64),
      apiUrl: "https://api.openbotauth.org",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("invalid username format");
  });

  it("rejects username with URL metacharacters", async () => {
    const pem = makeTestPem();
    mockFetchSequence({
      status: 200,
      body: { profile: { username: "user?q=evil" } },
    });

    const result = await registerKey({
      publicKeyPem: pem,
      token: "oba_" + "f".repeat(64),
      apiUrl: "https://api.openbotauth.org",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("invalid username format");
  });

  it("returns error when key upload returns 403", async () => {
    const pem = makeTestPem();
    mockFetchSequence(
      { status: 200, body: { profile: { username: "testuser" } } },
      { status: 403, body: { error: "Forbidden" } },
    );

    const result = await registerKey({
      publicKeyPem: pem,
      token: "oba_" + "g".repeat(64),
      apiUrl: "https://api.openbotauth.org",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("authentication failed");
  });

  it("returns error when key upload returns 500", async () => {
    const pem = makeTestPem();
    mockFetchSequence(
      { status: 200, body: { profile: { username: "testuser" } } },
      { status: 500, body: { error: "server error" } },
    );

    const result = await registerKey({
      publicKeyPem: pem,
      token: "oba_" + "h".repeat(64),
      apiUrl: "https://api.openbotauth.org",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("key registration failed");
  });

  it("returns error when session fetch throws (network error)", async () => {
    const pem = makeTestPem();
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new Error("network error")) as unknown as typeof fetch;

    const result = await registerKey({
      publicKeyPem: pem,
      token: "oba_" + "i".repeat(64),
      apiUrl: "https://api.openbotauth.org",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("session fetch failed");
    expect(result.error).toContain("network error");
  });

  it("strips trailing slashes from apiUrl", async () => {
    const pem = makeTestPem();
    const fn = mockFetchSequence(
      { status: 200, body: { profile: { username: "testuser" } } },
      { status: 201, body: { success: true } },
    );

    const result = await registerKey({
      publicKeyPem: pem,
      token: "oba_" + "j".repeat(64),
      apiUrl: "https://api.openbotauth.org///",
    });

    expect(result.ok).toBe(true);
    expect(result.ownerUrl).toBe("https://api.openbotauth.org/jwks/testuser.json");
    // Verify session URL doesn't have double slashes.
    expect(fn.mock.calls[0][0]).toBe("https://api.openbotauth.org/auth/session");
  });

  it("sends Bearer token in Authorization header", async () => {
    const pem = makeTestPem();
    const token = "oba_" + "k".repeat(64);
    const fn = mockFetchSequence(
      { status: 200, body: { profile: { username: "testuser" } } },
      { status: 201, body: { success: true } },
    );

    await registerKey({ publicKeyPem: pem, token, apiUrl: "https://api.openbotauth.org" });

    // Both calls should have Bearer auth.
    expect(fn.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${token}`);
    expect(fn.mock.calls[1][1].headers.Authorization).toBe(`Bearer ${token}`);
  });
});
