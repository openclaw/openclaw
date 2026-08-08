/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { renderChatComposer, resetChatComposerState } from "./components/chat-composer.ts";

type ComposerProps = Parameters<typeof renderChatComposer>[0];

function props(overrides: Partial<ComposerProps> = {}): ComposerProps {
  return {
    paneId: crypto.randomUUID(),
    sessionKey: "main",
    currentAgentId: "main",
    connected: true,
    canSend: true,
    disabledReason: null,
    sending: false,
    messages: [],
    stream: null,
    queue: [],
    draft: "",
    sessions: null,
    assistantName: "OpenClaw",
    onDraftChange: vi.fn(),
    onSend: vi.fn(),
    onQueueRemove: vi.fn(),
    onNewSession: vi.fn(),
    ...overrides,
  };
}

function renderComposer(overrides: Partial<ComposerProps> = {}) {
  const container = document.createElement("div");
  const composerProps = props(overrides);
  render(renderChatComposer(composerProps), container);
  return { container, props: composerProps };
}

afterEach(async () => {
  resetChatComposerState();
  localStorage.clear();
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await i18n.setLocale("en");
  vi.restoreAllMocks();
});

describe("renderChatComposer context usage", () => {
  it("renders session context and plan usage through the full composer", () => {
    const { container } = renderComposer({
      sessions: {
        sessions: [
          {
            key: "main",
            kind: "direct",
            updatedAt: null,
            totalTokens: 46_000,
            contextTokens: 200_000,
          },
        ],
        defaults: { contextTokens: 200_000 },
      } as never,
      providerUsage: {
        basePath: "/control",
        modelAuthStatusResult: {
          ts: Date.now(),
          providers: [
            {
              provider: "openai",
              displayName: "OpenAI",
              status: "ok",
              profiles: [{ profileId: "openai", type: "oauth", status: "ok" }],
              usage: { providerId: "openai", windows: [{ label: "Week", usedPercent: 72 }] },
            },
          ],
        },
      },
    });
    expect(container.querySelector(".context-ring")?.getAttribute("aria-label")).toBe(
      "Thread context usage: 46k of 200k (23%)",
    );
    expect(container.querySelector(".context-usage__plan-header")?.textContent).toContain(
      "Plan usage",
    );
    expect(container.querySelector(".context-usage__limit")?.textContent).toContain("72%");
  });

  it("renders plan usage before session metrics arrive", () => {
    const { container } = renderComposer({
      sessions: null,
      providerUsage: {
        basePath: "/control",
        modelAuthStatusResult: {
          ts: Date.now(),
          providers: [
            {
              provider: "openai",
              displayName: "OpenAI",
              status: "ok",
              profiles: [{ profileId: "openai", type: "oauth", status: "ok" }],
              usage: { providerId: "openai", windows: [{ label: "Week", usedPercent: 72 }] },
            },
          ],
        },
      },
    });

    expect(container.querySelector(".context-ring")?.getAttribute("aria-label")).toBe(
      "Usage Remaining",
    );
    expect(container.querySelector(".context-usage__bar")).toBeNull();
    expect(container.querySelector(".context-usage__limit")?.textContent).toContain("72%");
    expect(
      container
        .querySelector<HTMLAnchorElement>("[data-chat-provider-usage='true']")
        ?.getAttribute("href"),
    ).toBe("/control/usage");
  });

  it("prioritizes the active session provider over historical response usage", () => {
    const { container } = renderComposer({
      messages: [
        {
          role: "assistant",
          provider: "openai",
          responseModel: "gpt-5.6-sol",
          cost: { input: 0.01 },
        },
      ],
      sessions: {
        sessions: [
          {
            key: "main",
            kind: "direct",
            updatedAt: null,
            totalTokens: 46_000,
            contextTokens: 200_000,
            modelProvider: "anthropic",
          },
        ],
        defaults: { contextTokens: 200_000 },
      } as never,
      providerUsage: {
        modelAuthStatusResult: {
          ts: Date.now(),
          providers: [
            {
              provider: "openai",
              displayName: "OpenAI",
              status: "ok",
              profiles: [{ profileId: "openai", type: "oauth", status: "ok" }],
              usage: {
                providerId: "openai",
                windows: [{ label: "Week", usedPercent: 25 }],
              },
            },
            {
              provider: "claude-cli",
              displayName: "Claude",
              status: "ok",
              profiles: [{ profileId: "claude-cli", type: "oauth", status: "ok" }],
              usage: {
                providerId: "anthropic",
                windows: [{ label: "5h", usedPercent: 72 }],
              },
            },
          ],
        },
      },
    });

    expect(
      [...container.querySelectorAll(".context-usage__plan-header")].map((header) =>
        header.textContent?.replace(/\s+/g, " ").trim(),
      ),
    ).toEqual(["Plan usage · Claude", "Plan usage · OpenAI"]);
    expect(
      [...container.querySelectorAll(".context-usage__limit")].map((row) =>
        row.textContent?.replace(/\s+/g, " ").trim(),
      ),
    ).toEqual(["5-hour limit 72%", "Weekly · all models 25%"]);
    expect(
      [...container.querySelectorAll(".context-usage__model strong")].map(
        (value) => value.textContent,
      ),
    ).toEqual(["openai", "gpt-5.6-sol"]);
  });

  it("deduplicates provider aliases and hides cost estimates for subscriptions", () => {
    const resetAt = Date.now() + 2 * 3_600_000 + 45_000;
    const usage = {
      providerId: "anthropic",
      plan: "Max (20x)",
      windows: [
        { label: "5h", usedPercent: 22, resetAt },
        { label: "Week", usedPercent: 25 },
        { label: "Fable", usedPercent: 92 },
      ],
      billing: [{ type: "budget" as const, used: 157.85, limit: 400, unit: "USD" }],
    };
    const { container } = renderComposer({
      messages: [{ role: "user", content: "hi" }],
      sessions: {
        sessions: [
          {
            key: "main",
            kind: "direct",
            updatedAt: null,
            inputTokens: 2,
            outputTokens: 3,
            totalTokens: 78_700,
            contextTokens: 1_000_000,
            estimatedCostUsd: 0.02,
            model: "claude-fable-5",
            modelProvider: "anthropic",
          },
        ],
        defaults: { contextTokens: 1_000_000 },
      } as never,
      providerUsage: {
        modelAuthStatusResult: {
          ts: Date.now(),
          providers: [
            {
              provider: "anthropic",
              displayName: "Claude",
              status: "ok",
              profiles: [{ profileId: "anthropic:oauth", type: "oauth", status: "ok" }],
              usage,
            },
            {
              provider: "claude-cli",
              displayName: "Claude",
              status: "ok",
              profiles: [{ profileId: "claude-cli", type: "oauth", status: "ok" }],
              usage,
            },
          ],
        },
      },
    });

    expect(container.querySelectorAll(".context-usage__plan-header")).toHaveLength(1);
    expect(container.querySelector(".context-usage__plan-badge")?.textContent).toBe("Max (20x)");
    expect(
      [...container.querySelectorAll(".context-usage__limit")].map((row) =>
        row.textContent?.replace(/\s+/g, " ").trim(),
      ),
    ).toEqual([
      "5-hour limit Resets 2h 22%",
      "Weekly · all models 25%",
      "Fable 92%",
      "Usage credits $157.85 of $400.00",
    ]);
    expect(container.querySelector(".context-usage__stats")).not.toBeNull();
    expect(container.querySelector(".context-usage__stats--cost")).toBeNull();
    expect(container.textContent).not.toContain("Est. cost");
  });
});
