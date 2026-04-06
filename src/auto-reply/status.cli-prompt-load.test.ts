import { describe, expect, it } from "vitest";
import { normalizeTestText } from "../../test/helpers/normalize-text.js";
import { buildStatusMessage } from "./status.js";

describe("buildStatusMessage cli prompt load", () => {
  it("renders cli prompt loader status when present", () => {
    const text = buildStatusMessage({
      agent: {
        model: "claude-cli/sonnet",
      },
      sessionEntry: {
        sessionId: "abc",
        updatedAt: 0,
        cliPromptLoad: {
          sessionPromptFile: "/tmp/abc.claude-system-prompt.txt",
          loaderMode: "strict",
          verifiedRead: false,
          fallbackReason: "verification_retry",
        },
      },
      sessionKey: "agent:main:main",
      sessionScope: "per-sender",
      now: 10 * 60_000,
    });

    const normalized = normalizeTestText(text);
    expect(normalized).toContain("CLI prompt: file/strict");
    expect(normalized).toContain("fallback=verification_retry");
  });
});
