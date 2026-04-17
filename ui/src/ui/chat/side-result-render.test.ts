/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { renderSideResult } from "./side-result-render.ts";

describe("side result render", () => {
  it("renders, dismisses, and styles BTW side results outside transcript history", () => {
    const container = document.createElement("div");
    const onDismissSideResult = vi.fn();

    render(
      renderSideResult(
        {
          kind: "btw",
          runId: "btw-run-1",
          sessionKey: "main",
          question: "what changed?",
          text: "The web UI now renders **BTW** separately.",
          isError: false,
          ts: 2,
        },
        onDismissSideResult,
      ),
      container,
    );

    expect(container.querySelector(".chat-side-result")).not.toBeNull();
    expect(container.textContent).toContain("BTW");
    expect(container.textContent).toContain("what changed?");
    expect(container.textContent).toContain("Not saved to chat history");
    expect(container.querySelectorAll(".chat-side-result")).toHaveLength(1);

    const button = container.querySelector<HTMLButtonElement>(".chat-side-result__dismiss");
    expect(button).not.toBeNull();
    button?.click();
    expect(onDismissSideResult).toHaveBeenCalledTimes(1);

    render(
      renderSideResult({
        kind: "btw",
        runId: "btw-run-3",
        sessionKey: "main",
        question: "what failed?",
        text: "The side question could not be answered.",
        isError: true,
        ts: 4,
      }),
      container,
    );

    expect(container.querySelector(".chat-side-result--error")).not.toBeNull();
  });
});
