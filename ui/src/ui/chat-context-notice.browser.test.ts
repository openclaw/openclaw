import { describe, expect, it } from "vitest";
import "../styles.css";
import { mountApp, registerAppMountHooks } from "./test-helpers/app-mount.ts";

registerAppMountHooks();

describe("chat context notice", () => {
  it("renders the context warning as a compact stacked notice instead of an oversized block", async () => {
    const app = mountApp("/chat");
    await app.updateComplete;

    app.sessionsResult = {
      count: 1,
      defaults: { contextTokens: 1000, model: "openai/gpt-5.2" },
      sessions: [
        {
          key: "main",
          inputTokens: 910,
          contextTokens: 1000,
          reasoningLevel: "off",
          model: "openai/gpt-5.2",
        },
      ],
    } as never;
    app.requestUpdate();
    await app.updateComplete;

    const notice = app.querySelector<HTMLElement>(".context-notice");
    expect(notice).not.toBeNull();
    expect(getComputedStyle(notice!).display).toBe("flex");
    expect(notice?.classList.contains("context-notice--stacked")).toBe(true);

    const summary = notice?.querySelector<HTMLElement>(".context-notice__summary");
    expect(summary?.textContent).toContain("Model context");
    expect(summary?.textContent).toContain("Used 910");
    expect(summary?.textContent).toContain("Limit 1k");
  });

  it("shows one summary row plus a pricing note for GPT-5.4 after the pricing threshold", async () => {
    const app = mountApp("/chat");
    await app.updateComplete;

    app.sessionsResult = {
      count: 1,
      defaults: { contextTokens: 272000, model: "gpt-5.4" },
      sessions: [
        {
          key: "main",
          inputTokens: 351000,
          contextTokens: 272000,
          reasoningLevel: "off",
          model: "gpt-5.4",
          modelProvider: "openai-codex",
        },
      ],
    } as never;
    app.requestUpdate();
    await app.updateComplete;

    const notice = app.querySelector<HTMLElement>(".context-notice");
    expect(notice).not.toBeNull();
    expect(notice?.textContent).toContain("Model context");
    expect(notice?.textContent).toContain("Used 351k");
    expect(notice?.textContent).toContain("Higher-rate 272k");
    expect(notice?.textContent).toContain("Limit 1.1M");
    expect(notice?.textContent).toContain("Higher-rate billing threshold crossed.");
    expect(notice?.textContent).not.toContain(
      "Estimated model context is at or beyond the ceiling",
    );
  });
});
