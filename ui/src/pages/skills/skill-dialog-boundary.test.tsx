/* @vitest-environment jsdom */
import { createSignal, Show } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import * as recovery from "../../app/stale-chunk-reload.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { SkillDialogBoundary } from "./skill-dialog-boundary.tsx";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function failedDialog(error: Error, closeDisabled = false) {
  let failure: Error | undefined = error;
  let unlock!: () => void;
  let dismiss!: () => void;
  const close = vi.fn(() => dismiss());
  const Content = () => {
    if (failure) {
      throw failure;
    }
    return <span>Skill dialog recovered</span>;
  };
  const mounted = mountSolid(() => {
    const [disabled, setDisabled] = createSignal(closeDisabled);
    const [open, setOpen] = createSignal(true);
    unlock = () => setDisabled(false);
    dismiss = () => setOpen(false);
    return (
      <Show when={open()}>
        <SkillDialogBoundary onClose={close} closeDisabled={disabled()}>
          <Content />
        </SkillDialogBoundary>
      </Show>
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

it.each(["close", "navigate"] as const)(
  "retires stale-dialog recovery when the user chooses to %s during a document probe",
  async (retirement) => {
    const response = Promise.withResolvers<Response>();
    const probe = vi.fn<typeof fetch>(() => response.promise);
    vi.stubGlobal("fetch", probe);
    const documentReload = vi.fn();
    const retry = recovery.retryStaleChunkReloadWhenReachable;
    const attempt = vi
      .spyOn(recovery, "retryStaleChunkReloadWhenReachable")
      .mockImplementation((deps) =>
        retry({
          ...deps,
          reload: documentReload,
          storage: { getItem: () => null, setItem: () => undefined },
        }),
      );
    const view = failedDialog(new TypeError("Failed to fetch dynamically imported module"));
    await waitForSolid(() => expect(view.getByRole("button", { name: "Retry" })).toBeDefined());
    view.getByRole("button", { name: "Retry" }).click();
    expect(probe).toHaveBeenCalledOnce();
    if (retirement === "close") {
      view.getByRole("button", { name: "Close" }).click();
      await waitForSolid(() => expect(view.container.textContent).toBe(""));
    } else {
      view.unmount();
    }
    response.resolve(new Response(null, { status: 200 }));
    await expect(attempt.mock.results[0]?.value).resolves.toBe(false);
    expect(documentReload).not.toHaveBeenCalled();
  },
);
