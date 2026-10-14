import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withFetchPreconnect } from "../test-utils/fetch-mock.js";
import { fetchJson, fetchUsageJson, readUsageJson } from "./provider-usage.fetch.shared.js";

describe("provider usage response lifecycle", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(["deadline", "caller"] as const)(
    "keeps %s cancellation active after headers",
    async (source) => {
      const deadline = new AbortController();
      const caller = new AbortController();
      vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
      const reason = new Error("cancelled while reading");
      const fetchFn = withFetchPreconnect(
        vi.fn(
          async (_input: URL | RequestInfo, init?: RequestInit) =>
            new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode("{"));
                  init?.signal?.addEventListener(
                    "abort",
                    () => controller.error(init.signal?.reason),
                    { once: true },
                  );
                },
              }),
            ),
        ),
      );
      const response = await fetchJson(
        "https://example.com/usage",
        { signal: caller.signal },
        1000,
        fetchFn,
      );
      const body = response.text();
      const rejected = expect(body).rejects.toBe(reason);
      (source === "deadline" ? deadline : caller).abort(reason);
      await rejected;
    },
  );

  it("caps oversized request timeouts before scheduling", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(new AbortController().signal);
    await fetchJson(
      "https://example.com/usage",
      {},
      MAX_TIMER_TIMEOUT_MS + 1_000_000,
      withFetchPreconnect(vi.fn(async () => new Response("{}"))),
    );
    expect(timeout).toHaveBeenCalledWith(MAX_TIMER_TIMEOUT_MS);
  });

  it("cancels non-OK bodies and reports configured token expiration", async () => {
    const response = Response.json({ error: "expired" }, { status: 403 });
    const cancel = vi.spyOn(response.body!, "cancel").mockResolvedValue(undefined);
    expect(
      await fetchUsageJson({
        provider: "openai",
        url: "https://example.com/usage",
        init: {},
        timeoutMs: 1000,
        fetchFn: withFetchPreconnect(vi.fn(async () => response)),
        tokenExpiredStatuses: [401, 403],
      }),
    ).toEqual({
      ok: false,
      snapshot: {
        provider: "openai",
        displayName: "OpenAI",
        windows: [],
        error: "Token expired",
      },
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("bounds response bytes and cancels an oversized stream", async () => {
    let pulls = 0;
    const cancel = vi.fn(async () => undefined);
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls += 1;
          controller.enqueue(new Uint8Array(pulls === 1 ? 16 * 1024 * 1024 + 1 : 1));
        },
        cancel,
      }),
    );
    expect(await readUsageJson("anthropic", response)).toEqual({
      ok: false,
      snapshot: expect.objectContaining({
        provider: "anthropic",
        error: "Malformed usage response",
      }),
    });
    expect(pulls).toBeLessThanOrEqual(2);
    expect(cancel).toHaveBeenCalledOnce();
  });
});
