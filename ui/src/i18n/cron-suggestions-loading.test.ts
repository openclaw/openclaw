/* @vitest-environment jsdom */

import { expect, it } from "vitest";
import { useLazyEnglishTest } from "./lazy-english.test-support.ts";

const loadI18n = useLazyEnglishTest();

it("keeps automation starters out of startup and registers fallback before prefilling a form", async () => {
  const { manager } = await loadI18n({
    cron: { suggestions: { title: "Starter-Automatisierungen" } },
  });
  expect(manager.t("tabs.cron")).toBe("Automations");
  expect(manager.t("cron.suggestions.title")).toBe("cron.suggestions.title");
  expect(manager.t("cron.form.createTask")).toBe("cron.form.createTask");
  expect(manager.t("cron.errors.agentMessageRequiredShort")).toBe(
    "cron.errors.agentMessageRequiredShort",
  );

  await manager.setLocale("de");
  const { CRON_SUGGESTIONS, suggestionFormPatch } = await import("../pages/cron/suggestions.ts");
  expect(manager.t("cron.suggestions.title")).toBe("Starter-Automatisierungen");
  expect(manager.t("cron.form.createTask")).toBe("Create automation");
  expect(manager.t("cron.errors.agentMessageRequiredShort")).toBe("Agent message required.");
  expect(manager.t("cron.suggestions.schedules.weekdayMornings")).toBe("Weekdays at 9:00 AM");
  expect(manager.t("tabs.cron")).toBe("Automations");
  for (const idea of CRON_SUGGESTIONS) {
    const patch = suggestionFormPatch(idea);
    expect(patch.name).not.toBe(idea.nameKey);
    expect(patch.payloadText).not.toBe(idea.promptKey);
    expect(patch.payloadText).toBeTruthy();
    expect(patch.payloadKind).toBe("agentTurn");
  }
  expect(suggestionFormPatch(CRON_SUGGESTIONS[0]!)).toMatchObject({
    name: "Repo pulse",
    scheduleKind: "cron",
    cronExpr: "0 9 * * 1-5",
  });
});

it("loads schedule validation copy with the schedule owner", async () => {
  const { manager } = await loadI18n();
  expect(manager.t("cron.errors.invalidRunTime")).toBe("cron.errors.invalidRunTime");

  const { buildCronSchedule } = await import("../lib/cron/form-schedule.ts");
  const { DEFAULT_CRON_FORM } = await import("../lib/cron/state.ts");
  expect(() =>
    buildCronSchedule({ ...DEFAULT_CRON_FORM, scheduleKind: "at", scheduleAt: "invalid" }),
  ).toThrow("Invalid run time.");
});

it("loads payload validation copy with the payload owner", async () => {
  const { manager } = await loadI18n();
  expect(manager.t("cron.errors.systemEventTextRequired")).toBe(
    "cron.errors.systemEventTextRequired",
  );

  const { buildCronPayload } = await import("../lib/cron/payload.ts");
  const { DEFAULT_CRON_FORM } = await import("../lib/cron/state.ts");
  expect(() =>
    buildCronPayload(
      { ...DEFAULT_CRON_FORM, payloadKind: "systemEvent", payloadText: "" },
      null,
      false,
    ),
  ).toThrow("System event text required.");
});

it("loads run outcome copy with the feedback owner", async () => {
  const { manager } = await loadI18n();
  expect(manager.t("cron.runNotStarted.notDue")).toBe("cron.runNotStarted.notDue");

  const { cronRunNotStartedMessage } = await import("../lib/cron/run-feedback.ts");
  expect(cronRunNotStartedMessage({ ok: true, ran: false, reason: "not-due" })).toBe(
    "This automation is not due yet.",
  );
});
