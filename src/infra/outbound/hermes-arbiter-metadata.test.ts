import { describe, expect, it, vi } from "vitest";
import { buildHermesArbiterMetadata, makeHermesArbiterTraceId } from "./hermes-arbiter-metadata.js";

describe("hermes-arbiter-metadata", () => {
  it("builds canonical Hermes arbiter metadata", () => {
    const metadata = buildHermesArbiterMetadata({
      topic: "dev-iox",
      botName: "AHC_A8_bot",
      text: "hello",
      traceId: "openclaw:1745365200123:a1b2c",
      actionType: "message",
      targetChatId: "12345",
      extra: { dryRun: true },
    });

    expect(metadata).toEqual({
      arbiter_topic: "dev-iox",
      arbiter_bot_name: "AHC_A8_bot",
      arbiter_trace_id: "openclaw:1745365200123:a1b2c",
      arbiter_action: {
        type: "message",
        payload: "hello",
        target_chat_id: "12345",
        extra: { dryRun: true },
      },
    });
  });

  it("generates trace ids with default origin", () => {
    vi.spyOn(Date, "now").mockReturnValue(1745365200123);
    vi.spyOn(Math, "random").mockReturnValue(0.123456789);

    const traceId = makeHermesArbiterTraceId();

    expect(traceId).toMatch(/^openclaw:1745365200123:[a-z0-9]{5}$/);
  });
});
