import { expect, it } from "vitest";
import { detectChangedLanes } from "../../scripts/changed-lanes.mts";
import { createChangedCheckPlan } from "../../scripts/check-changed.mts";

it.each([
  "extensions/workboard/browser/i18n/locales/en.ts",
  "extensions/workboard/browser/i18n/locales/translated.json",
  "extensions/workboard/browser/workboard-page.ts",
  "extensions/workboard/package.json",
  "extensions/x/src/control-ui.ts",
  "extensions/x/src/i18n/locales/translated.json",
  "extensions/example/i18n/locales/translated.json",
  "scripts/lib/control-ui-plugin-i18n-catalog.ts",
])("includes plugin catalog verification in changed checks for %s", (file) => {
  const { commands } = createChangedCheckPlan(detectChangedLanes([file]), {
    env: { PATH: "/usr/bin" },
    base: "HEAD",
  });
  expect(commands).toContainEqual(expect.objectContaining({ args: ["lint:ui:i18n"] }));
});
