// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeStallingStream } from "../../../../../src/infra/http-body.test-support.js";
import type { RealtimeTalkWebRtcSdpSessionResult } from "./shared.ts";
import { RealtimeTalkWebRtcOfferExchange } from "./webrtc-support.ts";

const OPENAI_REALTIME_SDP_ANSWER_MAX_BYTES = 256 * 1024;

function stubFetch(response: unknown) {
  const fetch = vi.fn(async () => response);
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function readAnswer(
  session: Partial<RealtimeTalkWebRtcSdpSessionResult> = {},
  isCurrent = () => true,
  gatewayUrl = "wss://gateway.example.test/control",
) {
  return new RealtimeTalkWebRtcOfferExchange().readAnswer({
    session: {
      provider: "openai",
      transport: "webrtc",
      clientSecret: "reservation-token",
      offerUrl: "https://gateway.example.test/realtime/calls",
      offerResponseMaxBytes: OPENAI_REALTIME_SDP_ANSWER_MAX_BYTES,
      ...session,
    },
    offer: { type: "offer", sdp: "offer-sdp" },
    gatewayUrl,
    isCurrent,
  });
}

describe("RealtimeTalkWebRtcOfferExchange", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("resolves relative offer routes against the connected Gateway", async () => {
    const fetchMock = stubFetch(new Response("answer-sdp"));
    await readAnswer(
      { offerUrl: "/plugins/codex/realtime/calls", offerResponseMaxBytes: undefined },
      () => true,
      "wss://gateway.example.test/control?tenant=a",
    );
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

  it.each([OPENAI_REALTIME_SDP_ANSWER_MAX_BYTES, undefined])(
    "accepts an SDP answer with provider limit %s",
    async (limit) => {
      const answer = "x".repeat(
        OPENAI_REALTIME_SDP_ANSWER_MAX_BYTES + (limit === undefined ? 1 : 0),
      );
      stubFetch(new Response(answer));
      await expect(readAnswer({ offerResponseMaxBytes: limit })).resolves.toBe(answer);
    },
  );

  it("cancels a streamed SDP answer exceeding a custom provider's 256 KiB limit", async () => {
    const cancel = vi.fn(() => Promise.resolve());
    const body = makeStallingStream(
      [new Uint8Array(OPENAI_REALTIME_SDP_ANSWER_MAX_BYTES), new Uint8Array(1)],
      cancel,
    );
    stubFetch({ ok: true, status: 200, headers: new Headers(), body, text: vi.fn() });
    await expect(readAnswer({ provider: "custom-provider" })).rejects.toThrow(
      "Realtime WebRTC SDP answer: text response exceeds 262144 bytes",
    );
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
      stubFetch({
        ok: true,
        status: 200,
        headers: new Headers({ "content-length": contentLength }),
        body: { cancel, getReader },
        text: vi.fn(),
      });
      await expect(readAnswer()).rejects.toThrow(
        "Realtime WebRTC SDP answer: text response exceeds 262144 bytes",
      );
      expect(getReader).not.toHaveBeenCalled();
      expect(cancel).toHaveBeenCalledOnce();
    },
  );

  it("cancels a non-2xx SDP response body without waiting for cancellation", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    stubFetch({ ok: false, status: 502, body: { cancel } });
    await expect(readAnswer()).rejects.toThrow("Realtime WebRTC setup failed (502)");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("cancels a stale successful SDP response body", async () => {
    const cancel = vi.fn(() => Promise.resolve());
    stubFetch({ ok: true, status: 200, body: { cancel } });
    await expect(readAnswer({}, () => false)).resolves.toBeUndefined();
    expect(cancel).toHaveBeenCalledOnce();
  });
});
