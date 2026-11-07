/* @vitest-environment jsdom */
import { createSignal } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import * as recovery from "../../app/stale-chunk-reload.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { SkillDialogBoundary } from "./skill-dialog-boundary.tsx";

afterEach(() => vi.restoreAllMocks());

function failedDialog(error: Error, closeDisabled = false) {
  let failure: Error | undefined = error;
  let unlock!: () => void;
  const close = vi.fn();
  const Content = () => {
    if (failure) {
      throw failure;
    }
    return <span>Skill dialog recovered</span>;
  };
  const mounted = mountSolid(() => {
    const [disabled, setDisabled] = createSignal(closeDisabled);
    unlock = () => setDisabled(false);
    return (
      <SkillDialogBoundary onClose={close} closeDisabled={disabled()}>
        <Content />
      </SkillDialogBoundary>
    );
  });
  return { ...mounted, close, unlock, recover: () => (failure = undefined) };
}

it("retries an ordinary dialog failure without reloading the document", async () => {
  const reload = vi.spyOn(recovery, "retryStaleChunkReloadWhenReachable");
  const view = failedDialog(new Error("Temporary skill dialog failure"));
  await waitForSolid(() => expect(view.getByRole("button", { name: "Retry" })).toBeDefined());
  view.recover();
  view.getByRole("button", { name: "Retry" }).click();
  await waitForSolid(() => expect(view.container.textContent).toContain("Skill dialog recovered"));
  expect(reload).not.toHaveBeenCalled();
});

it("uses guarded document recovery for a stale chunk and respects the current Close lock", async () => {
  const reload = vi.spyOn(recovery, "retryStaleChunkReloadWhenReachable").mockResolvedValue(true);
  const view = failedDialog(new TypeError("Failed to fetch dynamically imported module"), true);
  await waitForSolid(() => expect(view.getByRole("button", { name: "Retry" })).toBeDefined());
  const close = view.getByRole<HTMLButtonElement>("button", { name: "Close" });
  close.click();
  expect(view.close).not.toHaveBeenCalled();
  view.getByRole("button", { name: "Retry" }).click();
  expect(reload).toHaveBeenCalledOnce();
  expect(view.container.textContent).not.toContain("Skill dialog recovered");
  view.unlock();
  await waitForSolid(() => expect(close.disabled).toBe(false));
  close.click();
  expect(view.close).toHaveBeenCalledOnce();
});
