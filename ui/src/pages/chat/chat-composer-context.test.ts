/* @vitest-environment jsdom */

import { afterEach, describe, expect, it } from "vitest";
import { contextBudgetStatusFixture } from "../../../../src/config/sessions/context-budget.test-support.js";
import type {
  GatewaySessionRow,
  ModelAuthStatusProfile,
  ModelAuthStatusProvider,
  SessionsListResult,
} from "../../api/types.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { renderComposerFixture, resetComposerFixture } from "./chat-composer.test-support.ts";

type ComposerOverrides = Parameters<typeof renderComposerFixture>[0];

function renderComposer(overrides: ComposerOverrides = {}) {
  const container = renderComposerFixture(overrides).container;
  document.body.append(container);
  container.querySelector<HTMLElement>(".context-usage summary")?.click();
  flush();
  return container;
}

function sessionRow(overrides: Partial<GatewaySessionRow>): GatewaySessionRow {
  return { key: "main", kind: "direct", updatedAt: null, ...overrides };
}

function tokenSession(totalTokens: number, overrides: Partial<GatewaySessionRow> = {}) {
  return sessionRow({ totalTokens, contextTokens: 200_000, ...overrides });
}

function assistant(fields: Record<string, unknown>) {
  return { role: "assistant", content: "hello", ...fields };
}

function sessions(contextTokens = 200_000, rows: GatewaySessionRow[] = []): SessionsListResult {
  return { ts: 1, path: "", count: rows.length, sessions: rows, defaults: { contextTokens } };
}

function ring(container: HTMLElement) {
  return container.querySelector(".context-ring");
}

function part(container: HTMLElement, name: string) {
  return container.querySelector(`.context-usage__${name}`);
}

function texts(container: HTMLElement, selector: string) {
  return [...container.querySelectorAll(selector)].map((row) =>
    row.textContent?.replace(/\s+/g, " ").trim(),
  );
}

function planProvider(
  provider: string,
  displayName: string,
  usage: NonNullable<ModelAuthStatusProvider["usage"]> | number,
  profile?: Pick<ModelAuthStatusProfile, "profileId" | "type">,
): ModelAuthStatusProvider {
  return {
    provider,
    displayName,
    status: "ok",
    profiles: [{ ...(profile ?? { profileId: provider, type: "oauth" }), status: "ok" }],
    usage:
      typeof usage === "number"
        ? { providerId: provider, windows: [{ label: "Week", usedPercent: usage }] }
        : usage,
  };
}

function planUsage(providers: ModelAuthStatusProvider[], basePath?: string) {
  return {
    ...(basePath ? { basePath } : {}),
    modelAuthStatusResult: { ts: Date.now(), providers },
  };
}

afterEach(() => resetComposerFixture());

describe("renderChatComposer context usage", () => {
  it("uses the last-run prompt budget with fresh usage", () => {
    const container = renderComposer({
      selectedSession: tokenSession(160_000, {
        updatedAt: 2,
        totalTokensFresh: true,
        contextBudgetStatus: contextBudgetStatusFixture(),
      }),
    });
    expect(ring(container)?.textContent?.trim()).toBe("");
    expect(ring(container)?.getAttribute("title")).toBe("Open context usage details");
    expect(part(container, "context-value")?.textContent).toContain("180k");
    expect(part(container, "title")?.textContent).toBe("Prompt budget");
    expect(ring(container)?.classList.contains("context-ring--warning")).toBe(true);
  });

  it("does not reuse a global row owned by another agent", () => {
    const session = tokenSession(46_000, {
      key: "global",
      kind: "global",
    });
    const container = renderComposer({
      sessionKey: "global",
      currentAgentId: "work",
      selectedSession: undefined,
      sessions: sessions(200_000, [session]),
    });

    expect(ring(container)?.getAttribute("aria-label") ?? null).toBe(null);
  });

  it("renders plan usage before session metrics arrive", () => {
    const container = renderComposer({
      sessions: null,
      messages: [assistant({ provider: "openai" })],
      providerUsage: planUsage([planProvider("openai", "OpenAI", 72)], "/control"),
    });

    expect(ring(container)?.getAttribute("aria-label")).toBe("Usage Remaining");
    expect(part(container, "bar")).toBeNull();
    expect(part(container, "limit")?.textContent).toContain("72%");
    const link = container.querySelector("[data-chat-provider-usage='true']");
    expect(link?.getAttribute("href")).toBe("/control/usage");
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
          ...sessions(200_000, [session]),
          defaults: {
            modelProvider: "openai",
            model: "default-model",
            contextTokens: 200_000,
          },
        },
        providerUsage: withPlanUsage
          ? planUsage([planProvider("openai", "OpenAI", 72)])
          : undefined,
      });

      expect(part(container, "context-value")).toBeNull();
      expect(part(container, "bar")).toBeNull();
      const summary = ring(container);
      if (withPlanUsage) {
        expect(summary?.getAttribute("aria-label")).toBe("Usage Remaining");
        expect(part(container, "limit")?.textContent).toContain("72%");
      } else {
        expect(summary).toBeNull();
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
      sessions: sessions(1_000_000),
      providerUsage: planUsage([
        planProvider("anthropic", "Claude", usage, { profileId: "anthropic:oauth", type: "oauth" }),
        planProvider("claude-cli", "Claude", usage),
      ]),
    });

    expect(container.querySelectorAll(".context-usage__plan-header")).toHaveLength(1);
    expect(part(container, "plan-badge")?.textContent).toBe("Max (20x)");
    expect(texts(container, ".context-usage__limit")).toEqual([
      "5-hour limit Resets 2h 22%",
      "Weekly 25%",
      "Fable 92%",
      "Usage credits $157.85 of $400.00",
    ]);
    expect(part(container, "stats")).not.toBeNull();
    expect(container.textContent).not.toContain("Est. cost");
  });

  it("uses response provenance only when the session provider is absent", () => {
    const session = tokenSession(1_000, {
      model: "gateway-injected",
      modelProvider: "openclaw",
    });
    const composerProps = {
      messages: [
        { role: "user", content: "hi" },
        assistant({
          cost: { input: 0.01, output: 0.02 },
          provider: "openai",
          responseModel: "gpt-5.5",
        }),
      ],
      selectedSession: session,
      sessions: sessions(200_000, [session]),
      providerUsage: planUsage([
        planProvider("anthropic", "Claude", 25, { profileId: "anthropic:oauth", type: "oauth" }),
        planProvider("openai", "OpenAI", 72),
      ]),
    };
    const providerNames = (container: HTMLElement) =>
      texts(container, "[data-chat-usage-provider='true']");

    const container = renderComposer(composerProps);

    expect(providerNames(container)).toEqual([]);
    expect(container.textContent).toContain("Cost by Type");
    expect(container.textContent).not.toContain("Model:");

    session.modelProvider = undefined;
    expect(providerNames(renderComposer(composerProps))).toEqual(["Provider: OpenAI"]);
  });

  it("keeps context, token, and cost details when only unrelated plan usage exists", () => {
    const container = renderComposer({
      selectedSession: tokenSession(46_000, {
        inputTokens: 800,
        outputTokens: 200,
        estimatedCostUsd: 0.03,
        modelProvider: "openai",
      }),
      sessions: sessions(),
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

    const popoverText = part(container, "popover")?.textContent ?? "";
    expect(part(container, "plan-header")).toBeNull();
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
        assistant({
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          provider: "openai",
          responseModel: "gpt-zero",
        }),
        assistant({
          model: "gateway-injected",
          provider: "openclaw",
          usage: {
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        }),
      ],
      selectedSession: tokenSession(1_000),
      sessions: sessions(),
    });

    expect(container.textContent).not.toContain("Cost by Type");
  });

  it("warns on fresh high usage but keeps stale usage approximate", () => {
    let container = renderComposer({
      selectedSession: tokenSession(190_000),
      sessions: sessions(),
    });
    expect(ring(container)?.getAttribute("aria-label")).toBe(
      "Session context usage: 190k of 200k (95%)",
    );
    expect(ring(container)?.classList).toContain("context-ring--warning");
    expect(container.textContent).not.toContain("Compact");

    container = renderComposer({
      selectedSession: tokenSession(190_000, { totalTokensFresh: false }),
      sessions: sessions(),
    });
    expect(ring(container)?.getAttribute("aria-label")).toBe(
      "Session context usage: ~190k of 200k (~95%)",
    );
    expect(ring(container)?.classList).not.toContain("context-ring--warning");
  });
});
