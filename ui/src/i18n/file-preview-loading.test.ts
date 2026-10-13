import { expect, it, vi } from "vitest";
import { useLazyEnglishTest } from "./lazy-english.test-support.ts";

const loadI18n = useLazyEnglishTest();

it.each([
  { surface: "bundle preview", load: () => import("../components/file-preview-modal.ts") },
  { surface: "file draft", load: () => import("../pages/chat/components/chat-file-drafts.ts") },
  { surface: "embedded panel", load: () => import("../pages/chat/chat-pane-embedded-panels.ts") },
])("loads file preview fallback copy with the $surface instead of startup", async ({ load }) => {
  const { manager } = await loadI18n();
  expect(manager.t("filePreview.label")).toBe("Support files");
  expect(manager.t("filePreview.listLabel")).toBe("filePreview.listLabel");
  expect(manager.t("filePreview.bundle.binary")).toBe("filePreview.bundle.binary");
  expect(manager.t("chat.detailPanel.reloadBlocked")).toBe("chat.detailPanel.reloadBlocked");

  await manager.setLocale("de");
  // Cold module imports rerun registrations, but jsdom keeps its element registry.
  // This suite checks catalog loading without mounting those elements.
  const define = customElements.define.bind(customElements);
  const registration = vi
    .spyOn(customElements, "define")
    .mockImplementation((name, constructor, options) => {
      if (!customElements.get(name)) {
        define(name, constructor, options);
      }
    });
  try {
    await load();
  } finally {
    registration.mockRestore();
  }

  expect(manager.t("common.health")).toBe("Gesundheit");
  expect(manager.t("filePreview.label")).toBe("Support files");
  expect(manager.t("filePreview.listLabel")).toBe("Files");
  expect(manager.t("filePreview.fileCount", { count: "2" })).toBe("2 files");
  expect(manager.t("filePreview.bundle.binary")).toBe(
    "This binary file is included in the bundle but cannot be displayed as text.",
  );
  expect(manager.t("filePreview.bundle.incomplete")).toBe(
    "Some bundle content is unavailable. Select a file to see its status.",
  );
  expect(manager.t("chat.detailPanel.reloadBlocked")).toBe(
    "Save or discard your file edits before reloading.",
  );
  expect(manager.t("chat.detailPanel.copyContents")).toBe("Copy file contents");
});
