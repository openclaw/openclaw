import { afterEach, beforeEach, expect, it, vi } from "vitest";

let restoreI18n: (() => Promise<void>) | undefined;

beforeEach(() => vi.resetModules());
afterEach(async () => {
  await restoreI18n?.();
});

it("loads file preview fallback copy with the component instead of startup", async () => {
  const { captureI18nStateForTesting, createI18nManagerForTesting } =
    await import("./lib/translate.test-support.ts");
  restoreI18n = captureI18nStateForTesting();
  const manager = createI18nManagerForTesting(async () => ({ common: { health: "Gesundheit" } }));
  expect(manager.t("filePreview.label")).toBe("Support files");
  expect(manager.t("filePreview.listLabel")).toBe("filePreview.listLabel");
  expect(manager.t("filePreview.bundle.binary")).toBe("filePreview.bundle.binary");

  await manager.setLocale("de");
  await import("../components/file-preview-modal.ts");

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
});
