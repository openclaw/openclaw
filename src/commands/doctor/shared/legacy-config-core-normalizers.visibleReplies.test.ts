import { describe, expect, it } from "vitest";
import { normalizeMissingGroupVisibleRepliesDefault } from "./legacy-config-core-normalizers.js";

describe("normalizeMissingGroupVisibleRepliesDefault", () => {
  it("recommends message_tool when message tool is available (full profile)", () => {
    const changes: string[] = [];
    const result = normalizeMissingGroupVisibleRepliesDefault(
      { channels: { myChannel: {} } },
      changes,
    );
    expect(result.messages?.groupChat?.visibleReplies).toBe("message_tool");
    expect(changes[0]).toContain("message_tool");
  });

  it("recommends automatic when message tool is unavailable (minimal profile)", () => {
    const changes: string[] = [];
    const result = normalizeMissingGroupVisibleRepliesDefault(
      { channels: { myChannel: {} }, tools: { profile: "minimal" } },
      changes,
    );
    expect(result.messages?.groupChat?.visibleReplies).toBe("automatic");
    expect(changes[0]).toContain("automatic");
    expect(changes[0]).toContain("message tool unavailable");
  });

  it("does not apply fix when visibleReplies is already set", () => {
    const changes: string[] = [];
    const result = normalizeMissingGroupVisibleRepliesDefault(
      {
        channels: { myChannel: {} },
        tools: { profile: "minimal" },
        messages: { groupChat: { visibleReplies: "message_tool" } },
      },
      changes,
    );
    expect(result.messages?.groupChat?.visibleReplies).toBe("message_tool");
    expect(changes).toHaveLength(0);
  });

  it("does not apply fix when no channels are configured", () => {
    const changes: string[] = [];
    const result = normalizeMissingGroupVisibleRepliesDefault(
      { tools: { profile: "minimal" } },
      changes,
    );
    expect(result.messages?.groupChat?.visibleReplies).toBeUndefined();
    expect(changes).toHaveLength(0);
  });
});
