/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureI18nStateForTesting,
  createI18nManagerForTesting,
} from "./lib/translate.test-support.ts";
import { en } from "./locales/en.ts";

vi.hoisted(() => vi.resetModules());
const startupCron = structuredClone(expectDefined(en.cron, "Cron catalog anchor"));
let restoreI18n: () => Promise<void>;

beforeEach(() => {
  restoreI18n = captureI18nStateForTesting();
});

afterEach(async () => {
  en.cron = structuredClone(startupCron);
  await restoreI18n();
});

afterAll(async () => {
  const { registerCronEnglish } = await import("./locales/en-cron.ts");
  registerCronEnglish();
});

describe("Automation starter English loading", () => {
  it("keeps starters out of startup and registers fallback before prefilling a form", async () => {
    const manager = createI18nManagerForTesting(async () => ({
      cron: { suggestions: { title: "Starter-Automatisierungen" } },
    }));
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
});
