/* @vitest-environment jsdom */
import { createSignal } from "solid-js";
import { expect, it, vi } from "vitest";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { ChatCiAutomationView } from "./chat-ci-automation.tsx";

it("keeps automation usable when switching to menu presentation without menu controls", async () => {
  const [menuPresentation, setMenuPresentation] = createSignal(false);
  const onChange = vi.fn();
  const view = mountSolid(() => (
    <ChatCiAutomationView
      options={{ autoFix: false, autoMerge: false, autoArchive: false }}
      pending={{}}
      loading={false}
      saving={false}
      error={null}
      menuPresentation={menuPresentation()}
      onChange={onChange}
      onRetry={() => {}}
    />
  ));
  expect(
    view.getByRole("checkbox", { name: "Auto-fix CI & address comments" }).matches(":disabled"),
  ).toBe(false);
  setMenuPresentation(true);
  await waitForSolid(() =>
    expect(
      view.getByRole("switch", { name: "Auto-fix CI & address comments" }).matches(":disabled"),
    ).toBe(false),
  );
  view.getByRole("switch", { name: "Auto-fix CI & address comments" }).click();
  expect(onChange).toHaveBeenCalledWith("autoFix", true);
});

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
