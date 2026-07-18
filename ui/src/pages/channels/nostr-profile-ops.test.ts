import type { Server } from "node:http";
import { createServer } from "node:http";
import process from "node:process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { putNostrProfile, importNostrProfile } from "./nostr-profile-ops.js";

function installRelativeFetchBridge(serverUrl: string): void {
  const base = serverUrl.replace(/\/$/, "");
  const realFetch = globalThis.fetch.bind(globalThis);
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const absolute = url.startsWith("http") ? url : `${base}${url}`;
    return realFetch(absolute, init);
  });
}

const HEADERS = { authorization: "Bearer test-token" };

describe("Nostr profile operations", () => {
  let server: Server;
  let serverUrl: string;
  let stall: boolean;

  let onUnhandled: (reason: unknown) => void;

  beforeEach(async () => {
    stall = false;
    onUnhandled = (reason: unknown) => {
      if (reason instanceof Error && reason.name === "AbortError") {
        return;
      }
      process.emit("uncaughtExceptionMonitor", reason as Error);
    };
    process.on("unhandledRejection", onUnhandled);
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
    installRelativeFetchBridge(serverUrl);
    vi.useFakeTimers();
  });

  afterEach(() => {
    process.off("unhandledRejection", onUnhandled);
    vi.useRealTimers();
    vi.unstubAllGlobals();
    server.close();
  });

  it("aborts a stalled putNostrProfile after the bound instead of hanging", async () => {
    stall = true;
    const call = putNostrProfile({
      accountId: "acct-1",
      headers: HEADERS,
      values: { name: "alice" },
    });
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(call).rejects.toThrow();
  });

  it("aborts a stalled importNostrProfile after the bound instead of hanging", async () => {
    stall = true;
    const call = importNostrProfile({ accountId: "acct-1", headers: HEADERS });
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(call).rejects.toThrow();
  });

  it("still resolves a normal putNostrProfile round trip", async () => {
    vi.useRealTimers();
    const { data, response } = await putNostrProfile({
      accountId: "acct-1",
      headers: HEADERS,
      values: { name: "alice" },
    });
    expect(response.ok).toBe(true);
    expect(data?.persisted).toBe(true);
    vi.useFakeTimers();
  });

  it("still resolves a normal importNostrProfile round trip", async () => {
    vi.useRealTimers();
    const { data, response } = await importNostrProfile({
      accountId: "acct-1",
      headers: HEADERS,
    });
    expect(response.ok).toBe(true);
    expect(data?.persisted).toBe(true);
    vi.useFakeTimers();
  });

  it("aborts putNostrProfile when headers received but body stalls", async () => {
    const headersOnlyServer = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
    });
    await new Promise<void>((resolve) => {
      headersOnlyServer.listen(0, resolve);
    });
    const address = headersOnlyServer.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const headersOnlyServerUrl = `http://127.0.0.1:${port}`;
    installRelativeFetchBridge(headersOnlyServerUrl);

    const call = putNostrProfile({
      accountId: "acct-1",
      headers: HEADERS,
      values: { name: "alice" },
    });
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(call).rejects.toThrow();
    headersOnlyServer.close();
  });

  it("aborts importNostrProfile when headers received but body stalls", async () => {
    const headersOnlyServer = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
    });
    await new Promise<void>((resolve) => {
      headersOnlyServer.listen(0, resolve);
    });
    const address = headersOnlyServer.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const headersOnlyServerUrl = `http://127.0.0.1:${port}`;
    installRelativeFetchBridge(headersOnlyServerUrl);

    const call = importNostrProfile({ accountId: "acct-1", headers: HEADERS });
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(call).rejects.toThrow();
    headersOnlyServer.close();
  });
});
