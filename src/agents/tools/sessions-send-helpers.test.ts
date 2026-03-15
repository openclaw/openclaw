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
      accountId: undefined,
      threadId: undefined,
    });
  });

  it("preserves direct ids that contain :thread: segments", () => {
    expect(resolveAnnounceTargetFromKey("agent:main:telegram:dm:user:thread:abc")).toEqual({
      channel: "telegram",
      to: "user:thread:abc",
      accountId: undefined,
      threadId: undefined,
    });
  });

  it("includes account ids from per-account direct session keys", () => {
    expect(resolveAnnounceTargetFromKey("agent:main:slack:workspace-1:direct:U123")).toEqual({
      channel: "slack",
      to: "user:U123",
      accountId: "workspace-1",
      threadId: undefined,
    });
  });

  it("preserves non-integer thread ids", () => {
    expect(
      resolveAnnounceTargetFromKey("agent:main:slack:channel:C0123ABC:thread:1234567890.123456"),
    ).toEqual({
      channel: "slack",
      to: "channel:C0123ABC",
      accountId: undefined,
      threadId: "1234567890.123456",
    });
  });

  it("keeps channel targets stable for group sessions", () => {
    expect(resolveAnnounceTargetFromKey("agent:main:discord:group:dev")).toEqual({
      channel: "discord",
      to: "channel:dev",
      accountId: undefined,
      threadId: undefined,
    });
  });
});
