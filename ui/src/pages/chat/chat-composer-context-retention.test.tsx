/* @vitest-environment jsdom */

import { afterEach, expect, it } from "vitest";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  createComposerContainer,
  createComposerProps,
  resetComposerFixture,
  renderComposerInto,
} from "./chat-composer.test-support.ts";

afterEach(() => resetComposerFixture());

function usageProps(refreshed = false) {
  const [provider, displayName, plan, usedPercent, revision] = refreshed
    ? (["anthropic", "Claude", "Max", 61, 2] as const)
    : (["openai", "OpenAI", "Plus", 21, 1] as const);
  return createComposerProps({
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
              plan,
              windows: [{ label: "Week", usedPercent }],
            },
          },
        ],
      },
    },
  });
}

it("keeps the context popover open and its usage link focused during live usage refreshes", async () => {
  const props = usageProps();
  const container = document.body.appendChild(createComposerContainer());
  renderComposerInto(container, props);
  const query = container.querySelector.bind(container);
  const details = query<HTMLDetailsElement>(".context-usage details")!;
  expect(details).not.toBeNull();
  expect(details.querySelector(".context-usage__popover")).toBeNull();
  details.querySelector("summary")!.click();
  await waitForSolid(() =>
    expect(details.querySelector("[popover]")?.matches(":popover-open")).toBe(true),
  );
  const usageLink = query<HTMLAnchorElement>("[data-chat-provider-usage]")!;
  usageLink.focus();
  expect(document.activeElement).toBe(usageLink);

  const current = usageProps(true);
  renderComposerInto(container, {
    ...props,
    selectedSession: current.selectedSession,
    providerUsage: current.providerUsage,
  });
  flush();

  expect(query(".context-usage details")).toBe(details);
  expect(details.open).toBe(true);
  expect(query("[data-chat-provider-usage]")).toBe(usageLink);
  expect(document.activeElement).toBe(usageLink);
  expect(usageLink.getAttribute("href")).toBe("/updated/usage");
  expect(usageLink.textContent).toContain("Max");
  expect(query(".context-usage__context-value")?.textContent).toContain("190k / 200k");
  expect(query(".context-ring")?.classList).toContain("context-ring--warning");
  expect(query(".context-usage__limit-bar")?.getAttribute("aria-valuenow")).toBe("61");
  expect(query(".context-usage__provenance")?.textContent).toContain("Claude");
  expect(query(".context-usage__stats")?.textContent).toContain("9k");
  details.querySelector("summary")!.click();
  flush();
  expect(details.querySelector(".context-usage__popover")).toBeNull();
});
