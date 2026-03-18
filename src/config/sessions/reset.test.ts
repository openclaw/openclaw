import { beforeEach, describe, expect, it } from "vitest";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createSessionConversationTestRegistry } from "../../test-utils/session-conversation-registry.js";
import type { OpenClawConfig } from "../config.js";
import {
  evaluateSessionFreshness,
  isThreadSessionKey,
  resolveDailyResetAtMs,
  resolveSessionResetType,
  type SessionResetPolicy,
} from "./reset.js";

describe("session reset thread detection", () => {
  beforeEach(() => {
    setActivePluginRegistry(createSessionConversationTestRegistry());
  });

  it("does not treat feishu conversation ids with embedded :topic: as thread suffixes", () => {
    const sessionKey =
      "agent:main:feishu:group:oc_group_chat:topic:om_topic_root:sender:ou_topic_user";
    expect(isThreadSessionKey(sessionKey)).toBe(false);
    expect(resolveSessionResetType({ sessionKey })).toBe("group");
  });

  it("still treats telegram :topic: suffixes as thread sessions", () => {
    const sessionKey = "agent:main:telegram:group:-100123:topic:77";
    expect(isThreadSessionKey(sessionKey)).toBe(true);
    expect(resolveSessionResetType({ sessionKey })).toBe("thread");
  });
});

describe("session reset timezone semantics", () => {
  const shanghaiCfg: OpenClawConfig = {
    agents: {
      defaults: {
        userTimezone: "Asia/Shanghai",
      },
    },
  };

  const dailyPolicy: SessionResetPolicy = {
    mode: "daily",
    atHour: 4,
  };

  it("treats sessions before the local reset hour as part of the previous human day", () => {
    const updatedAt = Date.UTC(2026, 2, 18, 19, 30, 0); // 2026-03-19 03:30 +08:00
    const now = Date.UTC(2026, 2, 18, 21, 0, 0); // 2026-03-19 05:00 +08:00

    const freshness = evaluateSessionFreshness({
      updatedAt,
      now,
      policy: dailyPolicy,
      cfg: shanghaiCfg,
    });

    expect(freshness.fresh).toBe(false);
  });

  it("returns a daily reset boundary anchored to the configured human timezone", () => {
    const now = Date.UTC(2026, 2, 18, 21, 0, 0); // 2026-03-19 05:00 +08:00
    const boundaryMs = resolveDailyResetAtMs(now, 4, shanghaiCfg);
    expect(boundaryMs).toBe(Date.UTC(2026, 2, 18, 20, 0, 0));
  });
});
