import type { Locator, Page } from "playwright";
import type { ComposerEditor } from "../components/composer-editor.ts";

// Preserve getByRole's accessibility filtering when callers need the editor host.
export function accessibleChatComposer(scope: Page | Locator): Locator {
  const editor = scope.locator("openclaw-composer-editor");
  return editor.filter({
    has: editor.page().getByRole("textbox", { name: "Chat composer", exact: true }),
  });
}

export async function fillComposer(locator: Locator, value: string): Promise<void> {
  await locator.locator(".cm-content").fill(value);
}

export function composerValue(locator: Locator): Promise<string> {
  return locator.evaluate((element) => (element as ComposerEditor).value);
}

export function composerDisabled(locator: Locator): Promise<boolean> {
  return locator.evaluate((element) => (element as ComposerEditor).disabled);
}

export async function composerEnabled(locator: Locator): Promise<boolean> {
  return !(await composerDisabled(locator));
}
