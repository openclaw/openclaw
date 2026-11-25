/* @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import * as recovery from "../../app/stale-chunk-reload.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { SessionPicker } from "./picker.tsx";
import { pickerParams } from "./where-chip.test-support.ts";

function failedPicker(error: Error) {
  const { params } = pickerParams(true);
  let failure: Error | undefined = error;
  const Content = () => {
    if (failure) {
      throw failure;
    }
    return <span>Picker recovered</span>;
  };
  const mounted = mountSolid(() => (
    <SessionPicker kind="where" label="Where" value="Local" icon={null} params={params}>
      <Content />
    </SessionPicker>
  ));
  return { ...mounted, params, recover: () => (failure = undefined) };
}

function retryButton(container: ParentNode) {
  const button = container.querySelector<HTMLButtonElement>(".lazy-view-error__action");
  expect(button).not.toBeNull();
  return button!;
}

describe("Session picker import recovery", () => {
  it("retries an ordinary render failure without reloading the document", async () => {
    const reload = vi.spyOn(recovery, "retryStaleChunkReloadWhenReachable");
    const picker = failedPicker(new Error("Temporary picker failure"));
    await waitForSolid(() => expect(retryButton(picker.container)).toBeDefined());
    picker.recover();
    retryButton(picker.container).click();
    await waitForSolid(() => expect(picker.container.textContent).toContain("Picker recovered"));
    expect(reload).not.toHaveBeenCalled();
  });

  it("uses guarded document recovery for a stale chunk and retires it when closed", async () => {
    const reload = vi.spyOn(recovery, "retryStaleChunkReloadWhenReachable").mockResolvedValue(true);
    const picker = failedPicker(new TypeError("Failed to fetch dynamically imported module"));
    await waitForSolid(() => expect(retryButton(picker.container)).toBeDefined());
    expect(picker.container.querySelector(".lazy-view-error--stale")).not.toBeNull();
    retryButton(picker.container).click();
    expect(reload).toHaveBeenCalledOnce();
    const canReload = reload.mock.calls[0]?.[0]?.canReload;
    expect(canReload?.()).toBe(true);
    vi.spyOn(picker.params.place.browser, "popoverOpen").mockReturnValue(false);
    expect(canReload?.()).toBe(false);
  });
});
