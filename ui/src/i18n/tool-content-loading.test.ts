/* @vitest-environment jsdom */
import { expect, it } from "vitest";
import { useLazyEnglishTest } from "./lazy-english.test-support.ts";

const loadI18n = useLazyEnglishTest();

it.each([
  {
    surface: "expanded",
    load: () => import("../pages/chat/components/chat-tool-expanded.solid.tsx"),
  },
  { surface: "sidebar", load: () => import("../pages/chat/components/chat-tool-output-view.tsx") },
])("registers tool-body English independently from the $surface renderer", async ({ load }) => {
  const { manager, en } = await loadI18n({
    chat: { toolCards: { showFullOutput: "Vollständige Ausgabe anzeigen" } },
  });
  const namespace = en.chat.toolCards;
  const activity = namespace.activity;
  const review = namespace.review;
  const verbs = namespace.verbs;
  expect(manager.t("chat.toolCards.toolOutput")).toBe("chat.toolCards.toolOutput");
  expect(manager.t("chat.toolCards.failed")).toBe("chat.toolCards.failed");
  expect(manager.t("chat.toolCards.showFullOutput")).toBe("chat.toolCards.showFullOutput");
  await manager.setLocale("de");
  expect(manager.t("chat.toolCards.outputLoadFailed")).toBe("chat.toolCards.outputLoadFailed");
  await load();
  expect(manager.t("chat.toolCards.showFullOutput")).toBe("Vollständige Ausgabe anzeigen");
  expect(manager.t("chat.toolCards.outputLoadFailed")).toBe(
    "Could not load the full output. Try again.",
  );
  expect(manager.t("chat.toolCards.openDetails")).toBe("Open tool details in side panel");
  expect(manager.t("chat.toolCards.toolOutput")).toBe("Tool output");
  expect(manager.t("chat.toolCards.failed")).toBe("failed");
  expect(en.chat.toolCards).toBe(namespace);
  expect(namespace.activity).toBe(activity);
  expect(namespace.review).toBe(review);
  expect(namespace.verbs).toBe(verbs);
});

it.each([
  { surface: "tool output owner", load: () => import("../lib/chat/tool-output.ts") },
  { surface: "tool grouping owner", load: () => import("../lib/chat/tool-call-grouping.ts") },
  {
    surface: "tool row presentation",
    load: () => import("../pages/chat/components/chat-tool-row-presentation.ts"),
  },
])("registers fallback copy before the $surface uses it", async ({ load }) => {
  const { manager, en } = await loadI18n({
    chat: { toolCards: { toolOutput: "Werkzeugausgabe" } },
  });
  const namespace = en.chat.toolCards;
  const activity = namespace.activity;
  expect(manager.t("chat.toolCards.exitCode")).toBe("chat.toolCards.exitCode");
  await manager.setLocale("de");
  await load();
  expect(manager.t("chat.toolCards.toolOutput")).toBe("Werkzeugausgabe");
  expect(manager.t("chat.toolCards.exitCode", { code: "7" })).toBe("Exit code 7");
  expect(manager.t("chat.toolCards.verbs.editing")).toBe("Editing");
  expect(en.chat.toolCards).toBe(namespace);
  expect(namespace.activity).toBe(activity);
});
