import { expect, it } from "vitest";
import { useLazyEnglishTest } from "./lazy-english.test-support.ts";

const loadI18n = useLazyEnglishTest();

it.each([
  { surface: "composer", load: () => import("../pages/chat/composer-library-session.ts") },
  { surface: "pin reader", load: () => import("../pages/skills/library-detail.tsx") },
])(
  "loads session copy without skill editor copy at the cold $surface boundary",
  async ({ load }) => {
    const { en, manager } = await loadI18n({
      skillLibrary: { session: { selected: "Ausgewählt" } },
    });
    await manager.setLocale("de");
    await load();
    const library = en.skillLibrary;
    expect(library).toBeDefined();
    if (!library || typeof library === "string") {
      throw new Error("Session library copy must be registered");
    }
    expect(manager.t("skillLibrary.session.selected")).toBe("Ausgewählt");
    expect(manager.t("skillLibrary.session.readOnly")).toContain("exact revision");
    expect(manager.t("skillLibrary.binaryRead")).toBe(
      "Binary attachment retained with this revision.",
    );
    expect(library.import).toBeUndefined();
    const session = library.session;

    await import("../pages/skills/library-state.ts");
    expect(en.skillLibrary).toBe(library);
    expect(library.session).toBe(session);
    expect(manager.t("skillLibrary.import")).toBe("Import skill");
    expect(manager.t("skillLibrary.session.selected")).toBe("Ausgewählt");
  },
);

it("loads composer menu copy without the skill editor at its cold boundary", async () => {
  const { en, manager } = await loadI18n({
    chat: { composer: { menu: { readSkill: "Lesen" } } },
  });
  await manager.setLocale("de");
  await import("../pages/chat/components/chat-composer-library-menu.tsx");
  expect(manager.t("chat.composer.menu.readSkill")).toBe("Lesen");
  expect(manager.t("chat.composer.menu.addFromLibraries")).toBe("Add from libraries");
  expect(en.skillLibrary).toBeUndefined();
});
