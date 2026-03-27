import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import { resolveSendPolicy } from "./send-policy.js";

describe("resolveSendPolicy", () => {
  it("defaults to allow", () => {
    const cfg = {} as OpenClawConfig;
    expect(resolveSendPolicy({ cfg })).toBe("allow");
  });

  it("entry override wins", () => {
    const cfg = {
      session: { sendPolicy: { default: "allow" } },
    } as OpenClawConfig;
    const entry: SessionEntry = {
      sessionId: "s",
      updatedAt: 0,
      sendPolicy: "deny",
    };
    expect(resolveSendPolicy({ cfg, entry })).toBe("deny");
  });

  it("rule match by channel + chatType", () => {
    const cfg = {
      session: {
        sendPolicy: {
          default: "allow",
          rules: [
            {
              action: "deny",
              match: { channel: "demo-channel", chatType: "group" },
            },
          ],
        },
      },
    } as OpenClawConfig;
    const entry: SessionEntry = {
      sessionId: "s",
      updatedAt: 0,
      channel: "demo-channel",
      chatType: "group",
    };
    expect(resolveSendPolicy({ cfg, entry, sessionKey: "demo-channel:group:dev" })).toBe("deny");
  });

  it("rule match by keyPrefix", () => {
    const cfg = {
      session: {
        sendPolicy: {
          default: "allow",
          rules: [{ action: "deny", match: { keyPrefix: "cron:" } }],
        },
      },
    } as OpenClawConfig;
    expect(resolveSendPolicy({ cfg, sessionKey: "cron:job-1" })).toBe("deny");
  });

  it("rule match by rawKeyPrefix", () => {
    const cfg = {
      session: {
        sendPolicy: {
          default: "allow",
          rules: [{ action: "deny", match: { rawKeyPrefix: "agent:main:demo-channel:" } }],
        },
      },
    } as OpenClawConfig;
    expect(resolveSendPolicy({ cfg, sessionKey: "agent:main:demo-channel:group:dev" })).toBe(
      "deny",
    );
    expect(resolveSendPolicy({ cfg, sessionKey: "agent:main:other-channel:group:dev" })).toBe(
      "allow",
    );
  });
});
