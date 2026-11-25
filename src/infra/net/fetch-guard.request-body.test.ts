import { expect, it, vi } from "vitest";
import { fetchWithSsrFGuard } from "./fetch-guard.js";

it("dispatches fresh bytes from an immutable Blob across redirects and retries", async () => {
  const payload = '{"message":"retained 🦞 request"}';
  const body = new Blob([payload], { type: "application/json" });
  const sent: Uint8Array[] = [];
  const statuses = [307, 429, 307, 200];
  const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    expect(init?.body).toBeInstanceOf(Uint8Array);
    if (!(init?.body instanceof Uint8Array)) {
      throw new Error("expected a byte body without a native Blob stream reader");
    }
    expect(new TextDecoder().decode(init.body)).toBe(payload);
    expect(sent).not.toContain(init.body);
    expect(new Headers(init.headers).get("content-length")).toBe(String(body.size));
    expect(new Headers(init.headers).get("content-type")).toBe(body.type);
    sent.push(init.body);
    init.body.fill(0);
    const status = statuses.shift()!;
    return new Response(null, {
      status,
      ...(status === 307 ? { headers: { location: "/next" } } : {}),
    });
  });

  for (const expectedStatus of [429, 200]) {
    const result = await fetchWithSsrFGuard({
      url: "https://public.example/start",
      fetchImpl,
      capture: false,
      init: { method: "POST", body },
    });
    try {
      expect(result.response.status).toBe(expectedStatus);
    } finally {
      await result.release();
    }
  }
  expect(fetchImpl).toHaveBeenCalledTimes(4);
  // This is the small, locally constructed Blob fixture, not a network Response.
  // nosemgrep: security.opengrep.ghsa-p536-vvpp-9mc8.openclaw.web-fetch-or-media-unbounded-response-read
  expect(await body.text()).toBe(payload);
});
