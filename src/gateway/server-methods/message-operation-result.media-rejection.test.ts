import { describe, expect, it } from "vitest";
import { OutboundDeliveryError } from "../../infra/outbound/deliver-types.js";
import { LocalMediaAccessError } from "../../media/local-media-access.js";
import { createGatewayInflightUnavailableFailure } from "./message-operation-result.js";
import type { GatewayRequestContext } from "./types.js";

function failure(err: unknown) {
  const context = { dedupe: new Map() } as unknown as GatewayRequestContext;
  return createGatewayInflightUnavailableFailure({
    context,
    dedupeKey: undefined,
    channel: "telegram",
    err,
  });
}

const refused = () =>
  new LocalMediaAccessError(
    "path-not-allowed",
    "Local media path is not under an allowed directory: /data/outside/file.md",
  );

describe("message.action failures before any send", () => {
  it("reports a refused local media path as a validation error, not a possible send", () => {
    const result = failure(new OutboundDeliveryError("send failed", { cause: refused() }));
    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({
      code: "INVALID_REQUEST",
      message: expect.stringContaining("not under an allowed directory"),
    });
  });

  it("classifies an unwrapped refusal the same way", () => {
    expect(failure(refused()).error).toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("stays UNAVAILABLE once part of the delivery was already sent", () => {
    const err = new OutboundDeliveryError("send failed", {
      cause: refused(),
      results: [{ channel: "telegram", messageId: "10" } as never],
    });
    expect(err.sentBeforeError).toBe(true);
    expect(failure(err).error).toMatchObject({ code: "UNAVAILABLE" });
  });

  it("stays UNAVAILABLE for provider failures with an unknown outcome", () => {
    const err = new OutboundDeliveryError("telegram timed out", { cause: new Error("ETIMEDOUT") });
    expect(failure(err).error).toMatchObject({ code: "UNAVAILABLE" });
  });
});
