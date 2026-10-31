/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import { createSolidApplicationContextProvider } from "../../test-helpers/solid-application-context.tsx";
import { flush } from "../../test-helpers/solid-settle.ts";
import { mountSolid, props } from "./session-activity-view.test-harness.ts";
import { renderSessionActivityView } from "./session-activity-view.tsx";

const renderActivity = mountSolid<ReturnType<typeof props>>(
  renderSessionActivityView,
  (input) => createSolidApplicationContextProvider(input.context).wrapper,
);

function showRecap(row: GatewaySessionRow, retry: (row: GatewaySessionRow) => void) {
  const container = document.createElement("div");
  document.body.append(container);
  const input = props({ rows: [row], onSummaryRetry: retry });
  renderActivity(input, container);
  return {
    recap: () => container.querySelector<HTMLElement>(".activity-feed__recap")!,
    update: (next: GatewaySessionRow) =>
      renderActivity(
        props({ rows: [next], context: input.context, onSummaryRetry: retry }),
        container,
      ),
  };
}

function session(activitySummary: GatewaySessionRow["activitySummary"]): GatewaySessionRow {
  return { key: "agent:main:recap", kind: "direct", activitySummary };
}

describe("Activity recap feedback", () => {
  it("updates a pending recap and retries the currently displayed session", () => {
    const retry = vi.fn();
    const { recap, update } = showRecap(
      session({ state: "updating", text: "", canEnsure: true }),
      retry,
    );
    flush();
    expect(recap().querySelector(".skeleton")).not.toBeNull();

    const current = {
      ...session({ state: "stale", text: "Current recap", canEnsure: true }),
      key: "agent:main:next",
    };
    update(current);
    flush();
    expect(recap().querySelector(".skeleton")).toBeNull();
    expect(recap().querySelector("p")?.textContent).toBe("Current recap");
    expect(recap().getAttribute("aria-busy")).toBe("false");
    recap().querySelector<HTMLButtonElement>("button")?.click();
    expect(retry).toHaveBeenCalledWith(current);
  });

  it.each([true, false])(
    "retains a cached recap after refresh failure (canEnsure=%s)",
    (canEnsure) => {
      const retry = vi.fn();
      const row = session({
        state: "unavailable",
        text: "Fixed the search. Tests passed.",
        canEnsure,
      });
      const { recap } = showRecap(row, retry);
      flush();
      const container = recap();
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
    const { recap } = showRecap(session({ state, text, canEnsure }), vi.fn());
    flush();
    const container = recap();
    expect(container.getAttribute("aria-busy")).toBe(String(busy));
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
