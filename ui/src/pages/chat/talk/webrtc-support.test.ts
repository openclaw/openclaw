// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { RealtimeTalkWebRtcOfferExchange } from "./webrtc-support.ts";

const OPENAI_REALTIME_SDP_ANSWER_MAX_BYTES = 256 * 1024;

function readAnswer(exchange: RealtimeTalkWebRtcOfferExchange, isCurrent = () => true) {
  return exchange.readAnswer({
    session: {
      provider: "openai",
      transport: "webrtc",
      clientSecret: "reservation-token",
      offerUrl: "https://gateway.example.test/realtime/calls",
      offerResponseMaxBytes: OPENAI_REALTIME_SDP_ANSWER_MAX_BYTES,
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
        headers: expect.objectContaining({
          Authorization: "Bearer reservation-token",
        }),
      }),
    );
  });

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
