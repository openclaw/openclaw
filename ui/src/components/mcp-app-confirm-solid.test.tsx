import { afterEach, expect, it } from "vitest";
import { cleanupSolid, mountSolid } from "../test-helpers/mount-solid.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import { McpAppConfirmation } from "./mcp-app-confirm-solid.tsx";
import { createMcpAppConfirm } from "./mcp-app-confirm.ts";

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

afterEach(() => {
  cleanupSolid();
  document.body.replaceChildren();
});

it("keeps a boundary emoji whole in the truncated message preview", async () => {
  const frame = document.createElement("iframe");
  document.body.append(frame);
  const confirmation = createMcpAppConfirm();
  mountSolid(() => <McpAppConfirmation confirmation={confirmation} />);
  const decision = confirmation.request({
    frame,
    title: "Parts library",
    text: `${"a".repeat(199)}🚀${"b".repeat(40)}`,
    kind: "message",
    isCurrent: () => true,
  });
  await waitForSolid(() =>
    expect(document.querySelector(".mcp-app-confirm__preview")?.textContent).toBeTruthy(),
  );
  const shown = document.querySelector(".mcp-app-confirm__preview")?.textContent ?? "";
  expect(shown.endsWith("…")).toBe(true);
  expect(LONE_SURROGATE.test(shown)).toBe(false);
  expect(shown.length).toBeLessThanOrEqual(201);
  confirmation.finish(false);
  await expect(decision).resolves.toBe(false);
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
