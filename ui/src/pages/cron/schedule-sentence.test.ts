import { describe, expect, it } from "vitest";
import {
  formatCronSentence,
  formSentenceFrequency,
  parseCronSentence,
  sentenceForFrequency,
  type CronSentence,
} from "./schedule-sentence.ts";

describe("schedule sentence", () => {
  it.each<[string, CronSentence]>([
    ["0 * * * *", { frequency: "hourly", days: [0, 1, 2, 3, 4, 5, 6], hours: null }],
    ["0 9-18 * * 4-6", { frequency: "hourly", days: [4, 5, 6], hours: { from: 9, until: 18 } }],
    ["30 9 * * *", { frequency: "daily", days: [0, 1, 2, 3, 4, 5, 6], hour: 9, minute: 30 }],
    ["38 12 * * 1-5", { frequency: "daily", days: [1, 2, 3, 4, 5], hour: 12, minute: 38 }],
    ["0 8 * * 0,6", { frequency: "daily", days: [0, 6], hour: 8, minute: 0 }],
    ["15 7 * * 1", { frequency: "weekly", day: 1, hour: 7, minute: 15 }],
    ["0 6 15 * *", { frequency: "monthly", dayOfMonth: 15, hour: 6, minute: 0 }],
  ])("reads %s and writes it back unchanged", (expression, sentence) => {
    expect(parseCronSentence(expression)).toEqual(sentence);
    expect(formatCronSentence(sentence)).toBe(expression);
  });

  it("reads equivalent spellings and writes their canonical form", () => {
    expect(formatCronSentence(parseCronSentence(" 0  9  *  *  7 ")!)).toBe("0 9 * * 0");
    expect(formatCronSentence(parseCronSentence("0 9 * * 5,1,2,3,4")!)).toBe("0 9 * * 1-5");
    expect(formatCronSentence(parseCronSentence("0 9 * * 0-6")!)).toBe("0 9 * * *");
  });

  it.each([
    "",
    "*/15 * * * *",
    "30 * * * *",
    "0 9 * 1 *",
    "0 9 1 * 1",
    "0 9,17 * * *",
    "0 18-9 * * *",
    "0 9 * * MON",
    "0 9 L * *",
    "0 0 9 * * *",
    "0 9 32 * *",
  ])("leaves %j to Custom", (expression) => {
    expect(parseCronSentence(expression)).toBeNull();
    expect(formSentenceFrequency({ scheduleKind: "cron", cronExpr: expression })).toBe("custom");
  });

  it("names each existing schedule kind", () => {
    expect(formSentenceFrequency({ scheduleKind: "at", cronExpr: "" })).toBe("once");
    expect(formSentenceFrequency({ scheduleKind: "every", cronExpr: "" })).toBe("every");
    expect(formSentenceFrequency({ scheduleKind: "cron", cronExpr: "0 9 * * *" })).toBe("daily");
    expect(formSentenceFrequency({ scheduleKind: "event", cronExpr: "" })).toBeNull();
    expect(formSentenceFrequency({ scheduleKind: "on-exit", cronExpr: "" })).toBeNull();
    expect(formSentenceFrequency({ scheduleKind: "stream", cronExpr: "" })).toBeNull();
  });

  it("keeps the time and days when the frequency changes", () => {
    const daily = parseCronSentence("38 12 * * 1-5");
    expect(formatCronSentence(sentenceForFrequency("weekly", daily))).toBe("38 12 * * 1");
    expect(formatCronSentence(sentenceForFrequency("monthly", daily))).toBe("38 12 1 * *");
    expect(formatCronSentence(sentenceForFrequency("hourly", daily))).toBe("0 * * * 1-5");
    const weekly = parseCronSentence("15 7 * * 3");
    expect(formatCronSentence(sentenceForFrequency("daily", weekly))).toBe("15 7 * * 3");
    expect(formatCronSentence(sentenceForFrequency("daily", null))).toBe("0 9 * * *");
  });

  it.each<[number[], string]>([
    [[], "*"],
    [[1, 3], "1,3"],
    [[0, 1, 2, 5], "0-2,5"],
  ])("writes days %j as a cron list", (days, expected) => {
    expect(formatCronSentence({ frequency: "daily", days, hour: 9, minute: 0 })).toBe(
      `0 9 * * ${expected}`,
    );
  });
});
