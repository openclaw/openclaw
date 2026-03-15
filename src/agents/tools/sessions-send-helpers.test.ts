import { describe, expect, it, vi } from "vitest";

vi.mock("../../channels/plugins/index.js", () => ({
  normalizeChannelId: (raw?: string | null) => raw?.trim().toLowerCase() ?? null,
  getChannelPlugin: (id: string) => ({
    messaging: {
      normalizeTarget: (raw: string) => {
        const trimmed = raw.trim();
        if (id === "feishu") {
          return trimmed.replace(/^user:/i, "");
        }
        return trimmed;
      },
    },
  }),
}));

vi.mock("../../channels/registry.js", () => ({
  normalizeChannelId: (raw?: string | null) => raw?.trim().toLowerCase() ?? null,
}));

import { resolveAnnounceTargetFromKey } from "./sessions-send-helpers.js";

describe("resolveAnnounceTargetFromKey", () => {
  it("infers direct-message targets from session keys", () => {
    expect(resolveAnnounceTargetFromKey("agent:main:feishu:direct:ou_123")).toEqual({
      channel: "feishu",
      to: "ou_123",
      threadId: undefined,
    });
  });

  it("preserves non-integer thread ids", () => {
    expect(
      resolveAnnounceTargetFromKey("agent:main:slack:channel:C0123ABC:thread:1234567890.123456"),
    ).toEqual({
      channel: "slack",
      to: "channel:C0123ABC",
      threadId: "1234567890.123456",
    });
  });

  it("keeps channel targets stable for group sessions", () => {
    expect(resolveAnnounceTargetFromKey("agent:main:discord:group:dev")).toEqual({
      channel: "discord",
      to: "channel:dev",
      threadId: undefined,
    });
  });
});
