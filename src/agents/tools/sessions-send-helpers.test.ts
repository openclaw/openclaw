import { describe, expect, it } from "vitest";
import { resolveAnnounceTargetFromKey } from "./sessions-send-helpers.js";

describe("resolveAnnounceTargetFromKey", () => {
  it("extracts numeric Telegram topic ID", () => {
    const result = resolveAnnounceTargetFromKey(
      "agent:main:telegram:group:-1001234567890:topic:12345",
    );
    expect(result).not.toBeNull();
    expect(result!.threadId).toBe("12345");
    expect(result!.channel).toBe("telegram");
  });

  it("extracts alphanumeric Feishu topic ID", () => {
    const result = resolveAnnounceTargetFromKey(
      "agent:main:feishu:group:oc_abc123:topic:om_x100b5460aa5ef4a4b3d98b7bd85fbc0",
    );
    expect(result).not.toBeNull();
    expect(result!.threadId).toBe("om_x100b5460aa5ef4a4b3d98b7bd85fbc0");
    expect(result!.channel).toBe("feishu");
  });

  it("extracts Discord thread ID", () => {
    const result = resolveAnnounceTargetFromKey(
      "agent:main:discord:channel:9876543210:thread:1122334455",
    );
    expect(result).not.toBeNull();
    expect(result!.threadId).toBe("1122334455");
    expect(result!.channel).toBe("discord");
  });

  it("strips topic suffix from target ID", () => {
    const result = resolveAnnounceTargetFromKey("agent:main:feishu:group:oc_abc123:topic:om_xyz");
    expect(result).not.toBeNull();
    expect(result!.to).toContain("oc_abc123");
    expect(result!.to).not.toContain("om_xyz");
  });

  it("extracts Slack thread ID with dot separator", () => {
    const result = resolveAnnounceTargetFromKey(
      "agent:main:slack:channel:C0123ABC:thread:1234567890.123456",
    );
    expect(result).not.toBeNull();
    expect(result!.threadId).toBe("1234567890.123456");
    expect(result!.channel).toBe("slack");
  });

  it("returns no threadId when topic/thread suffix is absent", () => {
    const result = resolveAnnounceTargetFromKey("agent:main:telegram:group:-1001234567890");
    expect(result).not.toBeNull();
    expect(result!.threadId).toBeUndefined();
    expect(result!.channel).toBe("telegram");
  });

  it("returns null for short session keys", () => {
    expect(resolveAnnounceTargetFromKey("agent:main")).toBeNull();
  });

  it("returns null for non-group/channel keys", () => {
    expect(resolveAnnounceTargetFromKey("agent:main:telegram:direct:123")).toBeNull();
  });
});
