import { afterEach, describe, expect, it, vi } from "vitest";
// Control UI tests cover cron schedule presentation.
import { contextBudgetStatusFixture } from "../../../src/config/sessions/context-budget.test-support.js";
import type { CronJob } from "../api/types.ts";
import { i18n } from "../i18n/index.ts";
import { registerCronEnglish } from "../i18n/locales/en-cron.ts";
import { formatMs } from "./format.ts";
import {
  formatCronPayload,
  formatCronCadence,
  formatCronSchedule,
  formatCronState,
  formatSessionTokens,
} from "./presenter.ts";

registerCronEnglish();

it("routes cron state and payload labels through whole catalog templates", async () => {
  await i18n.setLocale("fr");
  const translate = vi.spyOn(i18n, "t");
  try {
    const cronJob = job({ kind: "every", everyMs: 60_000 });
    cronJob.state = { lastStatus: "ok", lastRunAtMs: 1000, nextRunAtMs: 2000 };
    const expectedState = i18n.t("cron.job.state", {
      status: "ok",
      next: formatMs(2000),
      last: formatMs(1000),
    });
    translate.mockClear();
    expect(formatCronState(cronJob)).toBe(expectedState);
    expect.soft(translate).toHaveBeenCalledWith("cron.job.state", {
      status: "ok",
      next: formatMs(2000),
      last: formatMs(1000),
    });
    const cases: Array<[CronJob["payload"], string, Record<string, string>]> = [
      [{ kind: "systemEvent", text: "User Text" }, "system", { text: "User Text" }],
      [{ kind: "command", argv: ["Run", "--Flag"] }, "command", { command: "Run --Flag" }],
      [{ kind: "script", script: "Echo User Text" }, "script", { script: "Echo User Text" }],
      [{ kind: "agentTurn", message: "User Prompt" }, "agent", { message: "User Prompt" }],
    ];
    for (const [payload, label, params] of cases) {
      cronJob.payload = payload;
      const expectedPayload = i18n.t(`cron.job.${label}`, params);
      translate.mockClear();
      expect(formatCronPayload(cronJob)).toBe(expectedPayload);
      expect.soft(translate).toHaveBeenCalledWith(`cron.job.${label}`, params);
    }
    cronJob.payloadSource = { kind: "pluginCommand", command: "DoThing", pluginId: "Plugin-ID" };
    const params = { command: "DoThing", plugin: "Plugin-ID" };
    const expectedPlugin = i18n.t("cron.job.pluginCommand", params);
    translate.mockClear();
    expect(formatCronPayload(cronJob)).toBe(expectedPlugin);
    expect.soft(translate).toHaveBeenCalledWith("cron.job.pluginCommand", params);
  } finally {
    translate.mockRestore();
    await i18n.setLocale("en");
  }
});

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

describe("formatCronCadence", () => {
  const cadence = (schedule: CronJob["schedule"]) => formatCronCadence({ schedule });
  it("reads common cron shapes as words and keeps others as written", () => {
    const cron = (expr: string) => cadence({ kind: "cron", expr, tz: "UTC" });
    expect(cron("15 * * * *")).toBe("Hourly");
    expect(cron("0 7 * * *")).toBe("Daily");
    expect(cron("30 8 * * 1-5")).toBe("Weekdays");
    expect(cron("0 9 * * 1")).toBe("Weekly");
    expect(cron("0 6 1 * *")).toBe("Monthly");
    expect(cron("0 */6 * * *")).toBe("Every 6 hours");
    expect(cron("*/20 * * * *")).toBe("Every 20 minutes");
    expect(cron("*/7 * * * *")).toBe("*/7 * * * *");
    expect(cron("0 */5 * * *")).toBe("0 */5 * * *");
    expect(cadence({ kind: "every", everyMs: 5 * 3_600_000 })).toBe("Every 5 hours");
    expect(cadence({ kind: "every", everyMs: 3_600_000 })).toBe("Hourly");
    expect(cadence({ kind: "every", everyMs: 24 * 3_600_000 })).toBe("Daily");
    expect(cadence({ kind: "every", everyMs: 7 * 24 * 3_600_000 })).toBe("Weekly");
    expect(cadence({ kind: "every", everyMs: 2 * 24 * 3_600_000 })).toBe("Every 2 days");
    expect(cron("0 9 1 1 *")).toBe("0 9 1 1 *");
    expect(cadence({ kind: "at", at: "2026-11-21T15:00:00.000Z" })).toBe("Once");
  });
});
