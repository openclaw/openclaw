import { describe, expect, it } from "vitest";
import {
  extractHeartbeatNotifyTargets,
  parseHeartbeatNotifyTarget,
  parseHeartbeatNotifyTargets,
} from "./heartbeat-notify-parse.js";

describe("parseHeartbeatNotifyTarget", () => {
  it("parses discord:#channel", () => {
    const r = parseHeartbeatNotifyTarget("discord:#autopilot");
    expect(r).toEqual({ channel: "discord", to: "#autopilot" });
  });

  it("parses telegram:@user", () => {
    const r = parseHeartbeatNotifyTarget("telegram:@wesley");
    expect(r).toEqual({ channel: "telegram", to: "@wesley" });
  });

  it("parses slack:#channel", () => {
    const r = parseHeartbeatNotifyTarget("slack:#incidents");
    expect(r).toEqual({ channel: "slack", to: "#incidents" });
  });

  it("parses whatsapp with E.164", () => {
    const r = parseHeartbeatNotifyTarget("whatsapp:+15551234567");
    expect(r).toEqual({ channel: "whatsapp", to: "+15551234567" });
  });

  it("parses telegram topic format", () => {
    const r = parseHeartbeatNotifyTarget("telegram:12345:topic:42");
    expect(r).toEqual({ channel: "telegram", to: "12345:topic:42" });
  });

  it("returns undefined for empty string", () => {
    expect(parseHeartbeatNotifyTarget("")).toBeUndefined();
    expect(parseHeartbeatNotifyTarget("   ")).toBeUndefined();
  });

  it("returns undefined when missing colon", () => {
    expect(parseHeartbeatNotifyTarget("discord")).toBeUndefined();
    expect(parseHeartbeatNotifyTarget("discord#autopilot")).toBeUndefined();
  });

  it("returns undefined when to is empty", () => {
    expect(parseHeartbeatNotifyTarget("discord:")).toBeUndefined();
    expect(parseHeartbeatNotifyTarget("discord:   ")).toBeUndefined();
  });

  it("returns undefined for unknown channel", () => {
    const r = parseHeartbeatNotifyTarget("unknownchannel:#test");
    expect(r).toBeUndefined();
  });
});

describe("parseHeartbeatNotifyTargets", () => {
  it("parses comma-separated targets", () => {
    const r = parseHeartbeatNotifyTargets("discord:#autopilot, telegram:@wesley");
    expect(r).toEqual([
      { channel: "discord", to: "#autopilot" },
      { channel: "telegram", to: "@wesley" },
    ]);
  });

  it("deduplicates same channel:to", () => {
    const r = parseHeartbeatNotifyTargets("discord:#a, discord:#a, telegram:@b");
    expect(r).toEqual([
      { channel: "discord", to: "#a" },
      { channel: "telegram", to: "@b" },
    ]);
  });

  it("skips invalid entries", () => {
    const r = parseHeartbeatNotifyTargets("discord:#a, invalid, slack:#b, telegram:");
    expect(r).toEqual([
      { channel: "discord", to: "#a" },
      { channel: "slack", to: "#b" },
    ]);
  });

  it("returns empty array for empty input", () => {
    expect(parseHeartbeatNotifyTargets("")).toEqual([]);
    expect(parseHeartbeatNotifyTargets("   ")).toEqual([]);
  });
});

describe("extractHeartbeatNotifyTargets", () => {
  it("extracts notify lines from HEARTBEAT.md content", () => {
    const content = `
# Heartbeat checklist

## Check: codex status
notify: discord:#autopilot
- Check if Codex is idle

## Check: disk space
notify: telegram:@wesley
- Check disk usage
`;
    const r = extractHeartbeatNotifyTargets(content);
    expect(r).toEqual([
      { channel: "discord", to: "#autopilot" },
      { channel: "telegram", to: "@wesley" },
    ]);
  });

  it("handles multiple targets on one line", () => {
    const content = "notify: discord:#incidents, slack:#ops\n";
    const r = extractHeartbeatNotifyTargets(content);
    expect(r).toEqual([
      { channel: "discord", to: "#incidents" },
      { channel: "slack", to: "#ops" },
    ]);
  });

  it("deduplicates across lines", () => {
    const content = `
notify: discord:#a
notify: discord:#a
`;
    const r = extractHeartbeatNotifyTargets(content);
    expect(r).toEqual([{ channel: "discord", to: "#a" }]);
  });

  it("ignores lines without notify:", () => {
    const content = `
- Some task
notify: discord:#a
# A comment
`;
    const r = extractHeartbeatNotifyTargets(content);
    expect(r).toEqual([{ channel: "discord", to: "#a" }]);
  });

  it("handles leading whitespace before notify", () => {
    const content = "  notify: telegram:@user\n";
    const r = extractHeartbeatNotifyTargets(content);
    expect(r).toEqual([{ channel: "telegram", to: "@user" }]);
  });

  it("returns empty array for empty content", () => {
    expect(extractHeartbeatNotifyTargets("")).toEqual([]);
    expect(extractHeartbeatNotifyTargets("\n\n")).toEqual([]);
  });

  it("returns empty array for null/undefined", () => {
    expect(extractHeartbeatNotifyTargets(null as unknown as string)).toEqual([]);
    expect(extractHeartbeatNotifyTargets(undefined as unknown as string)).toEqual([]);
  });
});
