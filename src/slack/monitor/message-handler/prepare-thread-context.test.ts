import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { App } from "@slack/bolt";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import type { RuntimeEnv } from "../../../runtime.js";
import { createSlackMonitorContext } from "../context.js";
import { checkThreadSessionFreshness } from "./prepare-thread-context.js";

describe("checkThreadSessionFreshness", () => {
  let fixtureRoot = "";

  beforeAll(() => {
    fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-slack-freshness-"));
  });

  afterAll(() => {
    if (fixtureRoot) {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
      fixtureRoot = "";
    }
  });

  function makeStorePath(): string {
    const dir = fs.mkdtempSync(path.join(fixtureRoot, "store-"));
    return path.join(dir, "sessions.json");
  }

  function writeSessionTimestamp(storePath: string, sessionKey: string, timestamp: number): void {
    const sessionsDir = path.dirname(storePath);
    fs.mkdirSync(sessionsDir, { recursive: true });

    // Read existing store or create new one
    let store: Record<string, { updatedAt: number; sessionId: string }> = {};
    try {
      const raw = fs.readFileSync(storePath, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        store = parsed as Record<string, { updatedAt: number; sessionId: string }>;
      }
    } catch {
      // File doesn't exist or is invalid, start with empty store
    }

    // Normalize session key (same logic as resolveStoreSessionEntry)
    const normalizedKey = sessionKey.trim().toLowerCase();

    // Update the session entry
    store[normalizedKey] = {
      sessionId: normalizedKey,
      updatedAt: timestamp,
    };

    // Write back to store
    fs.writeFileSync(storePath, JSON.stringify(store, null, 2));
  }

  describe("with fresh session", () => {
    it("returns true for truly new session (no timestamp)", () => {
      const storePath = makeStorePath();
      const slackCtx = createSlackMonitorContext({
        cfg: {} as OpenClawConfig,
        accountId: "default",
        botToken: "token",
        app: {} as App,
        runtime: {} as RuntimeEnv,
        botUserId: "B1",
        teamId: "T1",
        apiAppId: "A1",
        historyLimit: 0,
        sessionScope: "per-sender",
        mainKey: "main",
        dmEnabled: true,
        dmPolicy: "open",
        allowFrom: [],
        allowNameMatching: false,
        groupDmEnabled: true,
        groupDmChannels: [],
        defaultRequireMention: true,
        groupPolicy: "open",
        useAccessGroups: false,
        reactionMode: "off",
        reactionAllowlist: [],
        replyToMode: "off",
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
        typingReaction: "",
        mediaMaxBytes: 1024,
        removeAckAfterReply: false,
      });

      const result = checkThreadSessionFreshness({
        storePath,
        sessionKey: "agent:main:slack:channel:C123:thread:123.456",
        ctx: slackCtx,
      });

      expect(result.fresh).toBe(true);
    });

    it("returns true for session updated recently (within idle timeout)", () => {
      const storePath = makeStorePath();
      const slackCtx = createSlackMonitorContext({
        cfg: {
          session: { reset: { mode: "idle", idleMinutes: 60 } },
        } as OpenClawConfig,
        accountId: "default",
        botToken: "token",
        app: {} as App,
        runtime: {} as RuntimeEnv,
        botUserId: "B1",
        teamId: "T1",
        apiAppId: "A1",
        historyLimit: 0,
        sessionScope: "per-sender",
        mainKey: "main",
        dmEnabled: true,
        dmPolicy: "open",
        allowFrom: [],
        allowNameMatching: false,
        groupDmEnabled: true,
        groupDmChannels: [],
        defaultRequireMention: true,
        groupPolicy: "open",
        useAccessGroups: false,
        reactionMode: "off",
        reactionAllowlist: [],
        replyToMode: "off",
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
        typingReaction: "",
        mediaMaxBytes: 1024,
        removeAckAfterReply: false,
      });

      // Session updated 1 minute ago (within 60-minute timeout)
      const oneMinuteAgo = Date.now() - 60_000;
      writeSessionTimestamp(
        storePath,
        "agent:main:slack:channel:C123:thread:123.456",
        oneMinuteAgo,
      );

      const result = checkThreadSessionFreshness({
        storePath,
        sessionKey: "agent:main:slack:channel:C123:thread:123.456",
        ctx: slackCtx,
      });

      expect(result.fresh).toBe(true);
    });
  });

  describe("with stale session", () => {
    it("returns false for session updated past idle timeout", () => {
      const storePath = makeStorePath();
      const slackCtx = createSlackMonitorContext({
        cfg: {
          session: { reset: { mode: "idle", idleMinutes: 1 } },
        } as OpenClawConfig,
        accountId: "default",
        botToken: "token",
        app: {} as App,
        runtime: {} as RuntimeEnv,
        botUserId: "B1",
        teamId: "T1",
        apiAppId: "A1",
        historyLimit: 0,
        sessionScope: "per-sender",
        mainKey: "main",
        dmEnabled: true,
        dmPolicy: "open",
        allowFrom: [],
        allowNameMatching: false,
        groupDmEnabled: true,
        groupDmChannels: [],
        defaultRequireMention: true,
        groupPolicy: "open",
        useAccessGroups: false,
        reactionMode: "off",
        reactionAllowlist: [],
        replyToMode: "off",
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
        typingReaction: "",
        mediaMaxBytes: 1024,
        removeAckAfterReply: false,
      });

      // Session updated 2 minutes ago (past 1-minute timeout)
      const twoMinutesAgo = Date.now() - 120_000;
      writeSessionTimestamp(
        storePath,
        "agent:main:slack:channel:C123:thread:123.456",
        twoMinutesAgo,
      );

      const result = checkThreadSessionFreshness({
        storePath,
        sessionKey: "agent:main:slack:channel:C123:thread:123.456",
        ctx: slackCtx,
      });

      expect(result.fresh).toBe(false);
    });

    it("returns false for session updated past daily reset hour", () => {
      const storePath = makeStorePath();
      const now = new Date();
      const currentHour = now.getHours();

      // Use a reset hour that we know has passed today
      // If current hour is >= 4, use 4 AM as reset (already passed today)
      // Otherwise use 10 AM which should also have passed
      const resetHour = currentHour >= 4 ? 4 : 10;

      // Calculate the most recent daily reset time (today at resetHour, or yesterday if resetHour hasn't passed yet)
      const todayAtReset = new Date(now);
      todayAtReset.setHours(resetHour, 0, 0, 0);
      const dailyResetAt =
        now.getTime() < todayAtReset.getTime()
          ? new Date(todayAtReset.getTime() - 24 * 60 * 60 * 1000) // Yesterday at resetHour
          : todayAtReset; // Today at resetHour

      // Session timestamp BEFORE the daily reset (stale)
      const sessionTimestamp = dailyResetAt.getTime() - 60_000; // 1 minute before reset

      const slackCtx = createSlackMonitorContext({
        cfg: {
          session: { reset: { mode: "daily", atHour: resetHour } },
        } as OpenClawConfig,
        accountId: "default",
        botToken: "token",
        app: {} as App,
        runtime: {} as RuntimeEnv,
        botUserId: "B1",
        teamId: "T1",
        apiAppId: "A1",
        historyLimit: 0,
        sessionScope: "per-sender",
        mainKey: "main",
        dmEnabled: true,
        dmPolicy: "open",
        allowFrom: [],
        allowNameMatching: false,
        groupDmEnabled: true,
        groupDmChannels: [],
        defaultRequireMention: true,
        groupPolicy: "open",
        useAccessGroups: false,
        reactionMode: "off",
        reactionAllowlist: [],
        replyToMode: "off",
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
        typingReaction: "",
        mediaMaxBytes: 1024,
        removeAckAfterReply: false,
      });

      writeSessionTimestamp(
        storePath,
        "agent:main:slack:channel:C123:thread:123.456",
        sessionTimestamp,
      );

      const result = checkThreadSessionFreshness({
        storePath,
        sessionKey: "agent:main:slack:channel:C123:thread:123.456",
        ctx: slackCtx,
      });

      // Session before daily reset should be stale
      expect(result.fresh).toBe(false);
    });
  });
});
