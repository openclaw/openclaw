import { expect, it } from "vitest";
import { detectChangedScope, shouldRunIosScreenshots } from "../../scripts/ci-changed-scope.mjs";

it.each<[string, boolean, boolean]>([
  ["ui/src/pages/chat/chat-realtime.ts", true, true],
  ["ui/src/pages/chat/chat-realtime.test.ts", false, true],
  ["scripts/lib/control-ui-i18n-config.json", true, false],
  ["src/config/schema.labels.ts", true, false],
  ["extensions/example/browser/page.ts", true, true],
  ["extensions/example/browser/page.test.ts", false, true],
  ["extensions/example/src/control-ui.ts", true, false],
  ["extensions/example/src/i18n/locales/translated.json", true, false],
  ["extensions/example/i18n/locales/translated.json", true, false],
  ["extensions/example/browser/i18n/locales/en.ts", true, true],
  ["extensions/example/browser/i18n/locales/translated.json", true, true],
  ["extensions/example/package.json", true, false],
  ["scripts/lib/control-ui-plugin-i18n-catalog.ts", true, false],
  ["test/vitest/vitest.ui-e2e.bundled.global-setup.ts", false, true],
  ["test/vitest/vitest.ui.config.ts", false, false],
])("routes localization and browser proof for %s", (file, runControlUiI18n, runUiTests) => {
  expect(detectChangedScope([file])).toMatchObject({ runControlUiI18n, runUiTests });
});

it("runs browser proof and native asset builds for Mermaid inputs", () => {
  const file = "packages/normalization-core/src/record-coerce.ts";
  expect(detectChangedScope([file])).toMatchObject({
    runNode: true,
    runUiTests: true,
    runAndroid: true,
    runMacos: true,
    runIosBuild: true,
    runControlUiI18n: false,
  });
  expect(shouldRunIosScreenshots([file])).toBe(true);
});

it.each([
  ["packages/normalization-core/src/record-coerce.test.ts", false],
  ["package.json", true],
] as const)(
  "routes shared Node inputs through their native protocol consumers: %s",
  (file, nativeProtocolInput) => {
    expect(detectChangedScope([file])).toMatchObject({
      runNode: true,
      runWindows: false,
      runAndroid: nativeProtocolInput,
      runMacos: nativeProtocolInput,
      runIosBuild: nativeProtocolInput,
      runUiTests: false,
    });
    expect(shouldRunIosScreenshots([file])).toBe(false);
  },
);
