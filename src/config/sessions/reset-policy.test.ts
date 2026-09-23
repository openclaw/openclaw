// Session reset policy tests cover defaults, opt-in schedules, and compatibility overrides.
import { describe, expect, it } from "vitest";
import { execNodeEvalSync } from "../../test-utils/node-process.js";
import { SessionSchema } from "../zod-schema.session.js";
import { evaluateSessionFreshness, resolveSessionResetPolicy } from "./reset-policy.js";
import { resolveChannelResetConfig } from "./reset.js";

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

describe("session reset policy", () => {
  it.each([
    {
      name: "a long inactivity gap",
      startedAt: new Date(2025, 0, 1, 12, 0, 0, 0).getTime(),
      now: new Date(2026, 0, 1, 12, 0, 0, 0).getTime(),
    },
    {
      name: "a midnight boundary",
      startedAt: new Date(2026, 0, 17, 23, 0, 0, 0).getTime(),
      now: new Date(2026, 0, 18, 5, 0, 0, 0).getTime(),
    },
  ])("keeps the default policy fresh across $name", ({ startedAt, now }) => {
    const policy = resolveSessionResetPolicy({ resetType: "direct" });

    expect(policy.mode).toBe("none");
    expect(
      evaluateSessionFreshness({
        updatedAt: startedAt,
        sessionStartedAt: startedAt,
        lastInteractionAt: startedAt,
        now,
        policy,
      }),
    ).toEqual({ fresh: true });
  });

  it("honors a pending legacy reset tombstone under the default policy", () => {
    const policy = resolveSessionResetPolicy({ resetType: "direct" });

    expect(evaluateSessionFreshness({ updatedAt: 0, now: DAY_MS, policy })).toEqual({
      fresh: false,
    });
  });

  it("resets an explicit daily policy at its configured hour", () => {
    const now = new Date(2026, 0, 18, 5, 0, 0, 0).getTime();
    const startedAt = new Date(2026, 0, 18, 3, 0, 0, 0).getTime();
    const policy = resolveSessionResetPolicy({
      sessionCfg: { reset: { mode: "daily", atHour: 4 } },
      resetType: "direct",
    });

    expect(
      evaluateSessionFreshness({ updatedAt: startedAt, sessionStartedAt: startedAt, now, policy }),
    ).toMatchObject({ fresh: false, staleReason: "daily" });
  });

  it.each([
    {
      name: "before New York's spring gap",
      timezone: "America/New_York",
      now: "2027-03-14T06:00:00Z",
      startedAt: "2027-03-13T07:30:00Z",
      atHour: 2,
      boundary: "2027-03-13T07:00:00Z",
      fresh: true,
    },
    {
      name: "before Lord Howe's half-hour spring gap",
      timezone: "Australia/Lord_Howe",
      now: "2026-10-03T14:30:00Z",
      startedAt: "2026-10-02T15:45:00Z",
      atHour: 2,
      boundary: "2026-10-02T15:30:00Z",
      fresh: true,
    },
    {
      name: "after New York's spring gap",
      timezone: "America/New_York",
      now: "2027-03-14T07:15:00Z",
      startedAt: "2027-03-14T06:30:00Z",
      atHour: 2,
      boundary: "2027-03-14T07:00:00Z",
      fresh: false,
    },
    {
      name: "the day after New York's spring gap",
      timezone: "America/New_York",
      now: "2027-03-15T05:00:00Z",
      startedAt: "2027-03-14T07:30:00Z",
      atHour: 2,
      boundary: "2027-03-14T07:00:00Z",
      fresh: true,
    },
    {
      name: "during New York's repeated hour",
      timezone: "America/New_York",
      now: "2026-11-01T06:15:00Z",
      startedAt: "2026-11-01T05:30:00Z",
      atHour: 1,
      boundary: "2026-11-01T05:00:00Z",
      fresh: true,
    },
    {
      name: "before an ordinary UTC reset",
      timezone: "UTC",
      now: "2027-03-14T01:00:00Z",
      startedAt: "2027-03-13T02:30:00Z",
      atHour: 2,
      boundary: "2027-03-13T02:00:00Z",
      fresh: true,
    },
    {
      name: "before Nuuk's spring gap crosses midnight",
      timezone: "America/Nuuk",
      now: "2027-03-28T00:30:00Z",
      startedAt: "2027-03-27T01:30:00Z",
      atHour: 23,
      boundary: "2027-03-27T01:00:00Z",
      fresh: true,
    },
    {
      name: "after Troll's two-hour fold rewinds past the reset hour",
      timezone: "Antarctica/Troll",
      now: "2026-10-25T01:30:00Z",
      startedAt: "2026-10-24T23:30:00Z",
      atHour: 2,
      boundary: "2026-10-25T00:00:00Z",
      fresh: false,
    },
  ])(
    "uses the configured local reset hour $name",
    ({ timezone, now, startedAt, atHour, boundary, fresh }) => {
      // Native Date captures the host timezone in each process; Vitest workers
      // cannot reliably change it through a late process.env.TZ assignment.
      const output = execNodeEvalSync(
        `import { evaluateSessionFreshness } from ${JSON.stringify(new URL("./reset-policy.ts", import.meta.url).href)};
       console.log(JSON.stringify(evaluateSessionFreshness(${JSON.stringify({
         updatedAt: Date.parse(startedAt),
         sessionStartedAt: Date.parse(startedAt),
         now: Date.parse(now),
         policy: { mode: "daily", atHour },
       })})));`,
        { env: { ...process.env, TZ: timezone }, timeout: 10_000 },
      );
      expect(JSON.parse(output)).toMatchObject({ fresh, dailyResetAt: Date.parse(boundary) });
    },
  );

  it.each([
    {
      name: "the base reset",
      sessionCfg: { reset: { atHour: 6 } },
      resetType: "direct" as const,
    },
    {
      name: "a type override",
      sessionCfg: { resetByType: { group: { atHour: 6 } } },
      resetType: "group" as const,
    },
    {
      name: "a type override above a disabled base policy",
      sessionCfg: {
        reset: { mode: "none" as const },
        resetByType: { group: { atHour: 6 } },
      },
      resetType: "group" as const,
    },
  ])("preserves the daily fallback when $name omits mode", ({ sessionCfg, resetType }) => {
    expect(resolveSessionResetPolicy({ sessionCfg, resetType })).toMatchObject({
      mode: "daily",
      atHour: 6,
    });
  });

  it("preserves combined daily and idle expiry when an explicit reset omits mode", () => {
    expect(
      resolveSessionResetPolicy({
        sessionCfg: { reset: { idleMinutes: 30 } },
        resetType: "direct",
      }),
    ).toMatchObject({ mode: "daily", idleMinutes: 30 });
  });

  it("inherits an active base mode for partial type overrides", () => {
    expect(
      resolveSessionResetPolicy({
        sessionCfg: {
          reset: { mode: "idle", idleMinutes: 60 },
          resetByType: { group: { idleMinutes: 30 } },
        },
        resetType: "group",
      }),
    ).toMatchObject({ mode: "idle", idleMinutes: 30 });
  });

  it("expires an explicit idle policy after inactivity", () => {
    const now = 10 * HOUR_MS;
    const lastInteractionAt = now - 31 * 60_000;
    const policy = resolveSessionResetPolicy({
      sessionCfg: { reset: { mode: "idle", idleMinutes: 30 } },
      resetType: "direct",
    });

    expect(
      evaluateSessionFreshness({ updatedAt: now, lastInteractionAt, now, policy }),
    ).toMatchObject({ fresh: false, staleReason: "idle" });
  });

  it("applies resetByType only to the matching session type", () => {
    const sessionCfg = {
      resetByType: { group: { mode: "idle" as const, idleMinutes: 30 } },
    };

    expect(resolveSessionResetPolicy({ sessionCfg, resetType: "direct" }).mode).toBe("none");
    expect(resolveSessionResetPolicy({ sessionCfg, resetType: "group" })).toMatchObject({
      mode: "idle",
      idleMinutes: 30,
    });
  });

  it("applies a resetByChannel override ahead of the default policy", () => {
    const sessionCfg = {
      resetByChannel: { discord: { mode: "daily" as const, atHour: 6 } },
    };
    const resetOverride = resolveChannelResetConfig({ sessionCfg, channel: "discord" });

    expect(
      resolveSessionResetPolicy({ sessionCfg, resetType: "direct", resetOverride }),
    ).toMatchObject({ mode: "daily", atHour: 6, configured: true });

    const modeLessSessionCfg = {
      reset: { mode: "none" as const },
      resetByChannel: { discord: { atHour: 7 } },
    };
    const modeLessOverride = resolveChannelResetConfig({
      sessionCfg: modeLessSessionCfg,
      channel: "discord",
    });

    expect(
      resolveSessionResetPolicy({
        sessionCfg: modeLessSessionCfg,
        resetType: "direct",
        resetOverride: modeLessOverride,
      }),
    ).toMatchObject({ mode: "daily", atHour: 7, configured: true });
  });

  it("accepts none in the session schema and ignores reset deadlines", () => {
    const sessionCfg = SessionSchema.parse({
      reset: { mode: "none", atHour: 4, idleMinutes: 30 },
    });
    const policy = resolveSessionResetPolicy({
      sessionCfg: { reset: sessionCfg?.reset },
      resetType: "direct",
    });

    expect(evaluateSessionFreshness({ updatedAt: 1, now: DAY_MS, policy })).toEqual({
      fresh: true,
    });
  });
});
