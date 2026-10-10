/* @vitest-environment jsdom */

import { createSignal, flush } from "@solidjs/signals";
import { render } from "@solidjs/web";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import { renderSessionActivitySummary } from "./session-activity-summary.tsx";

const disposals: Array<() => void> = [];

afterEach(() => {
  for (const dispose of disposals.splice(0)) {
    dispose();
  }
});

function session(activitySummary: GatewaySessionRow["activitySummary"]): GatewaySessionRow {
  return { key: "agent:main:recap", kind: "direct", activitySummary };
}

describe("Activity recap feedback", () => {
  it("updates a pending recap and retries the currently displayed session", () => {
    const [row, setRow] = createSignal(session({ state: "updating", text: "", canEnsure: true }));
    const container = document.createElement("div");
    const retry = vi.fn();
    disposals.push(
      render(
        () =>
          renderSessionActivitySummary({
            get row() {
              return row();
            },
            onRetry: retry,
          }),
        container,
      ),
    );
    flush();
    expect(container.querySelector(".skeleton")).not.toBeNull();

    const current = {
      ...session({ state: "stale", text: "Current recap", canEnsure: true }),
      key: "agent:main:next",
    };
    setRow(current);
    flush();
    expect(container.querySelector(".skeleton")).toBeNull();
    expect(container.querySelector("p")?.textContent).toBe("Current recap");
    expect(container.firstElementChild?.getAttribute("aria-busy")).toBe("false");
    container.querySelector<HTMLButtonElement>("button")?.click();
    expect(retry).toHaveBeenCalledWith(current);
  });

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
      disposals.push(
        render(() => renderSessionActivitySummary({ row, onRetry: retry }), container),
      );
      flush();
      expect(container.textContent).toContain("Fixed the search. Tests passed.");
      expect(container.textContent).toContain("Couldn’t refresh recap");
      expect(container.textContent).not.toContain("Recap unavailable");
      const button = container.querySelector<HTMLButtonElement>(
        ".activity-feed__note .activity-feed__note-action",
      );
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
    ["current", "", true, false],
  ] as const)("marks only pending generation busy (%s, %s, %s)", (state, text, canEnsure, busy) => {
    const container = document.createElement("div");
    disposals.push(
      render(
        () =>
          renderSessionActivitySummary({
            row: session({ state, text, canEnsure }),
            onRetry: vi.fn(),
          }),
        container,
      ),
    );
    flush();
    expect(container.firstElementChild?.getAttribute("aria-busy")).toBe(String(busy));
    expect(Boolean(container.querySelector(".skeleton"))).toBe(busy && !text);
    expect(container.querySelector(".activity-feed__note")?.textContent ?? "").not.toContain(
      "Updating recap",
    );
    if (text) {
      expect(container.querySelector("p")?.textContent).toBe(text);
    }
    if (busy) {
      expect(container.querySelector('[role="status"]')?.textContent).toContain("Updating recap");
    }
  });
});
