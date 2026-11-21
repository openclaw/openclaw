import { afterEach, expect, it } from "vitest";
import { cleanupSolid, mountSolid } from "../test-helpers/mount-solid.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import { McpAppConfirmation } from "./mcp-app-confirm-solid.tsx";
import { createMcpAppConfirm } from "./mcp-app-confirm.ts";

afterEach(() => {
  cleanupSolid();
  document.body.replaceChildren();
});

it("focuses each pending decision once and returns focus after keyboard completion", async () => {
  const frame = document.createElement("iframe");
  document.body.append(frame);
  const confirmation = createMcpAppConfirm();
  const mounted = mountSolid(() => <McpAppConfirmation confirmation={confirmation} />);
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
    confirmation.update();
    expect(document.activeElement).toBe(cancel);
    strip.focus();
    strip.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(frame);
    await expect(decision).resolves.toBe(key === "Enter");
    await waitForSolid(() => expect(mounted.queryByRole("alertdialog")).toBeNull());
  }
});

it("keeps an emoji whole in a confirmation preview", async () => {
  const text = `${"p".repeat(199)}😀ZZEND`;
  const confirmation = createMcpAppConfirm();
  const mounted = mountSolid(() => <McpAppConfirmation confirmation={confirmation} />);
  void confirmation.request({
    frame: document.createElement("iframe"),
    title: "Send note",
    text,
    kind: "message",
    isCurrent: () => true,
  });
  await waitForSolid(() => expect(mounted.getByRole("alertdialog")).toBeTruthy());
  const preview = document.querySelector(".mcp-app-confirm__preview");
  expect(preview?.textContent).toBe(`${"p".repeat(199)}…`);
  expect(preview?.textContent).not.toContain("ZZEND");
  expect(preview?.textContent).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
});
