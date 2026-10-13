import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import {
  createHeartbeatToolResponsePayload,
  selectHeartbeatToolResponse,
} from "./heartbeat-tool-response.js";
import { getReplyPayloadMetadata } from "./reply-payload.js";

describe("heartbeat scratch proposal resolution", () => {
  it("lets a later heartbeat response clear an earlier scratch proposal", () => {
    const first = createHeartbeatToolResponsePayload({
      outcome: "progress",
      notify: false,
      summary: "first",
      scratch: "stale scratch",
    });
    const corrected = createHeartbeatToolResponsePayload({
      outcome: "no_change",
      notify: false,
      summary: "corrected",
    });

    const selected = expectDefined(
      selectHeartbeatToolResponse([first, corrected]),
      "expected the corrected heartbeat response",
    );
    expect(selected.response.summary).toBe("corrected");
    expect(getReplyPayloadMetadata(selected.payload)?.heartbeatScratchProposal).toBeUndefined();
  });
});
