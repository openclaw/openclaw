/* @vitest-environment jsdom */

import { afterEach, expect, it } from "vitest";
import { sanitizeSessionRow } from "../../lib/sessions/session-row-reconcile.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  createComposerContainer,
  createComposerControlsFixture,
  createComposerProps,
  resetComposerFixture,
  renderComposerInto,
} from "./chat-composer.test-support.ts";
import { projectChatSessionStateSnapshot } from "./chat-session-state-snapshot.ts";

afterEach(() => resetComposerFixture());

it("clears restored context usage after a live withdrawal and subsequent partial rows", () => {
  const state = { client: null, hello: null, sessionKey: "main", connected: false };
  const partial = { key: "main", kind: "direct" as const, updatedAt: 1 };
  const usage = { used: 190_000, limit: 200_000, approximate: false, fromLastPrompt: false };
  const restored = projectChatSessionStateSnapshot(state, partial, {
    contextUsage: usage,
    unarchiveAllowed: false,
  });
  expect(restored.contextUsage).toEqual(usage);
  const props = createComposerProps({
    contextUsage: restored.contextUsage,
    selectedSession: partial,
  });
  const container = document.body.appendChild(createComposerContainer());
  renderComposerInto(container, props);
  expect(container.querySelector(".context-ring")?.getAttribute("aria-label")).toContain("95%");
  expect(container.querySelector(".context-ring--warning")).not.toBeNull();

  const unavailable = sanitizeSessionRow({
    ...partial,
    updatedAt: 2,
    totalTokens: undefined,
    totalTokensFresh: false,
    contextTokens: 200_000,
  });
  // Admission must hide the old ring even before its saved display is replaced.
  renderComposerInto(container, { ...props, selectedSession: unavailable });
  expect(container.querySelector(".context-ring")).toBeNull();
  const cleared = projectChatSessionStateSnapshot(state, unavailable, restored);
  expect(cleared.contextUsage).toBeUndefined();
  const next = projectChatSessionStateSnapshot(state, { ...partial, updatedAt: 3 }, cleared);
  renderComposerInto(container, {
    ...props,
    selectedSession: partial,
    contextUsage: next.contextUsage,
  });
  expect(container.querySelector(".context-ring")).toBeNull();
});

function usageProps(refreshed = false) {
  const [provider, displayName, plan, usedPercent, revision] = refreshed
    ? (["anthropic", "Claude", "Max", 61, 2] as const)
    : (["openai", "OpenAI", "Plus", 21, 1] as const);
  const controls = createComposerControlsFixture();
  controls.model.accountSelection = {
    kind: "shared",
    label: "Selected account",
    authProfileId: `${provider}:oauth`,
  };
  return createComposerProps({
    composerControls: controls,
    selectedSession: {
      key: "main",
      kind: "direct",
      updatedAt: revision,
      totalTokens: refreshed ? 190_000 : 1_000,
      contextTokens: 200_000,
      modelProvider: provider,
      ...(refreshed ? { inputTokens: 9_000, outputTokens: 400 } : {}),
    },
    providerUsage: {
      basePath: refreshed ? "/updated" : "/control",
      modelAuthStatusResult: {
        ts: revision,
        providers: [
          {
            provider,
            displayName,
            status: "ok",
            profiles: [{ profileId: `${provider}:oauth`, type: "oauth", status: "ok" }],
            usage: {
              providerId: provider,
              authProfileId: `${provider}:oauth`,
              plan,
              windows: [{ label: "Week", usedPercent }],
            },
          },
        ],
      },
    },
  });
}

it("keeps the context counter exempt and usage-link focus during refreshes", async () => {
  const props = usageProps();
  const container = document.body.appendChild(createComposerContainer());
  renderComposerInto(container, props);
  const query = container.querySelector.bind(container);
  const details = query<HTMLDetailsElement>(".context-usage details")!;
  expect(details.querySelector(".context-usage__popover")).toBeNull();
  details.querySelector("summary")!.click();
  await waitForSolid(() =>
    expect(details.querySelector("[popover]")?.matches(":popover-open")).toBe(true),
  );
  const usageLink = query<HTMLAnchorElement>("[data-chat-provider-usage]")!;
  usageLink.focus();
  expect(document.activeElement).toBe(usageLink);
  expect(query<HTMLElement>(".context-usage__context-value")!.translate).toBe(false);
  expect(query<HTMLElement>(".context-usage__title")!.translate).toBe(true);

  const current = usageProps(true);
  renderComposerInto(container, {
    ...props,
    composerControls: current.composerControls,
    selectedSession: current.selectedSession,
    providerUsage: current.providerUsage,
  });
  flush();

  expect(query(".context-usage details")).toBe(details);
  expect(details.open).toBe(true);
  expect(document.activeElement).toBe(usageLink);
  expect(usageLink.getAttribute("href")).toBe("/updated/usage");
  expect(usageLink.textContent).toContain("Max");
  expect(query(".context-usage__context-value")?.textContent).toContain("190k / 200k");
  expect(query(".context-ring")?.classList).toContain("context-ring--warning");
  expect(query(".context-usage__limit")?.getAttribute("aria-valuenow")).toBe("61");
  expect(
    query(".context-usage__identity .provider-brand-icon")?.getAttribute("data-provider-icon"),
  ).toBe("claude");
  expect(query(".context-usage__stats")?.textContent).toContain("9k");
  details.querySelector("summary")!.click();
  flush();
  expect(details.open).toBe(false);
  expect(details.querySelector("[popover]")?.matches(":popover-open")).toBe(false);
  expect(query("[data-chat-provider-usage]")).toBe(usageLink);
});
