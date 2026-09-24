import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hasInternalDiagnosticEventInterest } from "../../infra/diagnostic-event-listener-presence.js";
import {
  emitDiagnosticEvent,
  emitTrustedSkillUsedDiagnosticEvent,
  resetDiagnosticEventsForTest,
  waitForDiagnosticEventsDrained,
} from "../../infra/diagnostic-events.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { recordSkillExperienceReviewOutcome } from "./collection-review-state.js";
import { getSkillCuratorStatus, registerSkillUsageTracking } from "./curator.js";
import { resolveWorkshopSkillsDir } from "./skills-root.js";

const { warnings } = vi.hoisted(() => ({ warnings: vi.fn() }));
vi.mock("../../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) => {
      const logger = actual.createSubsystemLogger(subsystem);
      return subsystem === "skills/curator" ? { ...logger, warn: warnings } : logger;
    },
  };
});

let testState: OpenClawTestState;

beforeEach(async () => {
  resetDiagnosticEventsForTest();
  warnings.mockClear();
  testState = await createOpenClawTestState({
    layout: "home",
    prefix: "openclaw-skill-curator-",
  });
});

afterEach(async () => {
  resetDiagnosticEventsForTest();
  await closeOpenClawStateDatabaseAsync();
  vi.restoreAllMocks();
  closeOpenClawStateDatabaseForTest();
  await testState.cleanup();
});

describe("skill curator usage tracking", () => {
  it("settles accepted trusted usage and reads live status without caller SQL", async () => {
    const config = {};
    const skillDir = path.join(
      resolveWorkshopSkillsDir(config, "main", testState.env),
      "daily-brief",
    );
    const skillFile = path.join(skillDir, "SKILL.md");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      skillFile,
      "---\nname: daily-brief\ndescription: Synthetic usage proof.\n---\n# Daily brief\n",
    );
    openOpenClawStateDatabase({ env: testState.env });
    await recordSkillExperienceReviewOutcome(
      "main",
      skillDir,
      { attemptedAtMs: 1200, outcome: "nothing" },
      { env: testState.env },
    );
    await closeOpenClawStateDatabaseAsync();
    const sql = observeMainThreadSql();
    const unregister = registerSkillUsageTracking({ env: testState.env });
    try {
      emitTrustedSkillUsedDiagnosticEvent(
        {
          type: "skill.used",
          skillName: "daily-brief",
          skillSource: "workspace",
          activation: "read",
          agentId: "main",
        },
        { skillUsage: { skillFile } },
      );
      await waitForDiagnosticEventsDrained();
      await unregister();
      const status = await getSkillCuratorStatus({ config, env: testState.env });
      expect(status.skills).toEqual([expect.objectContaining({ skillFile, useCount: 1 })]);
      expect(
        Object.values(expectDefined(status.experienceReview, "curator review outcomes")),
      ).toEqual([{ attemptedAtMs: 1200, outcome: "nothing" }]);
      sql.expectIdle();
    } finally {
      await unregister();
      sql.restore();
    }
  });

  it("contains a rejected worker write and settles later accepted usage", async () => {
    const database = openOpenClawStateDatabase({ env: testState.env });
    const skillFile = testState.path("skills", "accepted", "SKILL.md");
    const unregister = registerSkillUsageTracking({ env: testState.env });
    try {
      const clock = vi.spyOn(Date, "now");
      for (const [skillName, timestamp] of [
        ["reject", 1.5],
        ["accepted", 1000],
      ] as const) {
        clock.mockReturnValue(timestamp);
        emitTrustedSkillUsedDiagnosticEvent(
          {
            type: "skill.used",
            skillName,
            skillSource: "workspace",
            activation: "read",
            agentId: "main",
          },
          { skillUsage: { skillFile } },
        );
      }
      clock.mockRestore();
      await waitForDiagnosticEventsDrained();
      await expect(unregister()).resolves.toBeUndefined();
      expect(warnings.mock.calls).toEqual([[expect.stringContaining("skill_usage")]]);
      expect(database.db.prepare("SELECT skill_name, use_count FROM skill_usage").all()).toEqual([
        { skill_name: "accepted", use_count: 1 },
      ]);
    } finally {
      await unregister();
    }
  });

  it("persists trusted skill usage by absolute file identity and increments repeated use", async () => {
    const database = openOpenClawStateDatabase({ env: testState.env });
    const skillFile = testState.path("skills", "daily-brief", "SKILL.md");
    let unregister = registerSkillUsageTracking({ env: testState.env });
    expect(hasInternalDiagnosticEventInterest("skill.used")).toBe(true);
    expect(hasInternalDiagnosticEventInterest("gateway.rpc")).toBe(false);
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const event = {
      type: "skill.used",
      skillName: "Daily Brief",
      skillSource: "workspace",
      activation: "read",
      agentId: "first-agent",
    } as const;

    emitTrustedSkillUsedDiagnosticEvent(event, { skillUsage: { skillFile } });
    await waitForDiagnosticEventsDrained();
    await unregister();
    unregister = registerSkillUsageTracking({ env: testState.env });

    expect(
      database.db
        .prepare(
          "SELECT first_used_at_ms, last_used_at_ms, use_count, last_agent_id FROM skill_usage WHERE skill_file = ?",
        )
        .get(skillFile),
    ).toEqual({
      first_used_at_ms: 1_000,
      last_used_at_ms: 1_000,
      use_count: 1,
      last_agent_id: "first-agent",
    });

    now.mockReturnValue(2_000);
    emitTrustedSkillUsedDiagnosticEvent(
      { ...event, agentId: "second-agent" },
      { skillUsage: { skillFile } },
    );
    emitTrustedSkillUsedDiagnosticEvent(event, {
      skillUsage: { skillFile: "skills/relative/SKILL.md" },
    });
    emitDiagnosticEvent({ ...event, skillName: "Untrusted Skill" });
    await waitForDiagnosticEventsDrained();
    await unregister();
    unregister = registerSkillUsageTracking({ env: testState.env });

    expect(
      database.db
        .prepare(
          "SELECT first_used_at_ms, last_used_at_ms, use_count, last_agent_id FROM skill_usage WHERE skill_file = ?",
        )
        .get(skillFile),
    ).toEqual({
      first_used_at_ms: 1_000,
      last_used_at_ms: 2_000,
      use_count: 2,
      last_agent_id: "second-agent",
    });
    expect(database.db.prepare("SELECT count(*) AS count FROM skill_usage").get()).toEqual({
      count: 1,
    });

    now.mockReturnValue(500);
    emitTrustedSkillUsedDiagnosticEvent(
      { ...event, agentId: "earlier-agent" },
      { skillUsage: { skillFile } },
    );
    await waitForDiagnosticEventsDrained();
    await unregister();
    expect(
      database.db
        .prepare(
          "SELECT first_used_at_ms, last_used_at_ms, use_count, last_agent_id FROM skill_usage WHERE skill_file = ?",
        )
        .get(skillFile),
    ).toEqual({
      first_used_at_ms: 500,
      last_used_at_ms: 2_000,
      use_count: 3,
      last_agent_id: "second-agent",
    });

    await unregister();
    expect(hasInternalDiagnosticEventInterest("skill.used")).toBe(false);
    emitTrustedSkillUsedDiagnosticEvent(event, { skillUsage: { skillFile } });
    await waitForDiagnosticEventsDrained();
    await unregister();
    expect(
      database.db.prepare("SELECT use_count FROM skill_usage WHERE skill_file = ?").get(skillFile),
    ).toEqual({ use_count: 3 });
  });
});
