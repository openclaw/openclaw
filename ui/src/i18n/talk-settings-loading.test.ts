import { expect, it } from "vitest";
import { useLazyEnglishTest } from "./lazy-english.test-support.ts";

const loadI18n = useLazyEnglishTest();

it("loads Talk settings fallback copy before the cold view renders", async () => {
  const { en, manager } = await loadI18n();
  const talkPage = en.talkPage;
  expect(manager.t("tabs.talk")).toBe("Talk");
  expect(manager.t("talkPage.voice.title")).toBe("talkPage.voice.title");

  await manager.setLocale("de");
  await import("../pages/config/talk.ts");

  expect(en.talkPage).toBe(talkPage);
  expect(manager.t("talkPage.voice.title")).toBe("Speaker voice");
  expect(manager.t("talkPage.model.defaultNamed", { model: "Example" })).toBe("Default (Example)");
  expect(manager.t("talkPage.status.unavailable")).toBe("Unavailable");
  expect(manager.t("common.health")).toBe("Gesundheit");
  expect(manager.t("tabs.talk")).toBe("Talk");
});
