import { expect, it } from "vitest";
import { execNodeEvalSync } from "../../test-utils/node-process.js";
import { SessionSchema } from "../zod-schema.session.js";
import { evaluateSessionFreshness, resolveSessionResetPolicy } from "./reset-policy.js";
import { resolveChannelResetConfig } from "./reset.js";

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

it("honors a pending legacy reset tombstone under the default policy", () => {
  const policy = resolveSessionResetPolicy({ resetType: "direct" });

  expect(evaluateSessionFreshness({ updatedAt: 0, now: DAY_MS, policy })).toEqual({
    fresh: false,
  });
});

it.each`
  name                                                         | timezone                 | now                       | startedAt                 | atHour | boundary                  | fresh
  ${"before New York's spring gap"}                            | ${"America/New_York"}    | ${"2027-03-14T06:00:00Z"} | ${"2027-03-13T07:30:00Z"} | ${2}   | ${"2027-03-13T07:00:00Z"} | ${true}
  ${"before Lord Howe's half-hour spring gap"}                 | ${"Australia/Lord_Howe"} | ${"2026-10-03T14:30:00Z"} | ${"2026-10-02T15:45:00Z"} | ${2}   | ${"2026-10-02T15:30:00Z"} | ${true}
  ${"after New York's spring gap"}                             | ${"America/New_York"}    | ${"2027-03-14T07:15:00Z"} | ${"2027-03-14T06:30:00Z"} | ${2}   | ${"2027-03-14T07:00:00Z"} | ${false}
  ${"the day after New York's spring gap"}                     | ${"America/New_York"}    | ${"2027-03-15T05:00:00Z"} | ${"2027-03-14T07:30:00Z"} | ${2}   | ${"2027-03-14T07:00:00Z"} | ${true}
  ${"during New York's repeated hour"}                         | ${"America/New_York"}    | ${"2026-11-01T06:15:00Z"} | ${"2026-11-01T05:30:00Z"} | ${1}   | ${"2026-11-01T05:00:00Z"} | ${true}
  ${"before Nuuk's spring gap crosses midnight"}               | ${"America/Nuuk"}        | ${"2027-03-28T00:30:00Z"} | ${"2027-03-27T01:30:00Z"} | ${23}  | ${"2027-03-27T01:00:00Z"} | ${true}
  ${"after Troll's two-hour fold rewinds past the reset hour"} | ${"Antarctica/Troll"}    | ${"2026-10-25T01:30:00Z"} | ${"2026-10-24T23:30:00Z"} | ${2}   | ${"2026-10-25T00:00:00Z"} | ${false}
`(
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
      {
        env: { ...process.env, TZ: timezone },
        imports: [new URL("../../../scripts/tsx.mjs", import.meta.url).href],
        timeout: 10_000,
      },
    );
    expect(JSON.parse(output)).toMatchObject({ fresh, dailyResetAt: Date.parse(boundary) });
  },
);

it("preserves the daily fallback when a type override above a disabled base omits mode", () => {
  expect(
    resolveSessionResetPolicy({
      sessionCfg: { reset: { mode: "none" }, resetByType: { group: { atHour: 6 } } },
      resetType: "group",
    }),
  ).toMatchObject({ mode: "daily", atHour: 6 });
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

it.each([
  [{ resetByChannel: { discord: { mode: "daily", atHour: 6 } } }, 6],
  [{ reset: { mode: "none" }, resetByChannel: { discord: { atHour: 7 } } }, 7],
] as const)(
  "applies resetByChannel override %# ahead of the default policy",
  (sessionCfg, atHour) => {
    const resetOverride = resolveChannelResetConfig({ sessionCfg, channel: "discord" });
    expect(
      resolveSessionResetPolicy({ sessionCfg, resetType: "direct", resetOverride }),
    ).toMatchObject({ mode: "daily", atHour, configured: true });
  },
);

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
