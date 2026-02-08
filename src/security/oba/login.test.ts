import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loginOba, saveObaToken } from "./login.js";

// Valid format: oba_ + 64 hex chars
const VALID_TOKEN = `oba_${"a1b2c3d4".repeat(8)}`;

describe("loginOba", () => {
  it("returns token on valid callback with matching state", async () => {
    let capturedUrl = "";

    const result = await loginOba({
      apiUrl: "http://localhost:9999",
      timeoutMs: 5000,
      openBrowser: async (url) => {
        capturedUrl = url;
        // Simulate OBA redirecting to our callback
        const parsed = new URL(url);
        const port = parsed.searchParams.get("port");
        const state = parsed.searchParams.get("state");

        // Give the server a moment to be ready
        await new Promise((r) => setTimeout(r, 50));

        // Hit the callback with token + state
        await fetch(`http://127.0.0.1:${port}/callback?token=${VALID_TOKEN}&state=${state}`);
      },
      onProgress: () => {},
    });

    expect(result.ok).toBe(true);
    expect(result.token).toBe(VALID_TOKEN);
    expect(capturedUrl).toContain("/auth/cli?port=");
    expect(capturedUrl).toContain("&state=");
  });

  it("rejects callback with wrong state", async () => {
    const result = await loginOba({
      apiUrl: "http://localhost:9999",
      timeoutMs: 3000,
      openBrowser: async (url) => {
        const parsed = new URL(url);
        const port = parsed.searchParams.get("port");

        await new Promise((r) => setTimeout(r, 50));

        // Send callback with wrong state
        const res = await fetch(`http://127.0.0.1:${port}/callback?token=oba_test&state=wrong`);
        expect(res.status).toBe(400);
      },
      onProgress: () => {},
    });

    // Should time out since the wrong-state request was rejected
    expect(result.ok).toBe(false);
    expect(result.error).toBe("Login timed out");
  });

  it("rejects callback with missing token", async () => {
    const result = await loginOba({
      apiUrl: "http://localhost:9999",
      timeoutMs: 3000,
      openBrowser: async (url) => {
        const parsed = new URL(url);
        const port = parsed.searchParams.get("port");
        const state = parsed.searchParams.get("state");

        await new Promise((r) => setTimeout(r, 50));

        // Send callback without token
        const res = await fetch(`http://127.0.0.1:${port}/callback?state=${state}`);
        expect(res.status).toBe(400);
      },
      onProgress: () => {},
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("Login timed out");
  });

  it("rejects callback with invalid token format", async () => {
    const result = await loginOba({
      apiUrl: "http://localhost:9999",
      timeoutMs: 3000,
      openBrowser: async (url) => {
        const parsed = new URL(url);
        const port = parsed.searchParams.get("port");
        const state = parsed.searchParams.get("state");

        await new Promise((r) => setTimeout(r, 50));

        // Send callback with a token that doesn't match oba_[0-9a-f]{64}
        const res = await fetch(`http://127.0.0.1:${port}/callback?token=bad_token&state=${state}`);
        expect(res.status).toBe(400);
      },
      onProgress: () => {},
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("Login timed out");
  });

  it("returns error on timeout", async () => {
    const result = await loginOba({
      apiUrl: "http://localhost:9999",
      timeoutMs: 200, // very short timeout
      openBrowser: async () => {
        // Don't hit the callback — let it time out
      },
      onProgress: () => {},
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("Login timed out");
  });

  it("returns error from error query parameter", async () => {
    const result = await loginOba({
      apiUrl: "http://localhost:9999",
      timeoutMs: 5000,
      openBrowser: async (url) => {
        const parsed = new URL(url);
        const port = parsed.searchParams.get("port");
        const state = parsed.searchParams.get("state");

        await new Promise((r) => setTimeout(r, 50));

        await fetch(`http://127.0.0.1:${port}/callback?error=auth_failed&state=${state}`);
      },
      onProgress: () => {},
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("auth_failed");
  });

  it("rejects error callback without valid state", async () => {
    let fetchStatus = 0;

    const result = await loginOba({
      apiUrl: "http://localhost:9999",
      timeoutMs: 1000,
      openBrowser: async (url) => {
        const parsed = new URL(url);
        const port = parsed.searchParams.get("port");

        await new Promise((r) => setTimeout(r, 50));

        // Send error without valid state — should be rejected
        const res = await fetch(`http://127.0.0.1:${port}/callback?error=auth_failed`);
        fetchStatus = res.status;
      },
      onProgress: () => {},
    });

    expect(fetchStatus).toBe(400);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("Login timed out");
  });

  it("returns 404 for non-callback paths", async () => {
    let fetchStatus = 0;

    const result = await loginOba({
      apiUrl: "http://localhost:9999",
      timeoutMs: 1000,
      openBrowser: async (url) => {
        const parsed = new URL(url);
        const port = parsed.searchParams.get("port");

        await new Promise((r) => setTimeout(r, 50));

        const res = await fetch(`http://127.0.0.1:${port}/other-path`);
        fetchStatus = res.status;
      },
      onProgress: () => {},
    });

    expect(fetchStatus).toBe(404);
    expect(result.ok).toBe(false); // times out
  });
});

describe("saveObaToken", () => {
  let tmpDir: string;
  let origStateDir: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oba-login-test-"));
    origStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = tmpDir;
  });

  afterEach(() => {
    if (origStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = origStateDir;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes token file with correct content", () => {
    const tokenFile = saveObaToken("oba_testtoken123");
    expect(fs.existsSync(tokenFile)).toBe(true);
    expect(fs.readFileSync(tokenFile, "utf-8")).toBe("oba_testtoken123");
  });

  it("creates parent directories if needed", () => {
    const tokenFile = saveObaToken("oba_abc");
    expect(tokenFile).toContain("token");
    expect(fs.existsSync(tokenFile)).toBe(true);
  });

  it("overwrites existing token", () => {
    saveObaToken("oba_first");
    const tokenFile = saveObaToken("oba_second");
    expect(fs.readFileSync(tokenFile, "utf-8")).toBe("oba_second");
  });
});
