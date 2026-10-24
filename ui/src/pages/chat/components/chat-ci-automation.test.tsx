/* @vitest-environment jsdom */
import { createSignal } from "solid-js";
import { expect, it, vi } from "vitest";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { ChatCiAutomationView } from "./chat-ci-automation.tsx";

it("retries with the current callback without replacing the error button", async () => {
  const initialRetry = vi.fn();
  const currentRetry = vi.fn();
  const [retry, setRetry] = createSignal<() => void>(() => initialRetry);
  const view = mountSolid(() => (
    <ChatCiAutomationView
      options={{ autoFix: false, autoMerge: false, autoArchive: false }}
      pending={{}}
      loading={false}
      saving={false}
      error="Unable to load automation"
      onChange={() => {}}
      onRetry={retry()}
    />
  ));
  const button = view.getByRole("button", { name: "Try again" });
  setRetry(() => currentRetry);
  await waitForSolid(() => expect(view.getByRole("button", { name: "Try again" })).toBe(button));
  button.click();
  expect(currentRetry).toHaveBeenCalledOnce();
  expect(initialRetry).not.toHaveBeenCalled();
});
