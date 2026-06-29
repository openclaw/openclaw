// Control UI tests cover session display behavior.
import { describe, expect, it } from "vitest";
import {
  formatSessionKeyForDisplay,
  isCronSessionKey,
  parseSessionKey,
  resolveSessionDisplayName,
} from "./session-display.ts";

describe("parseSessionKey", () => {
  // ── Main session ──
  it("returns Main Session for 'main' key", () => {
    expect(parseSessionKey("main")).toEqual({ prefix: "", fallbackName: "Main Session" });
  });

  it("returns Main Session for 'agent:main:main' key", () => {
    expect(parseSessionKey("agent:main:main")).toEqual({
      prefix: "",
      fallbackName: "Main Session",
    });
  });

  // ── Subagent ──
  it("detects subagent sessions", () => {
    expect(parseSessionKey("agent:main:subagent:worker-1")).toEqual({
      prefix: "Subagent:",
      fallbackName: "Subagent:",
    });
  });

  // ── Cron ──
  it("detects cron sessions via 'cron:' prefix", () => {
    expect(parseSessionKey("cron:my-job")).toEqual({
      prefix: "Cron:",
      fallbackName: "Cron Job:",
    });
  });

  it("detects cron sessions via ':cron:' infix", () => {
    expect(parseSessionKey("agent:main:cron:nightly")).toEqual({
      prefix: "Cron:",
      fallbackName: "Cron Job:",
    });
  });

  // ── Direct chat — Western platforms ──
  it("formats Telegram direct chat", () => {
    expect(parseSessionKey("agent:main:telegram:direct:+19257864429")).toEqual({
      prefix: "",
      fallbackName: "Telegram · +19257864429",
    });
  });

  it("formats Discord direct chat", () => {
    expect(parseSessionKey("agent:main:discord:direct:user123")).toEqual({
      prefix: "",
      fallbackName: "Discord · user123",
    });
  });

  // ── Direct chat — Chinese platforms ──
  it("formats Feishu direct chat with full open_id", () => {
    const result = parseSessionKey("agent:main:feishu:direct:ou_67075ec667cac0a7feae2c5094fd27b2");
    expect(result.prefix).toBe("");
    expect(result.fallbackName).toBe("Feishu · ou_67075ec667cac0a7feae2c5094fd27b2");
  });

  it("formats Feishu direct chat with short id", () => {
    const result = parseSessionKey("agent:main:feishu:direct:user123");
    expect(result).toEqual({ prefix: "", fallbackName: "Feishu · user123" });
  });

  it("formats QQ direct chat", () => {
    expect(parseSessionKey("agent:main:qqbot:direct:123456")).toEqual({
      prefix: "",
      fallbackName: "QQ · 123456",
    });
  });

  it("formats DingTalk direct chat", () => {
    expect(parseSessionKey("agent:main:dingtalk:direct:userABC")).toEqual({
      prefix: "",
      fallbackName: "DingTalk · userABC",
    });
  });

  it("formats WeChat direct chat", () => {
    expect(parseSessionKey("agent:main:wechat:direct:wxid_abc123")).toEqual({
      prefix: "",
      fallbackName: "WeChat · wxid_abc123",
    });
  });

  it("formats WeCom direct chat", () => {
    expect(parseSessionKey("agent:main:wecom:direct:UserId123")).toEqual({
      prefix: "",
      fallbackName: "WeCom · UserId123",
    });
  });

  // ── Direct chat — Other platforms ──
  it("formats LINE direct chat", () => {
    expect(parseSessionKey("agent:main:line:direct:U123456")).toEqual({
      prefix: "",
      fallbackName: "LINE · U123456",
    });
  });

  it("formats Teams direct chat", () => {
    expect(parseSessionKey("agent:main:msteams:direct:user@tenant")).toEqual({
      prefix: "",
      fallbackName: "Teams · user@tenant",
    });
  });

  it("formats Mattermost direct chat", () => {
    expect(parseSessionKey("agent:main:mattermost:direct:user1")).toEqual({
      prefix: "",
      fallbackName: "Mattermost · user1",
    });
  });

  it("formats IRC direct chat", () => {
    expect(parseSessionKey("agent:main:irc:direct:nick!user@host")).toEqual({
      prefix: "",
      fallbackName: "IRC · nick!user@host",
    });
  });

  it("formats Google Chat direct chat", () => {
    expect(parseSessionKey("agent:main:googlechat:direct:user123")).toEqual({
      prefix: "",
      fallbackName: "Google Chat · user123",
    });
  });

  // ── parseSessionKey returns full identifiers (no truncation) ──
  it("returns full identifiers for long machine-generated ids", () => {
    const longId = "a".repeat(30);
    const result = parseSessionKey(`agent:main:feishu:direct:${longId}`);
    expect(result.fallbackName).toBe(`Feishu · ${longId}`);
  });

  // ── Group chat ──
  it("formats group chat", () => {
    expect(parseSessionKey("agent:main:feishu:group:oc_chat_id_123")).toEqual({
      prefix: "",
      fallbackName: "Feishu Group",
    });
  });

  it("formats WeChat group chat", () => {
    expect(parseSessionKey("agent:main:wechat:group:room_456")).toEqual({
      prefix: "",
      fallbackName: "WeChat Group",
    });
  });

  // ── Legacy channel-prefixed keys ──
  it("matches legacy feishu-prefixed keys", () => {
    expect(parseSessionKey("feishu:direct:ou_xxx")).toEqual({
      prefix: "",
      fallbackName: "Feishu Session",
    });
  });

  // ── Unknown channels ──
  it("capitalizes unknown channel in direct chat", () => {
    expect(parseSessionKey("agent:main:customapp:direct:user1")).toEqual({
      prefix: "",
      fallbackName: "Customapp · user1",
    });
  });

  it("returns key as-is for completely unknown format", () => {
    expect(parseSessionKey("random-string")).toEqual({
      prefix: "",
      fallbackName: "random-string",
    });
  });
});

describe("formatSessionKeyForDisplay", () => {
  it("truncates long identifiers for compact display", () => {
    const result = formatSessionKeyForDisplay(
      "agent:main:feishu:direct:ou_67075ec667cac0a7feae2c5094fd27b2",
    );
    expect(result).toBe("Feishu · ou_67075ec66…");
  });

  it("does not truncate short identifiers", () => {
    const result = formatSessionKeyForDisplay("agent:main:telegram:direct:+15551234567");
    expect(result).toBe("Telegram · +15551234567");
  });

  it("does not truncate identifiers at exactly 20 characters", () => {
    const id = "a".repeat(20);
    const result = formatSessionKeyForDisplay(`agent:main:telegram:direct:${id}`);
    expect(result).toBe(`Telegram · ${id}`);
  });

  it("passes through non-direct-chat keys unchanged", () => {
    const result = formatSessionKeyForDisplay("agent:main:feishu:group:oc_chat_123");
    expect(result).toBe("Feishu Group");
  });

  it("passes through main session key", () => {
    expect(formatSessionKeyForDisplay("main")).toBe("Main Session");
  });
});

describe("resolveSessionDisplayName", () => {
  it("uses label when available and different from key", () => {
    const row = { key: "agent:main:feishu:direct:ou_xxx", label: "税务师" } as any;
    expect(resolveSessionDisplayName("agent:main:feishu:direct:ou_xxx", row)).toBe("税务师");
  });

  it("falls back to displayName when label is the key itself", () => {
    const row = {
      key: "agent:main:feishu:direct:ou_xxx",
      label: "agent:main:feishu:direct:ou_xxx",
      displayName: "税务师",
    } as any;
    expect(resolveSessionDisplayName("agent:main:feishu:direct:ou_xxx", row)).toBe("税务师");
  });

  it("falls back to parseSessionKey (full identifier) when no row data", () => {
    expect(
      resolveSessionDisplayName("agent:main:feishu:direct:ou_67075ec667cac0a7feae2c5094fd27b2"),
    ).toBe("Feishu · ou_67075ec667cac0a7feae2c5094fd27b2");
  });
});

describe("isCronSessionKey", () => {
  it("returns true for cron: prefix", () => {
    expect(isCronSessionKey("cron:my-job")).toBe(true);
  });

  it("returns true for agent:...:cron: pattern", () => {
    expect(isCronSessionKey("agent:main:cron:nightly")).toBe(true);
  });

  it("returns false for normal session keys", () => {
    expect(isCronSessionKey("agent:main:feishu:direct:ou_xxx")).toBe(false);
    expect(isCronSessionKey("main")).toBe(false);
  });

  it("returns false for empty key", () => {
    expect(isCronSessionKey("")).toBe(false);
  });
});
