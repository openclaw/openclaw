// Fuzz-style coverage for the maintenance policy resolver.
//
// Rather than install fast-check (the project does not depend on it), this
// file uses a small ad-hoc generator + invariants to exercise the resolver
// with random timezones, random wall-clock windows, and random "now"
// instants across years 2020-2030. Each generated input is checked
// against invariants that must hold for every well-formed configuration.
//
// Invariants under test:
//   1. The resolver is deterministic: same inputs => same output.
//   2. The phase is one of "normal" or "maintenance".
//   3. If phase=normal, allowed=true.
//   4. If phase=maintenance, allowed iff the agent's id is in the
//      (non-null) roster. An empty roster => allowed=false.
//   5. nextPhaseChangeMs, when defined, is strictly greater than nowMs.
//   6. nextPhaseChangeMs, when defined, is finite.
//   7. resolveMaintenancePhaseForCron with the same params returns the
//      same phase / allowed / nextPhaseChangeMs as the wrapped
//      resolveMaintenancePhase call.
//   8. isManualRunAllowed with the same nowMs + cfg returns true when
//      phase=normal, regardless of agentId.
//   9. isManualRunAllowed with the same nowMs + cfg returns true when
//      phase=maintenance AND (allowManualRun=true OR agentId in roster).
//  10. isManualRunAllowed with the same nowMs + cfg returns false when
//      phase=maintenance AND allowManualRun=false AND agentId not in roster.
import { describe, expect, it } from "vitest";
import type { CronMaintenanceConfig } from "../config/types.cron.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  isManualRunAllowed,
  resolveMaintenancePhase,
  resolveMaintenancePhaseForCron,
} from "./maintenance-policy.js";

// 30 IANA timezones covering a wide range of offsets, DST rules, and
// half/quarter-hour offsets.
const TIMEZONES = [
  "UTC",
  "America/Los_Angeles",
  "America/New_York",
  "America/Sao_Paulo",
  "America/Anchorage",
  "Pacific/Honolulu",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Moscow",
  "Africa/Lagos",
  "Africa/Johannesburg",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Kathmandu",
  "Asia/Bangkok",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Asia/Seoul",
  "Australia/Sydney",
  "Australia/Adelaide",
  "Pacific/Auckland",
  "Pacific/Chatham", // +12:45
  "Asia/Kathmandu", // +5:45
  "Asia/Kolkata", // +5:30
  "America/St_Johns", // -3:30
  "America/Goose_Bay",
  "Asia/Tehran", // +3:30 (DST)
  "Asia/Kabul", // +4:30
  "Asia/Yangon", // +6:30
  "Indian/Cocos", // +6:30
  "America/Caracas", // -4:30
];

// 5 wall-clock hour options (00:00, 02:00, 12:00, 23:00, 24:00).
// 24:00 is included to test end-of-day semantics.
const HOURS = [0, 2, 12, 23, 24];
// 5 minute options.
const MINUTES = [0, 15, 30, 45, 59];

// 12 agent ids, including mixed case, with leading/trailing whitespace,
// and a duplicate to test normalization.
const AGENT_IDS = [
  "main",
  "ops",
  "Main",
  " OPS ",
  "agent-with-hyphens",
  "agent_with_underscores",
  "agent/with/slashes",
  "1",
  "0",
  "x".repeat(64),
  "main", // duplicate
  "main", // duplicate again
];

// Seedable PRNG (mulberry32) for deterministic runs.
function makePrng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(arr: readonly T[], rng: () => number): T {
  return arr[Math.floor(rng() * arr.length)]!;
}

function randomMaintenanceCfg(rng: () => number): CronMaintenanceConfig {
  const enabled = rng() > 0.2; // 80% enabled
  const startHour = pick(HOURS, rng);
  const startMin = pick(MINUTES, rng);
  // End is strictly after start in the same day; we filter cross-midnight out
  // by ensuring end > start.
  const endHour = pick(
    HOURS.filter((h) => h > startHour || (h === startHour && pick([1, 15, 30, 45, 59], rng) > 0)),
    rng,
  );
  const endMin = endHour === startHour ? pick([15, 30, 45, 59], rng) : pick(MINUTES, rng);
  const tz = pick(TIMEZONES, rng);
  // 30% empty roster (=> blocks everyone), 50% single-agent, 20% multi.
  const rosterRoll = rng();
  let maintenanceAgents: readonly string[] | undefined;
  if (rosterRoll < 0.3) {
    maintenanceAgents = [];
  } else if (rosterRoll < 0.8) {
    maintenanceAgents = [pick(AGENT_IDS, rng)];
  } else {
    const a = pick(AGENT_IDS, rng);
    const b = pick(AGENT_IDS, rng);
    maintenanceAgents = [a, b];
  }
  const allowManualRun = rng() > 0.5;
  return {
    enabled,
    window: {
      start: `${String(startHour).padStart(2, "0")}:${String(startMin).padStart(2, "0")}`,
      end: `${String(endHour).padStart(2, "0")}:${String(endMin).padStart(2, "0")}`,
      timezone: tz,
    },
    maintenanceAgents,
    allowManualRun,
  };
}

function cfgFor(maintenance: CronMaintenanceConfig): OpenClawConfig {
  return {
    agents: { defaults: { userTimezone: "UTC" } },
    cron: { maintenance },
  };
}

describe("maintenance policy resolver fuzz", () => {
  // Run a fixed number of iterations to keep CI time bounded.
  const ITERATIONS = 200;

  it("invariants hold across 200 random configurations and 12 random agents", () => {
    const rng = makePrng(20260808);
    for (let i = 0; i < ITERATIONS; i++) {
      const maintenance = randomMaintenanceCfg(rng);
      // Skip cross-midnight or invalid configs the policy already rejects.
      if (maintenance.window && maintenance.window.start >= maintenance.window.end) {
        continue;
      }
      const cfg = cfgFor(maintenance);
      const nowMs = Date.UTC(
        2020 + Math.floor(rng() * 11), // 2020..2030
        Math.floor(rng() * 12), // 0..11
        1 + Math.floor(rng() * 28), // 1..28 (avoid month-end edge)
        Math.floor(rng() * 24),
        Math.floor(rng() * 60),
        Math.floor(rng() * 60),
      );
      const agentId = pick(AGENT_IDS, rng);

      // Skip timezones that the runtime can't resolve (rare in modern
      // Intl but possible on stripped-down platforms).
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: maintenance.window!.timezone! }).format(
          new Date(nowMs),
        );
      } catch {
        continue;
      }

      // Invariant 1: deterministic
      const a = resolveMaintenancePhase({ cfg, nowMs, agentId });
      const b = resolveMaintenancePhase({ cfg, nowMs, agentId });
      expect({ phase: a.phase, allowed: a.allowed, nextMs: a.nextPhaseChangeMs }).toEqual({
        phase: b.phase,
        allowed: b.allowed,
        nextMs: b.nextPhaseChangeMs,
      });

      // Invariant 2: phase is one of two values
      expect(["normal", "maintenance"]).toContain(a.phase);

      // Invariant 3: phase=normal => allowed=true
      if (a.phase === "normal") {
        expect(a.allowed).toBe(true);
      }

      // Invariant 4: phase=maintenance => allowed iff in roster
      if (a.phase === "maintenance") {
        const roster = maintenance.maintenanceAgents ?? [];
        const expected =
          roster.length > 0 &&
          roster.map((s) => s.trim().toLowerCase()).includes(agentId.trim().toLowerCase());
        expect(a.allowed).toBe(expected);
      }

      // Invariant 5: nextPhaseChangeMs strictly > nowMs
      if (a.nextPhaseChangeMs !== undefined) {
        expect(a.nextPhaseChangeMs).toBeGreaterThan(nowMs);
      }

      // Invariant 6: nextPhaseChangeMs is finite
      if (a.nextPhaseChangeMs !== undefined) {
        expect(Number.isFinite(a.nextPhaseChangeMs)).toBe(true);
      }

      // Invariant 7: ForCron wrapper agrees
      const c = resolveMaintenancePhaseForCron({
        maintenance,
        userTimezone: "UTC",
        nowMs,
        agentId,
      });
      expect(c.phase).toBe(a.phase);
      expect(c.allowed).toBe(a.allowed);
      expect(c.nextPhaseChangeMs).toBe(a.nextPhaseChangeMs);

      // Invariants 8/9/10: isManualRunAllowed
      const man = isManualRunAllowed({ cfg, nowMs, agentId });
      if (a.phase === "normal") {
        expect(man).toBe(true);
      } else {
        const inRoster = (maintenance.maintenanceAgents ?? [])
          .map((s) => s.trim().toLowerCase())
          .includes(agentId.trim().toLowerCase());
        expect(man).toBe(maintenance.allowManualRun === true || inRoster);
      }
    }
  });
});
