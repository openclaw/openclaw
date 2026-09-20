import { createServer } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { assertUiE2ePreflight } from "./vitest/vitest.ui-e2e-preflight.ts";

async function expectPortReleased(url: Parameters<typeof fetch>[0] | undefined) {
  if (typeof url !== "string") {
    throw new Error("Expected the preflight to fetch a string URL");
  }
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(Number(new URL(url).port), "127.0.0.1", resolve);
  });
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

describe("UI E2E environment preflight", () => {
  it("proves the owned HTTP response and releases its listener", async () => {
    const fetchImpl = vi.fn<typeof fetch>(fetch);
    await assertUiE2ePreflight({ fetchImpl });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    await expectPortReleased(fetchImpl.mock.calls[0]?.[0]);
  });

  it("reports proxy HTTP failures without exposing remote content", async () => {
    const secret = "synthetic-private-proxy-details";
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Response(secret, { status: 502, headers: { "x-private-proxy": secret } }),
    );
    const failure = await assertUiE2ePreflight({ fetchImpl }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toContain("UI E2E loopback HTTP preflight received HTTP 502");
    expect(String(failure)).not.toContain(secret);
    expect(String(failure)).toContain("do not disable its proxy policy");
    await expectPortReleased(fetchImpl.mock.calls[0]?.[0]);
  });

  it("rejects a successful status from a different endpoint", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    await expect(assertUiE2ePreflight({ fetchImpl })).rejects.toThrow(
      "instead of the owned response",
    );
    await expectPortReleased(fetchImpl.mock.calls[0]?.[0]);
  });

  it("aborts a stalled request and releases its listener before reporting the deadline", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) {
            throw new Error("Expected owned abort signal");
          }
          if (signal.aborted) {
            reject(new Error("synthetic-private-timeout"));
            return;
          }
          signal.addEventListener("abort", () => reject(new Error("synthetic-private-timeout")), {
            once: true,
          });
        }),
    );
    await expect(assertUiE2ePreflight({ fetchImpl, timeoutMs: 50 })).rejects.toThrow(
      "loopback HTTP preflight timed out",
    );
    expect(fetchImpl.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    await expectPortReleased(fetchImpl.mock.calls[0]?.[0]);
  });
});
