/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  captureI18nStateForTesting,
  createI18nManagerForTesting,
} from "./lib/translate.test-support.ts";

vi.hoisted(() => vi.resetModules());

let restoreI18n: () => Promise<void>;

beforeEach(() => {
  restoreI18n = captureI18nStateForTesting();
});

afterEach(async () => {
  await restoreI18n();
});

it("loads bundle fallback copy with the skill preview without replacing the active language", async () => {
  const manager = createI18nManagerForTesting(async () => ({
    filePreview: { bundle: { binary: "Binärdatei" } },
  }));
  expect(manager.t("filePreview.bundle.incomplete")).toBe("filePreview.bundle.incomplete");
  expect(manager.t("filePreview.label")).toBe("Support files");

  await manager.setLocale("de");
  await import("../pages/plugins/skill-preview.ts");

  expect(manager.t("filePreview.bundle.binary")).toBe("Binärdatei");
  expect(manager.t("filePreview.bundle.too-large")).toBe(
    "This file exceeds the preview limit. Its contents have not been truncated or loaded.",
  );
  expect(manager.t("filePreview.bundle.unavailable")).toBe(
    "This file could not be read safely or is unavailable. Close and reopen the skill to try again.",
  );
  expect(manager.t("filePreview.bundle.incomplete")).toBe(
    "Some bundle content is unavailable. Select a file to see its status.",
  );
  expect(manager.t("filePreview.label")).toBe("Support files");
  await manager.setLocale("en");
  expect(manager.t("filePreview.bundle.binary")).toBe(
    "This binary file is included in the bundle but cannot be displayed as text.",
  );
});
