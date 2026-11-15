/* @vitest-environment jsdom */

import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createContext, mountPage } from "./custodian-page.test-harness.ts";

afterEach(() => {
  localStorage.clear();
});

it.each([false, true])("keeps IME confirmation in the draft (sensitive=%s)", async (sensitive) => {
  const request = vi
    .fn()
    .mockResolvedValue({ sessionId: "ime-test", reply: "Ready.", action: "none", sensitive });
  const { page, provider } = await mountPage(createContext(request).context);
  onTestFinished(() => provider.remove());
  await waitForSolid(() => expect(request).toHaveBeenCalledTimes(1));
  const field = page.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    sensitive ? 'input[type="password"]' : "textarea",
  )!;
  field.value = "检查配置";
  field.dispatchEvent(new InputEvent("input", { bubbles: true }));
  await page.updateComplete;
  for (const init of [{ isComposing: true }, { keyCode: 229 }, { shiftKey: true }]) {
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, ...init }));
    await page.updateComplete;
    expect(request).toHaveBeenCalledTimes(1);
    expect(field.value).toBe("检查配置");
  }
  const end = new CompositionEvent("compositionend", { bubbles: true });
  field.dispatchEvent(end);
  const confirm = new KeyboardEvent("keydown", { key: "Enter", bubbles: true });
  Object.defineProperty(confirm, "timeStamp", { value: end.timeStamp - 1 });
  field.dispatchEvent(confirm);
  await page.updateComplete;
  expect(request).toHaveBeenCalledTimes(1);
  expect(field.value).toBe("检查配置");

  field.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
  field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await waitForSolid(() => expect(request).toHaveBeenCalledTimes(2));
  expect(request.mock.calls[1]?.[1]).toMatchObject({ message: "检查配置" });
  expect(field.value).toBe("");
});
