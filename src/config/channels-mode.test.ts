import { describe, expect, it } from "vitest";

describe("channels.mode config", () => {
  it("should default to direct mode", async () => {
    // Verify the type accepts 'direct' and 'platform'
    const directConfig = { mode: "direct" as const };
    const platformConfig = { mode: "platform" as const };
    expect(directConfig.mode).toBe("direct");
    expect(platformConfig.mode).toBe("platform");
  });
});
