// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { RealtimeTalkWebRtcOfferExchange } from "./webrtc-support.ts";

const OPENAI_REALTIME_SDP_ANSWER_MAX_BYTES = 256 * 1024;

function readAnswer(
  exchange: RealtimeTalkWebRtcOfferExchange,
  isCurrent = () => true,
  offerResponseMaxBytes: number | null = OPENAI_REALTIME_SDP_ANSWER_MAX_BYTES,
  provider = "openai",
) {
  return exchange.readAnswer({
    session: {
      provider,
      transport: "webrtc",
      clientSecret: "reservation-token",
      offerUrl: "https://gateway.example.test/realtime/calls",
      ...(offerResponseMaxBytes === null ? {} : { offerResponseMaxBytes }),
    },
    offer: { type: "offer", sdp: "offer-sdp" },
    gatewayUrl: "wss://gateway.example.test/control",
    isCurrent,
  });
}

describe("RealtimeTalkWebRtcOfferExchange", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resolves relative offer routes against the connected Gateway", async () => {
    const fetchMock = vi.fn(async () => new Response("answer-sdp"));
    vi.stubGlobal("fetch", fetchMock);
    const exchange = new RealtimeTalkWebRtcOfferExchange();

    await exchange.readAnswer({
      session: {
        provider: "openai",
        transport: "webrtc",
        clientSecret: "reservation-token",
        offerUrl: "/plugins/codex/realtime/calls",
      },
      offer: { type: "offer", sdp: "offer-sdp" },
      gatewayUrl: "wss://gateway.example.test/control?tenant=a",
      isCurrent: () => true,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://gateway.example.test/plugins/codex/realtime/calls",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/sdp",
          "X-OpenClaw-Realtime-Token": "reservation-token",
        },
      }),
    );
  });

  it("keeps Authorization free when a gateway offer also carries provider headers", async () => {
    const fetchMock = vi.fn(async () => new Response("answer-sdp"));
    vi.stubGlobal("fetch", fetchMock);
    const exchange = new RealtimeTalkWebRtcOfferExchange();

    await exchange.readAnswer({
      session: {
        provider: "openai",
        transport: "webrtc",
        clientSecret: "reservation-token",
        offerUrl: "https://gateway.example.test/realtime/calls",
        offerHeaders: {
          Authorization: "Bearer should-not-be-sent",
          "X-Trace": "1",
        },
      },
      offer: { type: "offer", sdp: "offer-sdp" },
      gatewayUrl: "wss://gateway.example.test/control",
      isCurrent: () => true,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://gateway.example.test/realtime/calls",
      expect.objectContaining({
        credentials: "include",
        headers: {
          "X-Trace": "1",
          "Content-Type": "application/sdp",
          "X-OpenClaw-Realtime-Token": "reservation-token",
        },
      }),
    );
  });

  it("sends the provider bearer token on a direct realtime offer", async () => {
    const fetchMock = vi.fn(async () => new Response("answer-sdp"));
    vi.stubGlobal("fetch", fetchMock);
    const exchange = new RealtimeTalkWebRtcOfferExchange();

    await exchange.readAnswer({
      session: {
        provider: "openai",
        transport: "webrtc",
        clientSecret: "reservation-token",
        offerUrl: "https://api.openai.com/v1/realtime/calls",
        offerHeaders: { "OpenAI-Beta": "realtime=v1" },
      },
      offer: { type: "offer", sdp: "offer-sdp" },
      gatewayUrl: "wss://gateway.example.test/control",
      isCurrent: () => true,
    });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(fetchMock).toHaveBeenCalledWith("https://api.openai.com/v1/realtime/calls", {
      method: "POST",
      body: "offer-sdp",
      headers: {
        "OpenAI-Beta": "realtime=v1",
        "Content-Type": "application/sdp",
        Authorization: "Bearer reservation-token",
      },
      signal: expect.any(AbortSignal),
    });
    expect(init.credentials).toBeUndefined();
  });

  it("accepts an SDP answer at the 256 KiB boundary", async () => {
    const answer = "x".repeat(OPENAI_REALTIME_SDP_ANSWER_MAX_BYTES);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(answer)),
    );
    const exchange = new RealtimeTalkWebRtcOfferExchange();

    await expect(readAnswer(exchange)).resolves.toBe(answer);
  });

  it("preserves oversized SDP answers when the provider declares no limit", async () => {
    const answer = "x".repeat(OPENAI_REALTIME_SDP_ANSWER_MAX_BYTES + 1);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(answer)),
    );
    const exchange = new RealtimeTalkWebRtcOfferExchange();

    await expect(readAnswer(exchange, () => true, null, "openai")).resolves.toBe(answer);
  });

  it("cancels a streamed SDP answer exceeding a custom provider's 256 KiB limit", async () => {
    const cancel = vi.fn(() => Promise.resolve());
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(OPENAI_REALTIME_SDP_ANSWER_MAX_BYTES));
        controller.enqueue(new Uint8Array(1));
      },
      cancel,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        body,
        text: vi.fn(),
      })),
    );
    const exchange = new RealtimeTalkWebRtcOfferExchange();

    await expect(
      readAnswer(exchange, () => true, OPENAI_REALTIME_SDP_ANSWER_MAX_BYTES, "custom-provider"),
    ).rejects.toThrow("Realtime WebRTC SDP answer: text response exceeds 262144 bytes");
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });

  it.each([String(OPENAI_REALTIME_SDP_ANSWER_MAX_BYTES + 1), "9007199254740993"])(
    "rejects a declared oversized SDP answer of %s before acquiring its body reader",
    async (contentLength) => {
      const cancel = vi.fn(() => Promise.resolve());
      const getReader = vi.fn(() => {
        throw new Error("reader should not be acquired");
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({
          ok: true,
          status: 200,
          headers: new Headers({
            "content-length": contentLength,
          }),
          body: { cancel, getReader },
          text: vi.fn(),
        })),
      );
      const exchange = new RealtimeTalkWebRtcOfferExchange();

      await expect(readAnswer(exchange)).rejects.toThrow(
        "Realtime WebRTC SDP answer: text response exceeds 262144 bytes",
      );
      expect(getReader).not.toHaveBeenCalled();
      expect(cancel).toHaveBeenCalledOnce();
    },
  );

  it("cancels a non-2xx SDP response body without waiting for cancellation", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 502,
        body: { cancel },
      })),
    );
    const exchange = new RealtimeTalkWebRtcOfferExchange();

    await expect(readAnswer(exchange)).rejects.toThrow("Realtime WebRTC setup failed (502)");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("cancels a stale successful SDP response body", async () => {
    const cancel = vi.fn(() => Promise.resolve());
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        body: { cancel },
      })),
    );
    const exchange = new RealtimeTalkWebRtcOfferExchange();

    await expect(readAnswer(exchange, () => false)).resolves.toBeUndefined();
    expect(cancel).toHaveBeenCalledOnce();
  });
});
