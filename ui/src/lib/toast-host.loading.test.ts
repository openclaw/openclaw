/* @vitest-environment jsdom */

import { getByRole } from "@solidjs/testing-library";
import { afterEach, expect, it, vi } from "vitest";
import { flush, waitForSolid } from "../test-helpers/solid-settle.ts";
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

it("can retry a failed toast import and dismiss the recovered notice", async () => {
  const host = document.createElement("openclaw-toast-host");
  document.body.append(host);
  const dismissed = vi.fn();
  showToast({ message: "Synthetic saved notice", onDismiss: dismissed, durationMs: 60_000 });

  await waitForSolid(() => expect(getByRole(host, "button", { name: "Retry" })).toBeTruthy());
  expect(getByRole(host, "alert").textContent).toContain("Panel failed to load");
  expect(getByRole(host, "button", { name: "Dismiss" })).toBeTruthy();
  vi.doUnmock("./toast-view.tsx");
  getByRole(host, "button", { name: "Retry" }).click();
  await waitForSolid(() => expect(host.textContent).toContain("Synthetic saved notice"));
  expect(host.querySelector('[role="alert"]')).toBeNull();
  getByRole(host, "button", { name: "Dismiss" }).click();
  flush();
  expect(host.toast).toBeNull();
  expect(dismissed).toHaveBeenCalledExactlyOnceWith("dismiss");
});
