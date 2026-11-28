/* @vitest-environment jsdom */
import { expect, it, onTestFinished } from "vitest";
import { i18n } from "../../../i18n/index.ts";
import { captureI18nStateForTesting } from "../../../i18n/lib/translate.test-support.ts";
import { registerFilePreviewEnglish } from "../../../i18n/locales/en-file-preview.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { ChatSidebarEditorMenu } from "./chat-sidebar-editor-menu.tsx";

it("names the icon-only editor menu trigger in the active locale", async () => {
  const restoreI18n = captureI18nStateForTesting();
  registerFilePreviewEnglish();
  await i18n.setLocale("de");
  const view = mountSolid(() => (
    <ChatSidebarEditorMenu
      absolutePath="/workspace/notes.md"
      open={false}
      onOpenChange={() => {}}
      onOpenEditor={() => {}}
    />
  ));
  onTestFinished(async () => {
    view.unmount();
    await restoreI18n();
  });
  const trigger = () => view.container.querySelector(".sidebar-file-view__action");
  const german = t("chat.detailPanel.openInEditor");
  await waitForSolid(() => expect(trigger()?.getAttribute("aria-label")).toBe(german));
  expect(trigger()?.getAttribute("title")).toBe(german);

  await i18n.setLocale("en");
  const english = t("chat.detailPanel.openInEditor");
  expect(english).not.toBe(german);
  await waitForSolid(() => expect(trigger()?.getAttribute("aria-label")).toBe(english));
  expect(trigger()?.getAttribute("title")).toBe(english);
});
