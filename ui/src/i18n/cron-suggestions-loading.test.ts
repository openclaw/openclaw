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

  await manager.setLocale("de");
  const { CRON_SUGGESTIONS, suggestionFormPatch } = await import("../pages/cron/suggestions.ts");
  expect(manager.t("cron.suggestions.title")).toBe("Starter-Automatisierungen");
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
