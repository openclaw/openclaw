/* @vitest-environment jsdom */

import { afterEach, describe, expect, it } from "vitest";
import { contextBudgetStatusFixture } from "../../../../src/config/sessions/context-budget.test-support.js";
import type {
  GatewaySessionRow,
  ModelAuthStatusProfile,
  ModelAuthStatusProvider,
} from "../../api/types.ts";
import { renderComposerFixture, resetComposerFixture } from "./chat-composer.test-support.ts";

type ComposerOverrides = Parameters<typeof renderComposerFixture>[0];

function renderComposer(overrides: ComposerOverrides = {}) {
  return renderComposerFixture(overrides).container;
}

function sessionRow(overrides: Partial<GatewaySessionRow>): GatewaySessionRow {
  return { key: "main", kind: "direct", updatedAt: null, ...overrides };
}

function planProvider(
  provider: string,
  displayName: string,
  usage: NonNullable<ModelAuthStatusProvider["usage"]>,
  profile: Pick<ModelAuthStatusProfile, "profileId" | "type"> = {
    profileId: provider,
    type: "oauth",
  },
): ModelAuthStatusProvider {
  return { provider, displayName, status: "ok", profiles: [{ ...profile, status: "ok" }], usage };
}

function planUsage(providers: ModelAuthStatusProvider[], basePath?: string) {
  return {
    ...(basePath ? { basePath } : {}),
    modelAuthStatusResult: { ts: Date.now(), providers },
  };
}

afterEach(async () => {
  await resetComposerFixture();
});

describe("renderChatComposer context usage", () => {
  it("uses the last-run prompt budget with fresh usage", () => {
    const container = renderComposer({
      selectedSession: sessionRow({
        updatedAt: 2,
        totalTokens: 160_000,
        totalTokensFresh: true,
        contextTokens: 200_000,
        contextBudgetStatus: contextBudgetStatusFixture(),
      }),
    });
    expect(container.querySelector(".context-ring")?.textContent?.trim()).toBe("Context");
    expect(container.querySelector(".context-usage__context-value")?.textContent).toContain("180k");
    expect(container.querySelector(".context-usage__title")?.textContent).toBe("Prompt budget");
    expect(
      container.querySelector(".context-ring")?.classList.contains("context-ring--warning"),
    ).toBe(true);
  });

  it("does not reuse a global row owned by another agent", () => {
    const session: GatewaySessionRow = {
      key: "global",
      kind: "global",
      updatedAt: null,
      totalTokens: 46_000,
      contextTokens: 200_000,
    };
    const container = renderComposer({
      sessionKey: "global",
      currentAgentId: "work",
      selectedSession: undefined,
      sessions: { sessions: [session], defaults: { contextTokens: 200_000 } } as never,
    });

    expect(container.querySelector(".context-ring")?.getAttribute("aria-label") ?? null).toBe(null);
  });

  it("renders plan usage before session metrics arrive", () => {
    const container = renderComposer({
      sessions: null,
      messages: [{ role: "assistant", content: "hello", provider: "openai" }],
      providerUsage: planUsage(
        [
          planProvider("openai", "OpenAI", {
            providerId: "openai",
            windows: [{ label: "Week", usedPercent: 72 }],
          }),
        ],
        "/control",
      ),
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

  it.each([false, true])(
    "does not borrow the default model's capacity when session capacity is unknown (plan usage: %s)",
    (withPlanUsage) => {
      const session = sessionRow({
        modelProvider: "openai",
        model: "selected-model",
        totalTokens: 46_000,
        totalTokensFresh: true,
      });
      const container = renderComposer({
        selectedSession: session,
        sessions: {
          ts: 1,
          path: "",
          count: 1,
          sessions: [session],
          defaults: {
            modelProvider: "openai",
            model: "default-model",
            contextTokens: 200_000,
          },
        },
        providerUsage: withPlanUsage
          ? planUsage([
              planProvider("openai", "OpenAI", {
                providerId: "openai",
                windows: [{ label: "Week", usedPercent: 72 }],
              }),
            ])
          : undefined,
      });

      expect(container.querySelector(".context-usage__context-value")).toBeNull();
      expect(container.querySelector(".context-usage__bar")).toBeNull();
      const ring = container.querySelector(".context-ring");
      if (withPlanUsage) {
        expect(ring?.getAttribute("aria-label")).toBe("Usage Remaining");
        expect(container.querySelector(".context-usage__limit")?.textContent).toContain("72%");
      } else {
        expect(ring).toBeNull();
      }
    },
  );

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
    const container = renderComposer({
      messages: [{ role: "user", content: "hi" }],
      selectedSession: sessionRow({
        inputTokens: 2,
        outputTokens: 3,
        totalTokens: 78_700,
        contextTokens: 1_000_000,
        estimatedCostUsd: 0.02,
        model: "claude-fable-5",
        modelProvider: "anthropic",
      }),
      sessions: {
        sessions: [],
        defaults: { contextTokens: 1_000_000 },
      } as never,
      providerUsage: planUsage([
        planProvider("anthropic", "Claude", usage, { profileId: "anthropic:oauth", type: "oauth" }),
        planProvider("claude-cli", "Claude", usage),
      ]),
    });

    expect(container.querySelectorAll(".context-usage__plan-header")).toHaveLength(1);
    expect(container.querySelector(".context-usage__plan-badge")?.textContent).toBe("Max (20x)");
    expect(
      [...container.querySelectorAll(".context-usage__limit")].map((row) =>
        row.textContent?.replace(/\s+/g, " ").trim(),
      ),
    ).toEqual([
      "5-hour limit Resets 2h 22%",
      "Weekly 25%",
      "Fable 92%",
      "Usage credits $157.85 of $400.00",
    ]);
    expect(container.querySelector(".context-usage__stats")).not.toBeNull();
    expect(container.textContent).not.toContain("Est. cost");
  });

  it("uses response provenance only when the session provider is absent", () => {
    const session = {
      key: "main",
      kind: "direct",
      updatedAt: null,
      totalTokens: 1_000,
      contextTokens: 200_000,
      model: "gateway-injected",
      modelProvider: "openclaw" as string | undefined,
    };
    const composerProps = {
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: "hello",
          cost: { input: 0.01, output: 0.02 },
          provider: "openai",
          responseModel: "gpt-5.5",
        },
      ],
      selectedSession: session,
      sessions: {
        sessions: [session],
        defaults: { contextTokens: 200_000 },
      },
      providerUsage: planUsage([
        planProvider(
          "anthropic",
          "Claude",
          {
            providerId: "anthropic",
            windows: [{ label: "Week", usedPercent: 25 }],
          },
          { profileId: "anthropic:oauth", type: "oauth" },
        ),
        planProvider("openai", "OpenAI", {
          providerId: "openai",
          windows: [{ label: "Week", usedPercent: 72 }],
        }),
      ]),
    };
    const providerNames = (container: HTMLElement) =>
      [...container.querySelectorAll("[data-chat-usage-provider='true']")].map((row) =>
        row.textContent?.replace(/\s+/g, " ").trim(),
      );

    const container = renderComposer(composerProps as never);

    expect(providerNames(container)).toEqual([]);
    expect(container.textContent).toContain("Cost by Type");
    expect(container.textContent).not.toContain("Model:");

    session.modelProvider = undefined;
    expect(providerNames(renderComposer(composerProps as never))).toEqual(["Provider: OpenAI"]);
  });

  it("keeps context, token, and cost details when only unrelated plan usage exists", () => {
    const container = renderComposer({
      selectedSession: sessionRow({
        inputTokens: 800,
        outputTokens: 200,
        totalTokens: 46_000,
        contextTokens: 200_000,
        estimatedCostUsd: 0.03,
        modelProvider: "openai",
      }),
      sessions: {
        sessions: [],
        defaults: { contextTokens: 200_000 },
      } as never,
      providerUsage: planUsage([
        planProvider(
          "github-copilot",
          "Copilot",
          {
            providerId: "github-copilot",
            windows: [{ label: "Day", usedPercent: 41 }],
          },
          { profileId: "github-copilot", type: "token" },
        ),
      ]),
    });

    const popoverText = container.querySelector(".context-usage__popover")?.textContent ?? "";
    expect(container.querySelector(".context-usage__plan-header")).toBeNull();
    expect(popoverText).not.toContain("Copilot");
    expect(popoverText).toContain("Context window");
    expect(popoverText).toContain("Latest run tokens");
    expect(popoverText).toContain("Est. cost");
    expect(popoverText).toContain("$0.03");
  });

  it("omits the cost-by-type section when every recorded cost is zero", () => {
    const container = renderComposer({
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: "hello",
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          provider: "openai",
          responseModel: "gpt-zero",
        },
        {
          role: "assistant",
          content: "hello",
          model: "gateway-injected",
          provider: "openclaw",
          usage: {
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        },
      ],
      selectedSession: sessionRow({ totalTokens: 1_000, contextTokens: 200_000 }),
      sessions: {
        sessions: [],
        defaults: { contextTokens: 200_000 },
      } as never,
    });

    expect(container.textContent).not.toContain("Cost by Type");
  });

  it("warns on fresh high usage but keeps stale usage approximate", () => {
    let container = renderComposer({
      selectedSession: sessionRow({ totalTokens: 190_000, contextTokens: 200_000 }),
      sessions: {
        sessions: [],
        defaults: { contextTokens: 200_000 },
      } as never,
    });
    const contextRing = container.querySelector(".context-ring");
    expect(contextRing?.getAttribute("aria-label")).toBe(
      "Session context usage: 190k of 200k (95%)",
    );
    expect(contextRing?.classList).toContain("context-ring--warning");
    expect(container.textContent).not.toContain("Compact");

    container = renderComposer({
      selectedSession: sessionRow({
        totalTokens: 190_000,
        totalTokensFresh: false,
        contextTokens: 200_000,
      }),
      sessions: {
        sessions: [],
        defaults: { contextTokens: 200_000 },
      } as never,
    });
    expect(container.querySelector(".context-ring")?.getAttribute("aria-label")).toBe(
      "Session context usage: ~190k of 200k (~95%)",
    );
    expect(container.querySelector(".context-ring")?.classList).not.toContain(
      "context-ring--warning",
    );
  });
});
