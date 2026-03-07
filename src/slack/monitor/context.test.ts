import type { App } from "@slack/bolt";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { RuntimeEnv } from "../../runtime.js";
import { createSlackMonitorContext } from "./context.js";

function createTestContext() {
  return createSlackMonitorContext({
    cfg: {
      channels: { slack: { enabled: true } },
      session: { dmScope: "main" },
    } as OpenClawConfig,
    accountId: "default",
    botToken: "xoxb-test",
    app: { client: {} } as App,
    runtime: {} as RuntimeEnv,
    botUserId: "U_BOT",
    teamId: "T_EXPECTED",
    apiAppId: "A_EXPECTED",
    historyLimit: 0,
    sessionScope: "per-sender",
    mainKey: "main",
    dmEnabled: true,
    dmPolicy: "open",
    allowFrom: [],
    allowNameMatching: false,
    groupDmEnabled: false,
    groupDmChannels: [],
    defaultRequireMention: true,
    groupPolicy: "allowlist",
    useAccessGroups: true,
    reactionMode: "off",
    reactionAllowlist: [],
    replyToMode: "off",
    threadHistoryScope: "thread",
    threadInheritParent: false,
    slashCommand: {
      enabled: true,
      name: "openclaw",
      ephemeral: true,
      sessionPrefix: "slack:slash",
    },
    textLimit: 4000,
    typingReaction: "",
    ackReactionScope: "group-mentions",
    mediaMaxBytes: 20 * 1024 * 1024,
    removeAckAfterReply: false,
  });
}

describe("createSlackMonitorContext shouldDropMismatchedSlackEvent", () => {
  it("drops mismatched top-level app/team identifiers", () => {
    const ctx = createTestContext();
    expect(
      ctx.shouldDropMismatchedSlackEvent({
        api_app_id: "A_WRONG",
        team_id: "T_EXPECTED",
      }),
    ).toBe(true);
    expect(
      ctx.shouldDropMismatchedSlackEvent({
        api_app_id: "A_EXPECTED",
        team_id: "T_WRONG",
      }),
    ).toBe(true);
  });

  it("drops mismatched nested team.id payloads used by interaction bodies", () => {
    const ctx = createTestContext();
    expect(
      ctx.shouldDropMismatchedSlackEvent({
        api_app_id: "A_EXPECTED",
        team: { id: "T_WRONG" },
      }),
    ).toBe(true);
    expect(
      ctx.shouldDropMismatchedSlackEvent({
        api_app_id: "A_EXPECTED",
        team: { id: "T_EXPECTED" },
      }),
    ).toBe(false);
  });

  it("reflects post-construction auth updates (mux mode: ctx.teamId/apiAppId set after runAuthTest)", () => {
    // Simulate mux mode: context created before runAuthTest() so teamId/apiAppId
    // are initially empty, then patched once auth.test completes.
    const ctx = createSlackMonitorContext({
      cfg: {
        channels: { slack: { enabled: true } },
        session: { dmScope: "main" },
      } as OpenClawConfig,
      accountId: "default",
      botToken: "xoxb-test",
      app: { client: {} } as App,
      runtime: {} as RuntimeEnv,
      botUserId: "",
      teamId: "",
      apiAppId: "",
      historyLimit: 0,
      sessionScope: "per-sender",
      mainKey: "main",
      dmEnabled: true,
      dmPolicy: "open",
      allowFrom: [],
      allowNameMatching: false,
      groupDmEnabled: false,
      groupDmChannels: [],
      defaultRequireMention: true,
      groupPolicy: "allowlist",
      useAccessGroups: true,
      reactionMode: "off",
      reactionAllowlist: [],
      replyToMode: "off",
      threadHistoryScope: "thread",
      threadInheritParent: false,
      slashCommand: {
        enabled: true,
        name: "openclaw",
        ephemeral: true,
        sessionPrefix: "slack:slash",
      },
      textLimit: 4000,
      typingReaction: "",
      ackReactionScope: "group-mentions",
      mediaMaxBytes: 20 * 1024 * 1024,
      removeAckAfterReply: false,
    });

    // Before runAuthTest: empty teamId/apiAppId → guard is inactive, no events dropped
    expect(ctx.shouldDropMismatchedSlackEvent({ api_app_id: "A_OTHER", team_id: "T_OTHER" })).toBe(
      false,
    );

    // Simulate runAuthTest() completing and provider patching the context
    ctx.teamId = "T_REAL";
    ctx.apiAppId = "A_REAL";

    // Guard is now active — cross-workspace/app events must be dropped
    expect(ctx.shouldDropMismatchedSlackEvent({ api_app_id: "A_REAL", team_id: "T_OTHER" })).toBe(
      true,
    );
    expect(ctx.shouldDropMismatchedSlackEvent({ api_app_id: "A_OTHER", team_id: "T_REAL" })).toBe(
      true,
    );
    // Matching events must pass through
    expect(ctx.shouldDropMismatchedSlackEvent({ api_app_id: "A_REAL", team_id: "T_REAL" })).toBe(
      false,
    );
  });
});
