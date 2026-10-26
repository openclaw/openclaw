/* @vitest-environment jsdom */

import { createComponent, createSignal } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { contextBudgetStatusFixture } from "../../../../src/config/sessions/context-budget.test-support.js";
import type {
  GatewaySessionRow,
  ModelAuthStatusProfile,
  ModelAuthStatusProvider,
} from "../../api/types.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { renderComposerFixture, resetComposerFixture } from "./chat-composer.test-support.ts";
import { ContextNotice } from "./components/chat-composer-context.tsx";

type ComposerOverrides = Parameters<typeof renderComposerFixture>[0];

function renderComposer(overrides: ComposerOverrides = {}) {
  const container = renderComposerFixture(overrides).container;
  document.body.append(container);
  container.querySelector<HTMLElement>(".context-usage summary")?.click();
  flush();
  return container;
}

const part = (root: ParentNode, name: string) => root.querySelector(`.context-usage__${name}`);
const contextRingFor = (root: ParentNode) => root.querySelector(".context-ring");
const statsTitle = (root: ParentNode) => part(root, "stats [title]")?.getAttribute("title");
const defaultSessions = () => ({ sessions: [], defaults: { contextTokens: 200_000 } });

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

const weekly = (
  provider: string,
  displayName: string,
  usedPercent: number,
  profile?: Pick<ModelAuthStatusProfile, "profileId" | "type">,
) =>
  planProvider(
    provider,
    displayName,
    { providerId: provider, windows: [{ label: "Week", usedPercent }] },
    profile,
  );

afterEach(async () => {
  await resetComposerFixture();
});

describe("renderChatComposer context usage", () => {
  it("reads provider costs only while the usage popover is open", () => {
    let costReads = 0;
    const message = (output: number) => ({
      role: "assistant",
      provider: "example",
      get cost() {
        costReads += 1;
        return { output };
      },
    });
    const [messages, setMessages] = createSignal([message(0.01)]);
    const view = mountSolid(() =>
      createComponent(ContextNotice, {
        session: sessionRow({ totalTokens: 1_000, contextTokens: 200_000, estimatedCostUsd: 0.03 }),
        get messages() {
          return messages();
        },
      }),
    );
    flush();
    const toggle = () => {
      view.container.querySelector<HTMLElement>(".context-usage summary")!.click();
      flush();
    };
    try {
      expect(costReads).toBe(0);
      toggle();
      expect(view.container.textContent).toContain("$0.03");
      expect(statsTitle(view.container)).toBe("Output $0.01");
      expect(costReads).toBe(1);
      toggle();
      setMessages([message(0.02)]);
      flush();
      expect(costReads).toBe(1);
      toggle();
      expect(view.container.textContent).toContain("$0.03");
      expect(statsTitle(view.container)).toBe("Output $0.02");
      expect(costReads).toBe(2);
    } finally {
      view.unmount();
    }
  });

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
    expect(contextRingFor(container)?.textContent?.trim()).toBe("");
    expect(contextRingFor(container)?.getAttribute("title")).toBe("Open context usage details");
    expect(part(container, "context-value")?.textContent).toContain("180k");
    expect(part(container, "title")?.textContent).toBe("Prompt budget");
    expect(contextRingFor(container)?.classList.contains("context-ring--warning")).toBe(true);
  });

  it("does not reuse a global row owned by another agent", () => {
    const session = sessionRow({
      key: "global",
      kind: "global",
      totalTokens: 46_000,
      contextTokens: 200_000,
    });
    const container = renderComposer({
      sessionKey: "global",
      currentAgentId: "work",
      selectedSession: undefined,
      sessions: { sessions: [session], defaults: { contextTokens: 200_000 } } as never,
    });

    expect(contextRingFor(container)?.getAttribute("aria-label") ?? null).toBe(null);
  });

  it("renders plan usage before session metrics arrive", () => {
    const container = renderComposer({
      sessions: null,
      messages: [{ role: "assistant", content: "hello", provider: "openai" }],
      providerUsage: planUsage(
        [
          planProvider("openai", "OpenAI", {
            providerId: "openai",
            windows: [
              { label: "5h", usedPercent: 34 },
              { label: "Week", usedPercent: 78 },
            ],
          }),
        ],
        "/control",
      ),
    });

    expect(contextRingFor(container)?.getAttribute("aria-label")).toBe("Usage Remaining");
    expect(part(container, "bar")).toBeNull();
    expect(
      [...container.querySelectorAll(".context-usage__limit-value")].map((row) => row.textContent),
    ).toEqual(["34%", "78%"]);
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
        providerUsage: withPlanUsage ? planUsage([weekly("openai", "OpenAI", 72)]) : undefined,
      });

      expect(part(container, "context-value")).toBeNull();
      expect(part(container, "bar")).toBeNull();
      const ring = contextRingFor(container);
      if (withPlanUsage) {
        expect(ring?.getAttribute("aria-label")).toBe("Usage Remaining");
        expect(part(container, "limit")?.textContent).toContain("72%");
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

    expect(container.querySelectorAll(".context-usage__tray")).toHaveLength(1);
    expect(part(container, "plan-badge")?.textContent).toBe("Max (20x)");
    const limits = [...container.querySelectorAll(".context-usage__limit")];
    expect(
      limits.map((row) => row.querySelector(".context-usage__limit-label")?.textContent),
    ).toEqual(["5-hour", "Weekly", "Fable", "Usage credits"]);
    expect(
      limits.map((row) => row.querySelector(".context-usage__limit-value")?.textContent),
    ).toEqual(["22%", "25%", "92%", "$157.85 of $400.00"]);
    expect(
      limits
        .slice(0, 3)
        .every((row) =>
          row
            .querySelector(".context-usage__limit-reset")
            ?.getAttribute("title")
            ?.startsWith("Resets "),
        ),
    ).toBe(true);
    expect(limits[3]?.querySelector(".context-usage__limit-reset")).toBeNull();
    expect(part(container, "stats")).not.toBeNull();
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
      estimatedCostUsd: 0.03,
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
        weekly("anthropic", "Claude", 25, { profileId: "anthropic:oauth", type: "oauth" }),
        weekly("openai", "OpenAI", 72),
      ]),
    };
    const providerNames = (container: HTMLElement) =>
      [...container.querySelectorAll(".context-usage__identity .provider-brand-icon")].map((row) =>
        row.getAttribute("data-provider-icon"),
      );

    const container = renderComposer(composerProps as never);

    expect(providerNames(container)).toEqual([]);
    expect(statsTitle(container)).toBe("Input $0.01 · Output $0.02");
    expect(container.textContent).not.toContain("Model:");

    session.modelProvider = undefined;
    expect(providerNames(renderComposer(composerProps as never))).toEqual(["codex"]);
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
      sessions: defaultSessions() as never,
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
    expect(part(container, "tray")).toBeNull();
    expect(popoverText).not.toContain("Copilot");
    expect(popoverText).toContain("Context window");
    expect(popoverText).toContain("Latest run");
    expect(popoverText).toContain("Cost");
    expect(popoverText).toContain("$0.03");
  });

  it("omits the cost tooltip when every recorded cost is zero", () => {
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
      selectedSession: sessionRow({
        totalTokens: 1_000,
        contextTokens: 200_000,
        estimatedCostUsd: 0,
      }),
      sessions: defaultSessions() as never,
    });

    expect(part(container, "stats [title]")).toBeNull();
    expect(part(container, "stats")?.textContent).toContain("$0.00");
  });

  it("warns on fresh high usage but keeps stale usage approximate", () => {
    for (const totalTokensFresh of [undefined, false]) {
      const container = renderComposer({
        selectedSession: sessionRow({
          totalTokens: 190_000,
          contextTokens: 200_000,
          ...(totalTokensFresh === false ? { totalTokensFresh } : {}),
        }),
        sessions: defaultSessions() as never,
      });
      const ring = contextRingFor(container);
      expect(ring?.getAttribute("aria-label")).toBe(
        totalTokensFresh === false
          ? "Session context usage: ~190k of 200k (~95%)"
          : "Session context usage: 190k of 200k (95%)",
      );
      expect(ring?.classList.contains("context-ring--warning")).toBe(totalTokensFresh !== false);
      if (totalTokensFresh !== false) {
        expect(container.textContent).not.toContain("Compact");
      }
    }
  });
});
