/* @vitest-environment jsdom */
import { expect, it } from "vitest";
import { useLazyEnglishTest } from "./lazy-english.test-support.ts";

const loadI18n = useLazyEnglishTest();

it("registers tool-body English independently from each lazy renderer", async () => {
  const { manager, en } = await loadI18n({
    chat: { toolCards: { showFullOutput: "Vollständige Ausgabe anzeigen" } },
  });
  const namespace = en.chat.toolCards;
  const eagerKeys = new Set(Object.keys(namespace));
  expect(manager.t("chat.toolCards.toolOutput")).toBe("Tool output");
  expect(manager.t("chat.toolCards.failed")).toBe("failed");
  expect(manager.t("chat.toolCards.showFullOutput")).toBe("chat.toolCards.showFullOutput");
  await manager.setLocale("de");
  for (const surface of ["expanded", "sidebar"]) {
    expect(manager.t("chat.toolCards.outputLoadFailed")).toBe("chat.toolCards.outputLoadFailed");
    if (surface === "expanded") {
      await import("../pages/chat/components/chat-tool-expanded.solid.tsx");
    } else {
      await import("../pages/chat/components/chat-tool-output-view.tsx");
    }
    expect(manager.t("chat.toolCards.showFullOutput")).toBe("Vollständige Ausgabe anzeigen");
    expect(manager.t("chat.toolCards.outputLoadFailed")).toBe(
      "Could not load the full output. Try again.",
    );
    expect(manager.t("chat.toolCards.openDetails")).toBe("Open tool details in side panel");
    expect(en.chat.toolCards).toBe(namespace);
    // Each consumer must register its own copy, without reloading the shared Solid runtime.
    for (const key of Object.keys(namespace)) {
      if (!eagerKeys.has(key)) {
        Reflect.deleteProperty(namespace, key);
      }
    }
  }
});
