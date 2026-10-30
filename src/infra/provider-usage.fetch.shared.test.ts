import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, expect, it, vi } from "vitest";
import { withFetchPreconnect } from "../test-utils/fetch-mock.js";
import { fetchJson, fetchUsageJson, readUsageJson } from "./provider-usage.fetch.shared.js";

const url = "https://example.com/usage";
const responseFetch = (response: Response) => withFetchPreconnect(async () => response);
const streamResponse = (source: UnderlyingSource<Uint8Array>) =>
  new Response(new ReadableStream<Uint8Array>(source));
const request = (fetchFn: typeof fetch, init: RequestInit = {}, timeout = 1000) =>
  fetchJson(url, init, timeout, fetchFn);

afterEach(() => vi.restoreAllMocks());

it.each(["deadline", "caller"] as const)("keeps %s cancellation after headers", async (source) => {
  const deadline = new AbortController();
  const caller = new AbortController();
  vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
  const reason = new Error("cancelled while reading");
  const fetchFn = withFetchPreconnect(
    async (_input: URL | RequestInfo, { signal }: RequestInit = {}) =>
      streamResponse({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("{"));
          signal?.addEventListener("abort", () => controller.error(signal.reason), {
            once: true,
          });
        },
      }),
  );
  const response = await request(fetchFn, { signal: caller.signal });
  const rejected = expect(response.text()).rejects.toBe(reason);
  (source === "deadline" ? deadline : caller).abort(reason);
  await rejected;
});

it("caps oversized request timeouts before scheduling", async () => {
  const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(new AbortController().signal);
  await request(responseFetch(new Response("{}")), {}, MAX_TIMER_TIMEOUT_MS + 1_000_000);
  expect(timeout).toHaveBeenCalledWith(MAX_TIMER_TIMEOUT_MS);
});

it("cancels non-OK bodies and reports configured token expiration", async () => {
  const response = new Response("unread", { status: 403 });
  const cancel = vi.spyOn(response.body!, "cancel").mockResolvedValue(undefined);
  const result = await fetchUsageJson({
    provider: "openai",
    url,
    init: {},
    timeoutMs: 1000,
    fetchFn: responseFetch(response),
    tokenExpiredStatuses: [401, 403],
  });
  expect(result).toEqual({
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
  const response = streamResponse({
    pull(controller) {
      pulls += 1;
      controller.enqueue(new Uint8Array(pulls === 1 ? 16 * 1024 * 1024 + 1 : 1));
    },
    cancel,
  });
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
