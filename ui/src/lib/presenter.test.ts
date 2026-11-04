import { afterEach, describe, expect, it, vi } from "vitest";
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
    vi.restoreAllMocks();
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
    expect(formatCronSchedule(job({ kind: "every", everyMs: 90_001 }))).toBe(
      i18n.t("cron.scheduleLabel.every", { duration: expected }),
    );
  });

  it("reads schedule wording from the locale catalog", () => {
    vi.spyOn(i18n, "t").mockImplementation(
      (key, p) => `<${key} ${Object.values(p ?? {}).join("|")}>`,
    );
    const label = (schedule: CronJob["schedule"]) => formatCronSchedule(job(schedule));
    expect(label({ kind: "cron", expr: "0 9 * * *", tz: "UTC" })).toBe(
      "<cron.scheduleLabel.withTimeZone <cron.scheduleLabel.cron 0 9 * * *>|UTC>",
    );
    expect(label({ kind: "on-exit", command: "make", cwd: "/repo" })).toBe(
      "<cron.scheduleLabel.withCwd <cron.scheduleLabel.onExit make>|/repo>",
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
