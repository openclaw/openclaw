import { createSignal, flush } from "solid-js";
import { afterEach, expect, it } from "vitest";
import { cleanupSolid, mountSolid } from "../test-helpers/mount-solid.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import { McpAppConfirmation } from "./mcp-app-confirm-solid.tsx";
import { McpAppConfirm } from "./mcp-app-confirm.ts";

afterEach(() => {
  cleanupSolid();
  document.body.replaceChildren();
});

it("focuses each pending decision once and returns focus after keyboard completion", async () => {
  const frame = document.createElement("iframe");
  document.body.append(frame);
  const [revision, setRevision] = createSignal(0);
  const confirmation = new McpAppConfirm(() => setRevision((value) => value + 1));
  const mounted = mountSolid(() => (
    <McpAppConfirmation confirmation={confirmation} revision={revision()} />
  ));
  const request = () =>
    confirmation.request({
      frame,
      title: "Parts library",
      text: "parts.txt",
      kind: "file",
      isCurrent: () => true,
    });

  for (const key of ["Enter", "Escape"]) {
    frame.focus();
    const decision = request();
    await expect(request()).resolves.toBe(false);
    await waitForSolid(() => expect(document.activeElement).toBe(mounted.getByRole("alertdialog")));
    const strip = mounted.getByRole("alertdialog");
    const cancel = mounted.getByRole("button", { name: "Cancel" });
    cancel.focus();
    setRevision((value) => value + 1);
    flush();
    expect(document.activeElement).toBe(cancel);
    strip.focus();
    strip.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(frame);
    await expect(decision).resolves.toBe(key === "Enter");
    await waitForSolid(() => expect(mounted.queryByRole("alertdialog")).toBeNull());
  }
});
