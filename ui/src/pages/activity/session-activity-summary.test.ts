/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import { renderSessionActivitySummary } from "./session-activity-summary.ts";

function session(activitySummary: GatewaySessionRow["activitySummary"]): GatewaySessionRow {
  return { key: "agent:main:recap", kind: "direct", activitySummary };
}

describe("Activity recap feedback", () => {
  it.each([true, false])(
    "retains a cached recap after refresh failure (canEnsure=%s)",
    (canEnsure) => {
      const container = document.createElement("div");
      const retry = vi.fn();
      const row = session({
        state: "unavailable",
        text: "Fixed the search. Tests passed.",
        canEnsure,
      });
      render(renderSessionActivitySummary(row, retry), container);
      expect(container.textContent).toContain("Fixed the search. Tests passed.");
      expect(container.textContent).toContain("Couldn’t refresh recap");
      expect(container.textContent).not.toContain("Recap unavailable");
      const button = container.querySelector<HTMLButtonElement>("button");
      expect(Boolean(button)).toBe(canEnsure);
      button?.click();
      expect(retry).toHaveBeenCalledTimes(canEnsure ? 1 : 0);
      expect(container.querySelector('[aria-busy="true"]')).toBeNull();
    },
  );

  it.each([
    ["updating", "", false, true],
    ["updating", "Search is fixed. Validation is running.", true, true],
    ["stale", "", true, false],
    ["stale", "", false, false],
    ["current", "", true, false],
    ["unavailable", "", true, false],
  ] as const)("marks only pending generation busy (%s, %s, %s)", (state, text, canEnsure, busy) => {
    const container = document.createElement("div");
    render(renderSessionActivitySummary(session({ state, text, canEnsure }), vi.fn()), container);
    expect(container.firstElementChild?.getAttribute("aria-busy")).toBe(String(busy));
    expect(Boolean(container.querySelector(".skeleton"))).toBe(busy && !text);
    expect(
      container.querySelector(".activity-feed__recap-feedback")?.textContent ?? "",
    ).not.toContain("Updating recap");
    if (text) {
      expect(container.querySelector("p")?.textContent).toBe(text);
    }
    if (busy) {
      expect(container.querySelector('[role="status"]')?.textContent).toContain("Updating recap");
    }
  });
});
