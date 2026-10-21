/* @vitest-environment jsdom */

import { flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import { cleanupSolid, mountSolid } from "../../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { renderDreamingToggleConfirmation } from "./toggle-confirmation.tsx";

afterEach(() => cleanupSolid());

type ToggleProps = Parameters<typeof renderDreamingToggleConfirmation>[0];

function renderToggle(overrides?: Partial<ToggleProps>): HTMLElement {
  const props: ToggleProps = {
    open: true,
    enabling: true,
    disabled: false,
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  };
  const host = document.createElement("div");
  mountSolid(() => renderDreamingToggleConfirmation(props), { container: host });
  flush();
  return host;
}

describe("renderDreamingToggleConfirmation", () => {
  it("renders nothing while closed", () => {
    expect(renderToggle({ open: false }).textContent?.trim()).toBe("");
  });

  it("states the global scope and never promises a gateway restart", () => {
    for (const enabling of [true, false]) {
      const text = renderToggle({ enabling }).textContent ?? "";
      expect(text).toContain("All Agents");
      expect(text).toContain("global setting");
      expect(text.toLowerCase()).not.toContain("restart");
      expect(text.toLowerCase()).not.toContain("interrupt");
    }
  });

  it("uses direction-specific copy for enabling and disabling", () => {
    expect(renderToggle({ enabling: true }).textContent).toContain("Turn On Dreaming");
    const disabling = renderToggle({ enabling: false });
    expect(disabling.textContent).toContain("Turn Off Dreaming");
    // Disabling is the destructive direction: it stops the sweep for every agent.
    expect(disabling.querySelector("button.btn.danger")).not.toBeNull();
    expect(renderToggle({ enabling: true }).querySelector("button.btn.danger")).toBeNull();
  });

  it("shows saving and vetoes cancel until the admitted write settles", async () => {
    const pending = createDeferred();
    const onCancel = vi.fn();
    const host = renderToggle({ onConfirm: () => pending.promise, onCancel });
    const confirm = host.querySelector("button");
    confirm?.click();
    await waitForSolid(() => expect(confirm?.textContent?.trim()).toBe("Saving…"));
    expect(confirm?.hasAttribute("disabled")).toBe(true);
    host.querySelector("openclaw-modal-dialog")?.dispatchEvent(new CustomEvent("modal-cancel"));
    expect(onCancel).not.toHaveBeenCalled();
    pending.resolve();
    await waitForSolid(() => expect(confirm?.hasAttribute("disabled")).toBe(false));
    host.querySelector("openclaw-modal-dialog")?.dispatchEvent(new CustomEvent("modal-cancel"));
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
