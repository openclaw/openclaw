import { afterEach, expect, it, vi } from "vitest";
import "../styles.css";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import { showToast } from "./toast.ts";
import "./toast-host.tsx";

// mock-isolation: Preserve the real host and stylesheet when its lazy view fails.
vi.mock("./toast-view.tsx", () => ({
  ToastView() {
    throw new Error("Synthetic unavailable toast renderer");
  },
}));

afterEach(() => document.body.replaceChildren());

it("keeps the offline failure message and recovery controls visible", async () => {
  const host = document.createElement("openclaw-toast-host");
  document.body.append(host);
  const dismissed = vi.fn();
  showToast({ severity: "info", message: "Saved", onDismiss: dismissed, durationMs: 60_000 });

  await waitForSolid(() => expect(host.querySelector('[role="alert"]')).not.toBeNull());
  const card = host.querySelector<HTMLElement>('[role="alert"]')!;
  const content = card.querySelector<HTMLElement>(".app-toast__content")!;
  const retry = [...card.querySelectorAll("button")].find(
    (button) => button.textContent === "Retry",
  )!;
  expect(card.textContent).toContain("Couldn’t load this panel.");
  expect(card.textContent).toContain("Saved");
  showToast({
    severity: "warning",
    message: "Review pending config",
    description: "Changes are retained.",
    placement: "top-right",
    durationMs: 60_000,
  });
  await waitForSolid(() => expect(card.textContent).toContain("Review pending config"));
  expect(card.textContent).toContain("Changes are retained.");
  expect(getComputedStyle(content).opacity).toBe("1");
  expect(card.getBoundingClientRect().height).toBeGreaterThan(40);
  expect(retry.getBoundingClientRect().width).toBeGreaterThan(0);
  card.querySelector<HTMLButtonElement>('[aria-label="Dismiss"]')!.click();
  await waitForSolid(() => expect(dismissed).toHaveBeenCalledExactlyOnceWith("dismiss"));
});
