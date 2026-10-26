/* @vitest-environment jsdom */

import { createComponent, createSignal } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { contextBudgetStatusFixture } from "../../../../src/config/sessions/context-budget.test-support.js";
import type { GatewaySessionRow, ModelAuthStatusProvider } from "../../api/types.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { renderComposerFixture, resetComposerFixture } from "./chat-composer.test-support.ts";
import { ContextNotice } from "./components/chat-composer-context.tsx";

type ComposerOverrides = Parameters<typeof renderComposerFixture>[0];

function renderComposer({
  session,
  ...overrides
}: ComposerOverrides & {
  session?: Partial<GatewaySessionRow>;
} = {}) {
  const container = renderComposerFixture({
    ...(session ? { selectedSession: sessionRow(session) } : {}),
    ...overrides,
  }).container;
  document.body.append(container);
  container.querySelector<HTMLElement>(".context-usage summary")?.click();
  flush();
  return container;
}

const part = (root: ParentNode, name: string) => root.querySelector(`.context-usage__${name}`);
const contextRingFor = (root: ParentNode) => root.querySelector(".context-ring");
const statsTitle = (root: ParentNode) => part(root, "stats [title]")?.getAttribute("title");
const defaultSessions = () => ({ sessions: [], defaults: { contextTokens: 200_000 } });
const textContents = (root: ParentNode, selector: string) =>
  [...root.querySelectorAll(selector)].map((element) => element.textContent);

function sessionRow(overrides: Partial<GatewaySessionRow>): GatewaySessionRow {
  return {
    key: "main",
    kind: "direct",
    updatedAt: null,
    totalTokens: 1_000,
    contextTokens: 200_000,
    ...overrides,
  };
}

function planProvider(
  provider: string,
  displayName: string,
  windows: [string, number, number?][],
  options: { type?: "oauth" | "token"; usage?: Partial<ModelAuthStatusProvider["usage"]> } = {},
): ModelAuthStatusProvider {
  return {
    provider,
    displayName,
    status: "ok",
    profiles: [{ profileId: provider, type: options.type ?? "oauth", status: "ok" }],
    usage: {
      providerId: provider,
      windows: windows.map(([label, usedPercent, resetAt]) => ({ label, usedPercent, resetAt })),
      ...options.usage,
    },
  };
}

const planUsage = (providers: ModelAuthStatusProvider[]) => ({
  modelAuthStatusResult: { ts: Date.now(), providers },
});
const assistant = (overrides: Record<string, unknown> = {}) => ({
  role: "assistant",
  content: "hello",
  provider: "openai",
  ...overrides,
});

const weekly = (provider: string, displayName: string, usedPercent: number) =>
  planProvider(provider, displayName, [["Week", usedPercent]]);

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
        session: sessionRow({ estimatedCostUsd: 0.03 }),
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
      session: {
        updatedAt: 2,
        totalTokens: 160_000,
        totalTokensFresh: true,
        contextBudgetStatus: contextBudgetStatusFixture(),
      },
    });
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
    });
    const container = renderComposer({
      sessionKey: "global",
      currentAgentId: "work",
      selectedSession: undefined,
      sessions: { sessions: [session], defaults: { contextTokens: 200_000 } } as never,
    });

    expect(contextRingFor(container)?.getAttribute("aria-label") ?? null).toBe(null);
  });

  it.each([false, true])(
    "does not borrow the default model's capacity when session capacity is unknown (plan usage: %s)",
    (withPlanUsage) => {
      const session = sessionRow({
        modelProvider: "openai",
        model: "selected-model",
        totalTokens: 46_000,
        totalTokensFresh: true,
        contextTokens: undefined,
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
    const windows: [string, number, number?][] = [
      ["5h", 22, resetAt],
      ["Week", 25],
      ["Fable", 92],
    ];
    const usage = {
      plan: "Max (20x)",
      billing: [{ type: "budget" as const, used: 157.85, limit: 400, unit: "USD" }],
    };
    const container = renderComposer({
      session: {
        estimatedCostUsd: 0.02,
        model: "claude-fable-5",
        modelProvider: "anthropic",
      },
      messages: [{ role: "user", content: "hi" }],
      providerUsage: planUsage([
        planProvider("anthropic", "Claude", windows, { usage }),
        planProvider("claude-cli", "Claude", windows, {
          usage: { ...usage, providerId: "anthropic" },
        }),
      ]),
    });

    expect(container.querySelectorAll(".context-usage__tray")).toHaveLength(1);
    expect(part(container, "plan-badge")?.textContent).toBe("Max (20x)");
    const limits = [...container.querySelectorAll(".context-usage__limit")];
    expect(textContents(container, ".context-usage__limit-label")).toEqual([
      "5-hour",
      "Weekly",
      "Fable",
      "Usage credits",
    ]);
    expect(textContents(container, ".context-usage__limit-value")).toEqual([
      "22%",
      "25%",
      "92%",
      "$157.85 of $400.00",
    ]);
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
    expect(part(container, "stats")?.textContent).not.toContain("Cost");
  });

  it("uses response provenance only when the session provider is absent", () => {
    const session = sessionRow({
      model: "gateway-injected",
      modelProvider: "openclaw" as string | undefined,
      estimatedCostUsd: 0.03,
    });
    const composerProps = {
      messages: [
        { role: "user", content: "hi" },
        assistant({ cost: { input: 0.01, output: 0.02 }, responseModel: "gpt-5.5" }),
      ],
      selectedSession: session,
      sessions: { ...defaultSessions(), sessions: [session] },
      providerUsage: planUsage([weekly("anthropic", "Claude", 25), weekly("openai", "OpenAI", 72)]),
    };
    const providerNames = (container: HTMLElement) =>
      [...container.querySelectorAll(".context-usage__identity .provider-brand-icon")].map((row) =>
        row.getAttribute("data-provider-icon"),
      );

    const container = renderComposer(composerProps as never);

    expect(providerNames(container)).toEqual([]);
    expect(statsTitle(container)).toBe("Input $0.01 · Output $0.02");

    session.modelProvider = undefined;
    expect(providerNames(renderComposer(composerProps as never))).toEqual(["codex"]);
  });

  it("keeps context, token, and cost details when only unrelated plan usage exists", () => {
    const container = renderComposer({
      session: {
        inputTokens: 800,
        outputTokens: 200,
        totalTokens: 46_000,
        estimatedCostUsd: 0.03,
        modelProvider: "openai",
      },
      sessions: defaultSessions() as never,
      providerUsage: planUsage([
        planProvider("github-copilot", "Copilot", [["Day", 41]], { type: "token" }),
      ]),
    });

    const popoverText = part(container, "popover")?.textContent ?? "";
    expect(part(container, "tray")).toBeNull();
    expect(popoverText).not.toContain("Copilot");
    for (const text of ["Context window", "Latest run", "Cost", "$0.03"]) {
      expect(popoverText).toContain(text);
    }
  });

  it("omits the cost tooltip when every recorded cost is zero", () => {
    const container = renderComposer({
      session: { estimatedCostUsd: 0 },
      messages: [
        { role: "user", content: "hi" },
        assistant({
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          responseModel: "gpt-zero",
        }),
        assistant({
          model: "gateway-injected",
          provider: "openclaw",
          usage: { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        }),
      ],
      sessions: defaultSessions() as never,
    });

    expect(part(container, "stats [title]")).toBeNull();
    expect(part(container, "stats")?.textContent).toContain("$0.00");
  });

  it("warns on fresh high usage but keeps stale usage approximate", () => {
    for (const totalTokensFresh of [undefined, false]) {
      const container = renderComposer({
        session: {
          totalTokens: 190_000,
          ...(totalTokensFresh === false ? { totalTokensFresh } : {}),
        },
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
