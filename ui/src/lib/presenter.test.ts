import { afterEach, describe, expect, it } from "vitest";
// Control UI tests cover cron schedule presentation.
import { contextBudgetStatusFixture } from "../../../src/config/sessions/context-budget.test-support.js";
import type { CronJob } from "../api/types.ts";
import { i18n } from "../i18n/index.ts";
import { formatCronPayload, formatCronSchedule, formatSessionTokens } from "./presenter.ts";

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

describe("formatCronPayload", () => {
  it("formats a Workshop review as an agent turn", () => {
    expect(
      formatCronPayload({
        ...job({ kind: "every", everyMs: 60_000 }),
        payload: { kind: "agentTurn", message: "Review the Workshop collection." },
      }),
    ).toBe("Agent: Review the Workshop collection.");
  });

  it("names a scheduled plugin command instead of its reserved agent-turn placeholder", () => {
    expect(
      formatCronPayload({
        ...job({ kind: "every", everyMs: 60_000 }),
        payload: { kind: "agentTurn", message: "[plugin-command-scheduled-turn:v1]" },
        payloadSource: { kind: "pluginCommand", pluginId: "watcher", command: "watch" },
      }),
    ).toBe("Plugin command: /watch (watcher)");
  });
});

it("formats session detail against its last-run prompt budget", () => {
  expect(
    formatSessionTokens({
      key: "main",
      kind: "direct",
      updatedAt: 2,
      totalTokens: 160_000,
      contextTokens: 200_000,
      contextBudgetStatus: contextBudgetStatusFixture(),
    }),
  ).toBe("160000 / 180000");
});
