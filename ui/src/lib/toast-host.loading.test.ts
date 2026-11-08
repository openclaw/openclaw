/* @vitest-environment jsdom */

import { getByRole } from "@solidjs/testing-library";
import { afterEach, expect, it, vi } from "vitest";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import { showToast } from "./toast.ts";
import "./toast-host.tsx";

// mock-isolation: Simulate a failed lazy download before the module has any exports.
vi.mock("./toast-view.tsx", () => {
  throw new Error("Synthetic toast chunk unavailable");
});

afterEach(() => {
  document.body.replaceChildren();
  vi.doUnmock("./toast-view.tsx");
});

it("retains a fragment notice through failed import and retry", async () => {
  const host = document.createElement("openclaw-toast-host");
  document.body.append(host);
  const dismissed = vi.fn();
  const message = document.createDocumentFragment();
  message.append("Synthetic saved notice");
  showToast({
    severity: "success",
    message,
    onDismiss: dismissed,
    durationMs: 60_000,
  });

  await waitForSolid(() => expect(getByRole(host, "button", { name: "Retry" })).toBeTruthy());
  expect(getByRole(host, "alert").textContent).toContain("Couldn’t load this panel.");
  expect(getByRole(host, "alert").textContent).toContain("Synthetic saved notice");
  expect(getByRole(host, "button", { name: "Dismiss" })).toBeTruthy();
  host
    .querySelector(".app-toast-lane")!
    .dispatchEvent(new Event("pointerenter", { bubbles: true }));
  await waitForSolid(() =>
    expect(getByRole(host, "alert").textContent).toContain("Synthetic saved notice"),
  );
  vi.doUnmock("./toast-view.tsx");
  getByRole(host, "button", { name: "Retry" }).click();
  await waitForSolid(() => expect(host.querySelector('[role="alert"]')).toBeNull());
  expect(host.textContent).toContain("Synthetic saved notice");
  getByRole(host, "button", { name: "Dismiss" }).click();
  await waitForSolid(() => expect(dismissed).toHaveBeenCalledExactlyOnceWith("dismiss"));
  expect(host.toasts).toEqual([]);
});
