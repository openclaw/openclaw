import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./config.js";

describe("DM policy aliases (Slack/Discord)", () => {
  it('rejects discord dmPolicy="open" without allowFrom "*"', () => {
    const res = validateConfigObject({
      channels: { discord: { dmPolicy: "open", allowFrom: ["123"] } },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]?.path).toBe("channels.discord.allowFrom");
    }
  });

  it('accepts discord legacy dm.policy="open" with top-level allowFrom alias', () => {
    const res = validateConfigObject({
      channels: { discord: { dm: { policy: "open", allowFrom: ["123"] }, allowFrom: ["*"] } },
    });
    expect(res.ok).toBe(true);
  });

  it('rejects slack dmPolicy="open" without allowFrom "*"', () => {
    const res = validateConfigObject({
      channels: { slack: { dmPolicy: "open", allowFrom: ["U123"] } },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]?.path).toBe("channels.slack.allowFrom");
    }
  });

  it('accepts slack legacy dm.policy="open" with top-level allowFrom alias', () => {
    const res = validateConfigObject({
      channels: { slack: { dm: { policy: "open", allowFrom: ["U123"] }, allowFrom: ["*"] } },
    });
    expect(res.ok).toBe(true);
  });
});
