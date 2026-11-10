import { describe, expect, it } from "vitest";
import { preserveResetSessionPresentation } from "./reset-preserved-presentation.js";

describe("preserveResetSessionPresentation", () => {
  it("preserves the Telegram topic name across reset", () => {
    expect(
      preserveResetSessionPresentation({
        sessionId: "session-before-reset",
        updatedAt: 1,
        topicName: "Existing topic",
      }),
    ).toMatchObject({ topicName: "Existing topic" });
  });
});
