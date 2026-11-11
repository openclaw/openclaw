/* @vitest-environment jsdom */
import { createSignal, flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { DialogHeader } from "./dialog-header.tsx";

afterEach(cleanupSolid);

describe("DialogHeader", () => {
  it("keeps contextual actions before close and updates their content and disabled state", () => {
    const close = vi.fn();
    let setBusy!: (busy: boolean) => void;
    let setFilename!: (filename: string) => void;
    const view = mountSolid(() => {
      const [busy, updateBusy] = createSignal(false);
      const [filename, updateFilename] = createSignal("first.tgz");
      setBusy = updateBusy;
      setFilename = updateFilename;
      return (
        <DialogHeader
          title="Import Template"
          actions={<button disabled={busy()}>{filename()}</button>}
          closeDisabled={busy()}
          onClose={close}
        />
      );
    });
    const actions = view.container.querySelector(".oc-dialog__header-actions")!;
    expect(
      [...actions.querySelectorAll("button")].map(
        (button) => button.textContent || button.getAttribute("aria-label"),
      ),
    ).toEqual(["first.tgz", "Close"]);
    expect(view.getByRole("heading", { name: "Import Template" }).textContent).toBe(
      "Import Template",
    );
    setBusy(true);
    setFilename("second.tgz");
    flush();
    expect(view.getByRole("button", { name: "second.tgz" }).hasAttribute("disabled")).toBe(true);
    const closeButton = view.getByRole("button", { name: "Close" });
    expect(closeButton.hasAttribute("disabled")).toBe(true);
    closeButton.click();
    expect(close).not.toHaveBeenCalled();
    setBusy(false);
    flush();
    closeButton.click();
    expect(close).toHaveBeenCalledOnce();
  });

  it("preserves ordinary dismissible and nondismissible headers", () => {
    const close = vi.fn();
    const view = mountSolid(() => (
      <DialogHeader title="Ordinary dialog" description="Details" onClose={close} />
    ));
    expect(view.getByRole("heading", { name: "Ordinary dialog" })).toBeTruthy();
    expect(view.getByText("Details")).toBeTruthy();
    view.getByRole("button", { name: "Close" }).click();
    expect(close).toHaveBeenCalledOnce();
    view.unmount();
    const locked = mountSolid(() => <DialogHeader title="Keep open" />);
    expect(locked.queryByRole("button")).toBeNull();
    expect(locked.container.querySelector(".oc-dialog__header-actions")).toBeNull();
  });
});
