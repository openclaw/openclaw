/* @vitest-environment jsdom */

import { createComponent, createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { contextBudgetStatusFixture } from "../../../../src/config/sessions/context-budget.test-support.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewaySessionRow, ModelAuthStatusProvider } from "../../api/types.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
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
const compactButton = (root: ParentNode) =>
  root.querySelector<HTMLButtonElement>(".context-usage__actions .chat-context__compact");
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
      ["5h", 21.6, resetAt],
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

  it("keeps distinct subscription accounts separate when selecting a provider", () => {
    const providers = ["anthropic", "claude-cli"].map((id, index) =>
      planProvider(id, "Claude", [["5h", 10]], {
        usage: {
          providerId: "anthropic",
          accountEmail: ["work@example.com", "personal@example.com"][index],
        },
      }),
    );
    for (const [index, modelProvider] of ["anthropic", "claude-cli"].entries()) {
      const container = renderComposer({
        session: { modelProvider },
        providerUsage: planUsage(providers),
      });
      expect(textContents(container, ".context-usage__account")).toEqual([
        ["work@example.com", "personal@example.com"][index],
      ]);
      expect(textContents(container, ".context-usage__limit-value")).toEqual(["10%"]);
    }
  });

  it("omits empty or invalid subscription quotas and clamps displayed window usage", () => {
    const providers = [
      planProvider("anthropic", "Claude", []),
      planProvider("openrouter", "Claude", [], {
        usage: {
          billing: [
            { type: "balance", amount: 10, unit: "USD" },
            { type: "budget", used: 5, limit: 0, unit: "USD" },
          ],
        },
      }),
      planProvider("openai", "Claude", [["Week", 140]]),
    ];
    for (const modelProvider of ["anthropic", "openrouter", "openai"]) {
      const container = renderComposer({
        session: { modelProvider },
        providerUsage: planUsage(providers),
      });
      expect(textContents(container, ".context-usage__limit-value")).toEqual(
        modelProvider === "openai" ? ["100%"] : [],
      );
      expect(container.querySelectorAll(".context-usage__tray")).toHaveLength(
        modelProvider === "openai" ? 1 : 0,
      );
    }
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

  it("offers a secondary Compact beside View context in every popover state", () => {
    const onCompact = vi.fn();
    const render = (overrides: ComposerOverrides & { session?: Partial<GatewaySessionRow> }) =>
      compactButton(
        renderComposer({ sessions: defaultSessions() as never, onCompact, ...overrides }),
      );
    const state = (button: HTMLButtonElement | null) =>
      button && {
        label: button.textContent,
        filled: button.classList.contains("chat-context__compact--high"),
        disabled: button.disabled,
        busy: button.getAttribute("aria-busy"),
        title: button.title,
      };
    const ready = {
      label: "Compact",
      filled: false,
      disabled: false,
      busy: null,
      title: "Replaces older context with a summary.",
    };

    expect(compactButton(renderComposer({ session: { totalTokens: 190_000 } }))).toBeNull();
    // Near the limit the ring carries the warning; the action stays secondary.
    for (const session of [
      { totalTokens: 40_000 },
      { totalTokens: 190_000 },
      { totalTokens: 190_000, totalTokensFresh: false },
    ]) {
      expect(state(render({ session }))).toEqual(ready);
    }
    expect(state(render({ session: { totalTokens: 190_000 }, runActive: true }))).toEqual({
      ...ready,
      disabled: true,
      title: "Available when the current run finishes.",
    });
    expect(state(render({ session: { totalTokens: 190_000 }, connected: false }))).toEqual({
      ...ready,
      disabled: true,
    });
    // A compaction the pane already tracks (runtime or another surface) reads as busy.
    expect(
      state(
        render({
          session: { totalTokens: 190_000 },
          runActive: true,
          compactionStatus: { phase: "active", runId: "run-1", startedAt: 1, completedAt: null },
        }),
      ),
    ).toEqual({ ...ready, label: "Compacting", disabled: true, busy: "true" });
    expect(onCompact).not.toHaveBeenCalled();
  });

  it("keeps the popover open and busy until the compaction request settles", async () => {
    const pending = createDeferred();
    const onCompact = vi.fn(() => pending.promise);
    const container = renderComposer({
      session: { totalTokens: 190_000 },
      sessions: defaultSessions() as never,
      onCompact,
    });
    const details = container.querySelector<HTMLDetailsElement>(".context-usage details")!;
    const button = compactButton(container)!;
    try {
      button.click();
      await waitForSolid(() => {
        expect(button.disabled).toBe(true);
        expect(button.textContent).toBe("Compacting");
      });
      button.click();
      expect(onCompact).toHaveBeenCalledOnce();
      expect(details.open).toBe(true);
    } finally {
      pending.resolve();
    }
    await waitForSolid(() => expect(button.textContent).toBe("Compact"));
    expect(button.disabled).toBe(false);
    expect(details.open).toBe(true);
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
