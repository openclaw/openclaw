import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flattenTranslations } from "../../../../../scripts/lib/control-ui-i18n-sync-plan.ts";
import { i18n } from "../../../i18n/index.ts";
import { captureI18nStateForTesting } from "../../../i18n/lib/translate.test-support.ts";
import { de } from "../../../i18n/locales/de.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { renderFallbackIndicatorSolid } from "./chat-composer-status.tsx";

describe("chat composer status localization", () => {
  let restoreI18nState: () => Promise<void>;

  beforeEach(async () => {
    restoreI18nState = captureI18nStateForTesting();
    await i18n.setLocale("de");
    vi.spyOn(Date, "now").mockReturnValue(1_000);
  });

  afterEach(async () => {
    await restoreI18nState();
    vi.restoreAllMocks();
  });

  it("renders translated fallback status", () => {
    const view = mountSolid(() =>
      renderFallbackIndicatorSolid({
        selected: "provider/selected",
        active: "provider/active",
        attempts: ["provider/selected: rate limit"],
        occurredAt: 900,
      }),
    );
    const fallback = view.container.querySelector(".compaction-indicator--fallback");
    const german = flattenTranslations(de);
    expect(fallback?.textContent?.trim()).toBe(
      german.get("chat.composer.fallbackActive")?.replace("{model}", "provider/active"),
    );
    expect(fallback?.getAttribute("aria-label")).toBe(
      [
        german.get("chat.composer.fallbackSelected")?.replace("{model}", "provider/selected"),
        german.get("chat.composer.fallbackCurrent")?.replace("{model}", "provider/active"),
        german
          .get("chat.composer.fallbackAttempts")
          ?.replace("{attempts}", "provider/selected: rate limit"),
      ].join(" • "),
    );
  });
});
