import { describe, expect, it } from "vitest";
import { flattenTranslations } from "../../../scripts/lib/control-ui-i18n-sync-plan.ts";
import { SETTINGS_SEARCH_TARGETS } from "../pages/config/settings-targets.ts";
import { useLazyEnglishTest } from "./lazy-english.test-support.ts";

const loadI18n = useLazyEnglishTest();

describe("transcript English loading", () => {
  it.each([
    { surface: "library", load: () => import("../pages/meetings/view.tsx") },
    { surface: "settings", load: () => import("../pages/config/meeting-capture.tsx") },
  ])("keeps startup labels and loads complete fallback copy from $surface", async ({ load }) => {
    const { manager } = await loadI18n();
    const capture = SETTINGS_SEARCH_TARGETS.meetingCapture;
    expect(manager.t(capture.labelKey)).toBe("Meeting capture");
    expect(capture.searchKeys.map((key) => manager.t(key))).toEqual([
      "Choose which sources can save meeting notes on this Gateway.",
      "Auto-start sources",
    ]);
    expect(manager.t("tabs.meetings")).toBe("Meetings");
    expect(manager.t("transcripts.summaryHint")).toBe("transcripts.summaryHint");
    expect(manager.t("meetingCapture.sourceChanged")).toBe("meetingCapture.sourceChanged");

    await manager.setLocale("de");
    await load();
    const { registerTranscriptsEnglish } = await import("./locales/en-transcripts.ts");
    for (const [key, value] of flattenTranslations(registerTranscriptsEnglish.catalog)) {
      expect(manager.t(key)).toBe(value);
    }
    expect(manager.t("common.health")).toBe("Gesundheit");
    expect(manager.t("transcripts.savedCount", { count: "154" })).toBe("154 saved utterances");
    expect(manager.t(capture.labelKey)).toBe("Meeting capture");
  });
});
