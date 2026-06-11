import { describe, expect, it } from "vitest";
import { sanitizeRecommendationText } from "./text.js";

describe("self-improvement text sanitization", () => {
  it("redacts local paths and secret-like values from stored recommendation text", () => {
    const rawToken = "sk-testsecretabcdefghijklmnopqrstuvwxyz";
    const text = sanitizeRecommendationText(
      `Command "/Users/openclaw/Library/Mobile Documents/OpenClaw Backups/key.json" --token ${rawToken} read /private/tmp/openclaw/key-file /opt/homebrew/bin/node /usr/local/bin/tool /home/openclaw/project and ~/openclaw/local.txt`,
      1_000,
    );

    expect(text).toContain('"[local-path]"');
    expect(text).toContain("[local-path]");
    expect(text).not.toContain("/Users/openclaw");
    expect(text).not.toContain("/private/tmp");
    expect(text).not.toContain("/opt/homebrew");
    expect(text).not.toContain("/usr/local");
    expect(text).not.toContain("/home/openclaw");
    expect(text).not.toContain("~/openclaw");
    expect(text).not.toContain(rawToken);
  });
});
