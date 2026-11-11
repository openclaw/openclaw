import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runOpenAIOAuthTlsPreflight } from "../plugins/provider-openai-chatgpt-oauth-tls.js";

describe("runOpenAIOAuthTlsPreflight", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns ok when OpenAI auth endpoint is reachable", async () => {
    const response = new Response("reachable", { status: 400 });
    const cancel = vi.spyOn(response.body!, "cancel").mockResolvedValue(undefined);
    const fetchImpl = vi.fn(async () => response) as unknown as typeof fetch;
    const result = await runOpenAIOAuthTlsPreflight({ fetchImpl, timeoutMs: 20 });
    expect(result).toEqual({ ok: true });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("caps oversized probe timeouts before creating abort signals", async () => {
    const timeoutController = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutController.signal);
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.signal).toBe(timeoutController.signal);
      return new Response("", { status: 400 });
    }) as unknown as typeof fetch;

    const result = await runOpenAIOAuthTlsPreflight({
      fetchImpl,
      timeoutMs: Number.MAX_SAFE_INTEGER,
    });

    expect(result).toEqual({ ok: true });
    expect(timeoutSpy).toHaveBeenCalledWith(MAX_TIMER_TIMEOUT_MS);
  });

  it("classifies a deeply wrapped hostname mismatch", async () => {
    const tlsFetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed", {
        cause: {
          cause: {
            code: "ERR_TLS_CERT_ALTNAME_INVALID",
            message: "Hostname/IP does not match certificate's altnames",
          },
        },
      });
    }) as unknown as typeof fetch;
    await expect(
      runOpenAIOAuthTlsPreflight({ fetchImpl: tlsFetchImpl, timeoutMs: 20 }),
    ).resolves.toEqual({
      ok: false,
      kind: "tls-cert",
      code: "ERR_TLS_CERT_ALTNAME_INVALID",
      message: "Hostname/IP does not match certificate's altnames",
    });
  });

  it("keeps generic TLS transport failures in network classification", async () => {
    const networkFetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed", {
        cause: new Error(
          "Client network socket disconnected before secure TLS connection was established",
        ),
      });
    }) as unknown as typeof fetch;
    const result = await runOpenAIOAuthTlsPreflight({
      fetchImpl: networkFetchImpl,
      timeoutMs: 20,
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected network preflight failure");
    }
    expect(result.kind).toBe("network");
  });
});
