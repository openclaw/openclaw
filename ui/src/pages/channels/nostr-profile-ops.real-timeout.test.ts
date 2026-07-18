import type { Server } from "node:http";
import { createServer } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { putNostrProfile, importNostrProfile } from "./nostr-profile-ops.js";

function installRelativeFetchBridge(serverUrl: string): () => void {
  const base = serverUrl.replace(/\/$/, "");
  const originalFetch = globalThis.fetch;
  const realFetch = originalFetch.bind(globalThis);
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const absolute = url.startsWith("http") ? url : `${base}${url}`;
    return realFetch(absolute, init);
  };
  return () => {
    globalThis.fetch = originalFetch;
  };
}

const HEADERS = { authorization: "Bearer test-token" };

describe("Nostr profile operations with real timeouts", () => {
  let server: Server;
  let serverUrl: string;
  let stall: boolean;
  let restoreFetch: () => void;

  beforeEach(async () => {
    stall = false;
    server = createServer((_req, res) => {
      if (stall) {
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, persisted: true }));
    });
    await new Promise<void>((resolve) => {
      server.listen(0, () => resolve());
    });
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    serverUrl = `http://127.0.0.1:${port}`;
    restoreFetch = installRelativeFetchBridge(serverUrl);
  });

  afterEach(() => {
    restoreFetch();
    server.close();
  });

  it("aborts a stalled putNostrProfile after the real 15s bound instead of hanging", async () => {
    stall = true;
    const startTime = Date.now();

    try {
      await putNostrProfile({
        accountId: "acct-1",
        headers: HEADERS,
        values: { name: "alice" },
      });
      throw new Error("Expected abort error but request completed");
    } catch (error) {
      const elapsed = Date.now() - startTime;
      console.log(`[REAL TIMEOUT] putNostrProfile aborted after ${elapsed}ms`);
      console.log(
        `[REAL TIMEOUT] Error type: ${error instanceof Error ? error.name : typeof error}`,
      );
      console.log(
        `[REAL TIMEOUT] Error message: ${error instanceof Error ? error.message : String(error)}`,
      );

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).name).toBe("AbortError");
      expect(elapsed).toBeGreaterThanOrEqual(14_000);
      expect(elapsed).toBeLessThanOrEqual(16_000);
    }
  }, 20_000);

  it("aborts a stalled importNostrProfile after the real 15s bound instead of hanging", async () => {
    stall = true;
    const startTime = Date.now();

    try {
      await importNostrProfile({ accountId: "acct-1", headers: HEADERS });
      throw new Error("Expected abort error but request completed");
    } catch (error) {
      const elapsed = Date.now() - startTime;
      console.log(`[REAL TIMEOUT] importNostrProfile aborted after ${elapsed}ms`);
      console.log(
        `[REAL TIMEOUT] Error type: ${error instanceof Error ? error.name : typeof error}`,
      );
      console.log(
        `[REAL TIMEOUT] Error message: ${error instanceof Error ? error.message : String(error)}`,
      );

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).name).toBe("AbortError");
      expect(elapsed).toBeGreaterThanOrEqual(14_000);
      expect(elapsed).toBeLessThanOrEqual(16_000);
    }
  }, 20_000);

  it("resolves a normal putNostrProfile round trip quickly", async () => {
    const startTime = Date.now();
    const { data, response } = await putNostrProfile({
      accountId: "acct-1",
      headers: HEADERS,
      values: { name: "alice" },
    });
    const elapsed = Date.now() - startTime;

    console.log(`[NORMAL] putNostrProfile completed in ${elapsed}ms`);
    expect(response.ok).toBe(true);
    expect(data?.persisted).toBe(true);
    expect(elapsed).toBeLessThan(1_000);
  });

  it("resolves a normal importNostrProfile round trip quickly", async () => {
    const startTime = Date.now();
    const { data, response } = await importNostrProfile({
      accountId: "acct-1",
      headers: HEADERS,
    });
    const elapsed = Date.now() - startTime;

    console.log(`[NORMAL] importNostrProfile completed in ${elapsed}ms`);
    expect(response.ok).toBe(true);
    expect(data?.persisted).toBe(true);
    expect(elapsed).toBeLessThan(1_000);
  });
});
