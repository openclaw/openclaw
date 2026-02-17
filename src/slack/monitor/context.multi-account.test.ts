import type { App } from "@slack/bolt";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { RuntimeEnv } from "../../runtime.js";
import { createSlackMonitorContext } from "./context.js";

describe("createSlackMonitorContext - multi-account filtering", () => {
  const createTestContext = (accountId: string, apiAppId: string, teamId = "T0123") => {
    return createSlackMonitorContext({
      cfg: {} as OpenClawConfig,
      accountId,
      botToken: "xoxb-test",
      app: { client: {} } as App,
      runtime: {} as RuntimeEnv,
      botUserId: `U${accountId.toUpperCase()}`,
      teamId,
      apiAppId,
      historyLimit: 0,
      sessionScope: "per-sender",
      mainKey: "main",
      dmEnabled: true,
      dmPolicy: "open",
      allowFrom: [],
      groupDmEnabled: false,
      groupDmChannels: [],
      groupPolicy: "open",
      useAccessGroups: false,
      reactionMode: "own",
      reactionAllowlist: [],
      replyToMode: "all",
      threadHistoryScope: "thread",
      threadInheritParent: false,
      slashCommand: {
        enabled: false,
        name: "openclaw",
        sessionPrefix: "slack:slash",
        ephemeral: true,
      },
      textLimit: 4000,
      ackReactionScope: "group-mentions",
      mediaMaxBytes: 20 * 1024 * 1024,
      removeAckAfterReply: false,
    });
  };

  it("drops events with mismatched api_app_id when apiAppId is set", () => {
    const ctx = createTestContext("og", "A0OG123");
    const eventBody = {
      api_app_id: "A0MAKILALA456",
      team_id: "T0123",
      event: { type: "message" },
    };

    expect(ctx.shouldDropMismatchedSlackEvent(eventBody)).toBe(true);
  });

  it("accepts events with matching api_app_id", () => {
    const ctx = createTestContext("og", "A0OG123");
    const eventBody = {
      api_app_id: "A0OG123",
      team_id: "T0123",
      event: { type: "message" },
    };

    expect(ctx.shouldDropMismatchedSlackEvent(eventBody)).toBe(false);
  });

  it("drops events with missing api_app_id when apiAppId is set (multi-account safety)", () => {
    const ctx = createTestContext("og", "A0OG123");
    const eventBody = {
      team_id: "T0123",
      event: { type: "message" },
    };

    // When we have apiAppId configured, we REQUIRE incoming events to have it
    expect(ctx.shouldDropMismatchedSlackEvent(eventBody)).toBe(true);
  });

  it("accepts events without api_app_id when apiAppId is not set (backward compat)", () => {
    const ctx = createTestContext("default", ""); // empty apiAppId
    const eventBody = {
      team_id: "T0123",
      event: { type: "message" },
    };

    // Backward compatibility: if we don't have apiAppId, we can't filter on it
    expect(ctx.shouldDropMismatchedSlackEvent(eventBody)).toBe(false);
  });

  it("multiple accounts with different api_app_ids only process their own events", () => {
    const ogCtx = createTestContext("og", "A0OG123");
    const makilalaCtx = createTestContext("makilala", "A0MAKILALA456");

    const ogEvent = {
      api_app_id: "A0OG123",
      team_id: "T0123",
      event: { type: "app_mention" },
    };

    const makilalaEvent = {
      api_app_id: "A0MAKILALA456",
      team_id: "T0123",
      event: { type: "app_mention" },
    };

    // og context accepts og events, drops makilala events
    expect(ogCtx.shouldDropMismatchedSlackEvent(ogEvent)).toBe(false);
    expect(ogCtx.shouldDropMismatchedSlackEvent(makilalaEvent)).toBe(true);

    // makilala context accepts makilala events, drops og events
    expect(makilalaCtx.shouldDropMismatchedSlackEvent(makilalaEvent)).toBe(false);
    expect(makilalaCtx.shouldDropMismatchedSlackEvent(ogEvent)).toBe(true);
  });

  it("drops events with mismatched team_id when apiAppId is not available", () => {
    const ctx = createTestContext("og", "", "T0OG123");
    const eventBody = {
      team_id: "T0DIFFERENT",
      event: { type: "message" },
    };

    // Fallback to team_id filtering when api_app_id is not available
    expect(ctx.shouldDropMismatchedSlackEvent(eventBody)).toBe(true);
  });

  it("accepts events with matching team_id when apiAppId is not available", () => {
    const ctx = createTestContext("og", "", "T0OG123");
    const eventBody = {
      team_id: "T0OG123",
      event: { type: "message" },
    };

    expect(ctx.shouldDropMismatchedSlackEvent(eventBody)).toBe(false);
  });
});
