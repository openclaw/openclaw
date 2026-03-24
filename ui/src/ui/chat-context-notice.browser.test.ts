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
          totalTokens: 910,
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

  it("shows current model context separately from cumulative usage after the pricing threshold", async () => {
    const app = mountApp("/chat");
    await app.updateComplete;

    app.sessionsResult = {
      count: 1,
      defaults: { contextTokens: 272000, model: "gpt-5.4" },
      sessions: [
        {
          key: "main",
          inputTokens: 3_300_000,
          totalTokens: 270_000,
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
    expect(notice?.textContent).toContain("Used 270k");
    expect(notice?.textContent).not.toContain("Used 3.3M");
    expect(notice?.textContent).toContain("Higher-rate 272k");
    expect(notice?.textContent).toContain("Limit 1.1M");
    expect(notice?.textContent).toContain("Higher-rate billing threshold crossed.");
    expect(notice?.textContent).toContain(
      "Auto-compaction tracks current context, not cumulative session usage.",
    );
    expect(notice?.textContent).not.toContain(
      "Estimated model context is at or beyond the ceiling",
    );
  });

  it("falls back to input tokens when totalTokens is missing, even for stale gateway rows", async () => {
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
          totalTokensFresh: false,
          reasoningLevel: "off",
          model: "openai/gpt-5.2",
        },
      ],
    } as never;
    app.requestUpdate();
    await app.updateComplete;

    const notice = app.querySelector<HTMLElement>(".context-notice");
    expect(notice).not.toBeNull();
    expect(notice?.textContent).toContain("Model context");
    expect(notice?.textContent).toContain("Used 910");
    expect(notice?.textContent).toContain("Limit 1k");
  });

  it("ignores stale totalTokens when deriving model-limit warnings", async () => {
    const app = mountApp("/chat");
    await app.updateComplete;

    app.sessionsResult = {
      count: 1,
      defaults: { contextTokens: 272000, model: "openai/gpt-5.4" },
      sessions: [
        {
          key: "main",
          inputTokens: 1_000,
          totalTokens: 950_000,
          totalTokensFresh: false,
          contextTokens: 272000,
          reasoningLevel: "off",
          model: "openai/gpt-5.4",
        },
      ],
    } as never;
    app.requestUpdate();
    await app.updateComplete;

    const notice = app.querySelector<HTMLElement>(".context-notice");
    expect(notice).toBeNull();
  });

  it("keeps pricing-threshold notices for legacy google-gemini-cli gemini-3-pro-preview sessions", async () => {
    const app = mountApp("/chat");
    await app.updateComplete;

    app.sessionsResult = {
      count: 1,
      defaults: { contextTokens: 1_048_576, model: "google-gemini-cli/gemini-3-pro-preview" },
      sessions: [
        {
          key: "main",
          inputTokens: 240_000,
          totalTokens: 180_000,
          contextTokens: 1_048_576,
          reasoningLevel: "off",
          model: "gemini-3-pro-preview",
          modelProvider: "google-gemini-cli",
        },
      ],
    } as never;
    app.requestUpdate();
    await app.updateComplete;

    const notice = app.querySelector<HTMLElement>(".context-notice");
    expect(notice).not.toBeNull();
    expect(notice?.textContent).toContain("Model context");
    expect(notice?.textContent).toContain("Used 180k");
    expect(notice?.textContent).toContain("Higher-rate 200k");
    expect(notice?.textContent).toContain("Limit 1M");
    expect(notice?.textContent).toContain("Higher-rate billing threshold crossed.");
  });

  it("uses the default provider when the session model id is unqualified", async () => {
    const app = mountApp("/chat");
    await app.updateComplete;

    app.sessionsResult = {
      count: 1,
      defaults: {
        contextTokens: 272000,
        model: "gpt-5.4",
        modelProvider: "openai-codex",
      },
      sessions: [
        {
          key: "main",
          inputTokens: 300_000,
          totalTokens: 180_000,
          contextTokens: 272000,
          reasoningLevel: "off",
          model: "gpt-5.4",
        },
      ],
    } as never;
    app.requestUpdate();
    await app.updateComplete;

    const notice = app.querySelector<HTMLElement>(".context-notice");
    expect(notice).not.toBeNull();
    expect(notice?.textContent).toContain("Model context");
    expect(notice?.textContent).toContain("Used 180k");
    expect(notice?.textContent).toContain("Higher-rate 272k");
    expect(notice?.textContent).toContain("Limit 1.1M");
    expect(notice?.textContent).toContain("Higher-rate billing threshold crossed.");
  });

  it("keeps the 85% model warning for known models before the pricing threshold", async () => {
    const app = mountApp("/chat");
    await app.updateComplete;

    app.sessionsResult = {
      count: 1,
      defaults: { contextTokens: 272000, model: "gpt-5.4" },
      sessions: [
        {
          key: "main",
          inputTokens: 200_000,
          totalTokens: 950_000,
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
    expect(notice?.textContent).toContain("Used 950k");
    expect(notice?.textContent).toContain("Higher-rate 272k");
    expect(notice?.textContent).toContain("Limit 1.1M");
    expect(notice?.textContent).not.toContain("Higher-rate billing threshold crossed.");
    expect(notice?.textContent).not.toContain(
      "Auto-compaction tracks current context, not cumulative session usage.",
    );
  });
});
