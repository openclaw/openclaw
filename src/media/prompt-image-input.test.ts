import { describe, expect, it } from "vitest";
import type { PersistedUserTurnMessage } from "../sessions/user-turn-transcript.types.js";
import { hasPromptImageInput } from "./prompt-image-input.js";

describe("hasPromptImageInput", () => {
  it("treats an image this run could not read as no image input", () => {
    const recorded = { path: "/tmp/oversized.png", contentType: "image/png" };
    const message: PersistedUserTurnMessage = {
      role: "user",
      content: "here",
      timestamp: 0,
      __openclaw: { media: [recorded] },
    };
    const userTurnTranscriptRecorder = { message };

    expect(
      hasPromptImageInput({
        media: [{ ...recorded, hydrationSuppressed: true, unresolvedThisTurn: true }],
        userTurnTranscriptRecorder,
      }),
    ).toBe(false);
    expect(hasPromptImageInput({ userTurnTranscriptRecorder })).toBe(true);
  });
});
