import { expect, it } from "vitest";
import { setReplyPayloadMetadata, stripReplyPayloadResponsePrefix } from "../reply-payload.js";
import { HEARTBEAT_TOKEN } from "../tokens.js";
import { normalizeReplyPayloadOutcome } from "./normalize-reply.js";

it.each([
  ["Plain answer", "Plain answer"],
  ["[bot] authored prefix", "[bot] authored prefix"],
])("strips only normalization-owned preview decoration from %s", (text, expectedChunk) => {
  const result = normalizeReplyPayloadOutcome(
    { text, textMode: "delta" },
    { responsePrefix: "[bot]" },
  );
  expect(result.kind).toBe("deliver");
  if (result.kind !== "deliver") {
    throw new Error("Expected deliverable normalized chunk");
  }
  expect(result.payload.text).toBe(text.startsWith("[bot]") ? text : `[bot] ${text}`);
  expect(stripReplyPayloadResponsePrefix(result.payload, result.payload.text ?? "")).toBe(
    expectedChunk,
  );
  const again = normalizeReplyPayloadOutcome(result.payload, { responsePrefix: "[bot]" });
  expect(again.kind).toBe("deliver");
  if (again.kind === "deliver") {
    expect(stripReplyPayloadResponsePrefix(again.payload, again.payload.text ?? "")).toBe(
      expectedChunk,
    );
  }
});

it("preserves a host-approved heartbeat acknowledgment while retaining channel transforms", () => {
  const payload = setReplyPayloadMetadata({ text: HEARTBEAT_TOKEN }, { heartbeatReply: true });
  expect(normalizeReplyPayloadOutcome(payload)).toEqual({ kind: "deliver", payload });
  expect(normalizeReplyPayloadOutcome({ ...payload })).toEqual({
    kind: "suppress",
    reason: "heartbeat",
  });
  expect(normalizeReplyPayloadOutcome(payload, { transformReplyPayload: () => null })).toEqual({
    kind: "suppress",
    reason: "channel_transform",
  });
});
