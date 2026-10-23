import type { Locator, Page } from "playwright";
import { expect } from "vitest";

export async function expectHistoryBoundaryState(scope: Page | Locator, loading: boolean) {
  const label = loading ? "Loading earlier…" : "Show earlier";
  const action = scope.getByRole("button", { name: label, exact: true });
  await action.waitFor({ state: "attached" });
  expect((await action.textContent())?.trim()).toBe(label);
  expect(await action.isDisabled()).toBe(loading);
  expect(await action.getAttribute("aria-busy")).toBe(String(loading));
  expect(await action.evaluate((element) => getComputedStyle(element).textTransform)).toBe(
    "uppercase",
  );
  const status = await action.getByRole("status").boundingBox();
  expect(status?.width).toBeGreaterThan(1);
  expect(status?.height).toBeGreaterThan(1);
  const animation = await scope
    .locator(".chat-history-boundary__line")
    .first()
    .evaluate((element) => getComputedStyle(element, "::after").animationName);
  expect(animation).toBe(loading ? "chat-history-comet" : "none");
  return action;
}
