// @vitest-environment jsdom
import { expect, it, onTestFinished } from "vitest";
import { i18n } from "../i18n/index.ts";
import { captureI18nStateForTesting } from "../i18n/lib/translate.test-support.ts";
import { cleanupSolid, mountSolid } from "../test-helpers/mount-solid.ts";
import { flush } from "../test-helpers/solid-settle.ts";
import { ProgressCardMarkdown } from "./session-progress-card-view.tsx";

it("refreshes promoted progress labels on locale changes without replacing the markdown root", async () => {
  const restoreI18n = captureI18nStateForTesting();
  onTestFinished(async () => {
    cleanupSolid();
    await restoreI18n();
  });
  await i18n.setLocale("en");
  const view = mountSolid(() => (
    <ProgressCardMarkdown markdown={'<progress value="3" max="7"></progress>'} promoteProgress />
  ));
  flush();
  const markdown = view.container.querySelector(".session-progress-card__markdown");
  expect(view.getByRole("progressbar", { name: "Progress · 3/7" })).toBeDefined();
  expect(view.container.querySelector(".session-progress-card__progress-label")?.textContent).toBe(
    "Progress · 3/7",
  );

  await i18n.setLocale("de");
  flush();

  expect(view.getByRole("progressbar", { name: "Fortschritt · 3/7" })).toBeDefined();
  expect(view.container.querySelector(".session-progress-card__progress-label")?.textContent).toBe(
    "Fortschritt · 3/7",
  );
  expect(view.container.querySelector(".session-progress-card__markdown")).toBe(markdown);
});
