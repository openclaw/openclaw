/* @vitest-environment jsdom */

import { createSignal, flush } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installDialogPolyfill } from "../../test-helpers/modal-dialog.ts";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { ChatGPTUsageLimit } from "./chatgpt-usage-limit.tsx";

let restoreDialog: () => void;
beforeEach(() => {
  restoreDialog = installDialogPolyfill();
});
afterEach(() => {
  cleanupSolid();
  restoreDialog();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("copies the partner-guideline admin request only when clicked and offers a manual fallback", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  const view = mountSolid(() => <ChatGPTUsageLimit kind="business" presented />);
  flush();
  expect(writeText).not.toHaveBeenCalled();
  const copy = view.getByRole("button", { name: "Copy request for admin" });
  const request =
    "I’ve reached the limit for using my ChatGPT plan in OpenClaw. Could you increase our workspace’s usage limits so I can continue?\n\nGo to admin.openai.com → Workspace → Usage limits. Thank you!";
  expect(view.queryByRole("link", { name: "Manage usage" })).toBeNull();
  copy.click();
  await vi.waitFor(() =>
    expect(view.container.textContent).toContain(
      "Request copied. Send it to your workspace admin.",
    ),
  );
  expect(writeText).toHaveBeenCalledExactlyOnceWith(request);

  writeText.mockRejectedValue(new Error("Clipboard denied"));
  copy.click();
  await vi.waitFor(() =>
    expect(view.getByRole("alert").textContent).toContain("Couldn't copy the request."),
  );
  expect(view.container.textContent).not.toContain("Request copied.");
  expect(view.container.querySelector("blockquote")?.textContent).toBe(request);
});

it("directs consumers to ChatGPT usage settings without an admin request", () => {
  const view = mountSolid(() => <ChatGPTUsageLimit kind="consumer" presented />);
  flush();
  const link = view.getByRole("link", { name: "Manage usage" });
  expect(link.getAttribute("href")).toBe("https://chatgpt.com/settings/usage");
  expect(link.getAttribute("target")).toBe("_blank");
  expect(view.getByRole("dialog").textContent).toContain("Review your usage settings in ChatGPT.");
  expect(view.queryByRole("button", { name: "Copy request for admin" })).toBeNull();
});

it.each(["business", "consumer"] as const)(
  "parks the %s modal and preserves dismissal until explicitly reopened",
  (kind) => {
    const [presented, setPresented] = createSignal(false);
    const view = mountSolid(() => <ChatGPTUsageLimit kind={kind} presented={presented()} />);
    flush();
    const dialog = view.container.querySelector("dialog")!;
    expect(dialog.open).toBe(false);
    setPresented(true);
    flush();
    expect(dialog.open).toBe(true);
    setPresented(false);
    flush();
    expect(dialog.open).toBe(false);
    setPresented(true);
    flush();
    expect(dialog.open).toBe(true);
    view.getByRole("button", { name: "Close" }).click();
    flush();
    expect(dialog.open).toBe(false);
    setPresented(false);
    flush();
    setPresented(true);
    flush();
    expect(dialog.open).toBe(false);
    view.getByRole("button", { name: "Details" }).click();
    flush();
    expect(dialog.open).toBe(true);
  },
);
