// Control UI tests cover cron schedule and session token presentation.
import { afterEach, describe, expect, it } from "vitest";
import type { CronJob, GatewaySessionRow } from "../api/types.ts";
import { i18n } from "../i18n/index.ts";
import {
  CATALOG_CONTEXT_TOKENS,
  COMPACTION_RESERVE_TOKENS,
  createContextBudgetStatusFixture,
  PRESSURED_PROMPT_TOKENS,
  SESSION_CONTEXT_TOKEN_BUDGET,
} from "../test-helpers/context-budget-status-fixture.ts";
import { formatCronSchedule, formatSessionTokens } from "./presenter.ts";

function job(schedule: CronJob["schedule"]): CronJob {
  return {
    id: "job",
    name: "Job",
    enabled: true,
    createdAtMs: 0,
    updatedAtMs: 0,
    schedule,
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text: "test" },
    state: {},
  };
}

describe("formatCronSchedule", () => {
  afterEach(async () => {
    await i18n.setLocale("en");
  });

  it.each([
    { everyMs: 60_000, expected: "Every 1m" },
    { everyMs: 450, expected: "Every 450ms" },
    { everyMs: 90_000, expected: "Every 1m 30s" },
    { everyMs: 3_661_001, expected: "Every 1h 1m 1s 1ms" },
    { everyMs: 604_800_000, expected: "Every 7d" },
  ])("preserves configured duration precision for every $everyMs ms", ({ everyMs, expected }) => {
    expect(formatCronSchedule(job({ kind: "every", everyMs }))).toBe(expected);
  });

  it("localizes configured duration precision", async () => {
    await i18n.setLocale("fr");
    const expected = [
      { value: 1, unit: "minute" },
      { value: 30, unit: "second" },
      { value: 1, unit: "millisecond" },
    ]
      .map(({ value, unit }) =>
        new Intl.NumberFormat("fr", {
          style: "unit",
          unit,
          unitDisplay: "narrow",
          maximumFractionDigits: 0,
        }).format(value),
      )
      .join(" ");
    expect(formatCronSchedule(job({ kind: "every", everyMs: 90_001 }))).toBe(`Every ${expected}`);
  });

  it("formats cron schedules", () => {
    expect(formatCronSchedule(job({ kind: "cron", expr: "0 * * * *" }))).toBe("Cron 0 * * * *");
  });

  it("formats on-exit schedules with the watched command instead of falling through to cron", () => {
    expect(formatCronSchedule(job({ kind: "on-exit", command: "make build" }))).toBe(
      "On exit: make build",
    );
  });

  it("includes the working directory for on-exit schedules when set", () => {
    expect(formatCronSchedule(job({ kind: "on-exit", command: "./watch.sh", cwd: "/repo" }))).toBe(
      "On exit: ./watch.sh (cwd: /repo)",
    );
  });
});

describe("formatSessionTokens", () => {
  function sessionRow(contextBudgetStatus?: GatewaySessionRow["contextBudgetStatus"]) {
    return {
      key: "agent:main:main",
      kind: "direct",
      updatedAt: null,
      totalTokens: PRESSURED_PROMPT_TOKENS,
      contextTokens: CATALOG_CONTEXT_TOKENS,
      contextBudgetStatus,
    } satisfies GatewaySessionRow;
  }

  // The sessions detail row sits directly under the context meter, so it has to
  // name the same limit the meter divides by.
  it("prints the budget compaction triggers on", () => {
    expect(
      formatSessionTokens(
        sessionRow(
          createContextBudgetStatusFixture({
            contextTokenBudget: SESSION_CONTEXT_TOKEN_BUDGET,
            reserveTokens: COMPACTION_RESERVE_TOKENS,
            estimatedPromptTokens: PRESSURED_PROMPT_TOKENS,
          }),
        ),
      ),
    ).toBe("160000 / 180000");
  });

  it("falls back to the catalog window without a budget snapshot", () => {
    expect(formatSessionTokens(sessionRow())).toBe("160000 / 262144");
  });
});
