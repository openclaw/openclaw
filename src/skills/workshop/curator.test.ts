import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hasInternalDiagnosticEventInterest } from "../../infra/diagnostic-event-listener-presence.js";
import {
  emitDiagnosticEvent,
  emitTrustedSkillUsedDiagnosticEvent,
  resetDiagnosticEventsForTest,
  waitForDiagnosticEventsDrained,
} from "../../infra/diagnostic-events.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { registerSkillUsageTracking } from "./curator.js";

let testState: OpenClawTestState;

beforeEach(async () => {
  resetDiagnosticEventsForTest();
  testState = await createOpenClawTestState({
    layout: "home",
    prefix: "openclaw-skill-curator-",
  });
});

afterEach(async () => {
  resetDiagnosticEventsForTest();
  vi.restoreAllMocks();
  closeOpenClawStateDatabaseForTest();
  await testState.cleanup();
});

describe("skill curator usage tracking", () => {
  it("persists trusted skill usage by absolute file identity and increments repeated use", async () => {
    const database = openOpenClawStateDatabase({ env: testState.env });
    const skillFile = testState.path("skills", "daily-brief", "SKILL.md");
    const unregister = registerSkillUsageTracking({ env: testState.env });
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

    unregister();
    expect(hasInternalDiagnosticEventInterest("skill.used")).toBe(false);
    emitTrustedSkillUsedDiagnosticEvent(event, { skillUsage: { skillFile } });
    await waitForDiagnosticEventsDrained();
    expect(
      database.db.prepare("SELECT use_count FROM skill_usage WHERE skill_file = ?").get(skillFile),
    ).toEqual({ use_count: 3 });
  });
});
