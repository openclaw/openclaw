import { afterEach, expect, it, onTestFinished } from "vitest";
import { userEvent } from "vitest/browser";
import { composerInputHasFocus, focusComposerInput } from "../../lib/composer-input.ts";
import "../../test-helpers/load-styles.ts";
import { isApplePlatform } from "../../lib/keyboard-shortcut-contract.ts";
import { renderComposer, resetComposerTestFixtures } from "./composer.test-support.ts";

const historyModifier = isApplePlatform() ? "Meta" : "Control";

afterEach(resetComposerTestFixtures);

it("keeps rich editing history inside its New Session draft owner", async () => {
  const f = renderComposer({
    message: "@Alex ",
    mentions: [{ profileId: "alex-one", start: 0, end: 5 }],
  });
  document.body.append(f.container);
  onTestFinished(() => {
    f.unmount();
    f.container.remove();
  });
  await expect.poll(() => f.container.querySelector("[data-composer-editor]")).not.toBeNull();
  const original = f.container.querySelector("textarea")!;
  focusComposerInput(original);
  await userEvent.keyboard("before route change");
  f.rerender();
  expect(f.container.querySelector("textarea")).toBe(original);
  await userEvent.keyboard(`{${historyModifier}>}z{/${historyModifier}}`);
  expect(original.value).toBe("@Alex ");
  await userEvent.keyboard(`{${historyModifier}>}{Shift>}Z{/Shift}{/${historyModifier}}`);
  expect(original.value).toBe("@Alex before route change");

  f.rerenderForDraftRoute("draft:two", "New route draft");
  await expect.poll(() => f.container.querySelector("textarea")?.value).toBe("New route draft");
  const next = f.container.querySelector("textarea")!;
  expect(composerInputHasFocus(next)).toBe(true);
  focusComposerInput(next);
  await userEvent.keyboard(`{${historyModifier}>}z{/${historyModifier}}`);
  expect(next.value).toBe("New route draft");
  expect(f.composerTextarea.getTextarea()).toBe(next);
  expect(original.isConnected).toBe(false);

  next.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  expect(f.composerTextarea.composing).toBe(true);
  f.rerenderForDraftRoute("draft:three", "Third draft");
  await expect.poll(() => f.container.querySelector("textarea")?.value).toBe("Third draft");
  expect(f.composerTextarea.composing).toBe(false);

  const other = document.createElement("button");
  f.container.append(other);
  await userEvent.click(other);
  f.rerenderForDraftRoute("draft:four", "Fourth draft");
  await expect.poll(() => f.container.querySelector("textarea")?.value).toBe("Fourth draft");
  expect(document.activeElement).toBe(other);
});
