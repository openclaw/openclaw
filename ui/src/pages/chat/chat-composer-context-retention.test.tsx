/* @vitest-environment jsdom */

import { afterEach, expect, it, onTestFinished } from "vitest";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  createComposerContainer,
  createComposerProps,
  resetComposerFixture,
  disposeComposer,
  renderComposerInto,
} from "./chat-composer.test-support.ts";

afterEach(() => resetComposerFixture());

it("keeps the context popover open and its usage link focused during live usage refreshes", async () => {
  let current = createComposerProps({
    selectedSession: {
      key: "main",
      kind: "direct",
      updatedAt: 1,
      totalTokens: 1_000,
      contextTokens: 200_000,
      modelProvider: "openai",
    },
    providerUsage: {
      basePath: "/control",
      modelAuthStatusResult: {
        ts: 1,
        providers: [
          {
            provider: "openai",
            displayName: "OpenAI",
            status: "ok",
            profiles: [{ profileId: "openai:oauth", type: "oauth", status: "ok" }],
            usage: {
              providerId: "openai",
              plan: "Plus",
              windows: [{ label: "Week", usedPercent: 21 }],
            },
          },
        ],
      },
    },
  });
  const view = { container: document.body.appendChild(createComposerContainer()) };
  onTestFinished(() => {
    disposeComposer(view.container);
  });
  renderComposerInto(view.container, current);
  const details = view.container.querySelector<HTMLDetailsElement>(".context-usage details");
  if (!details) {
    throw new Error("Expected the composer's context usage popover");
  }
  expect(details.querySelector(".context-usage__popover")).toBeNull();
  details.querySelector("summary")!.click();
  await waitForSolid(() =>
    expect(details.querySelector("[popover]")?.matches(":popover-open")).toBe(true),
  );
  const usageLink = view.container.querySelector<HTMLAnchorElement>("[data-chat-provider-usage]")!;
  usageLink.focus();
  expect(document.activeElement).toBe(usageLink);

  current = {
    ...current,
    selectedSession: {
      key: "main",
      kind: "direct",
      updatedAt: 2,
      totalTokens: 190_000,
      contextTokens: 200_000,
      inputTokens: 9_000,
      outputTokens: 400,
      modelProvider: "anthropic",
    },
    providerUsage: {
      basePath: "/updated",
      modelAuthStatusResult: {
        ts: 2,
        providers: [
          {
            provider: "anthropic",
            displayName: "Claude",
            status: "ok",
            profiles: [{ profileId: "anthropic:oauth", type: "oauth", status: "ok" }],
            usage: {
              providerId: "anthropic",
              plan: "Max",
              windows: [{ label: "Week", usedPercent: 61 }],
            },
          },
        ],
      },
    },
  };
  renderComposerInto(view.container, current);
  flush();

  expect(view.container.querySelector(".context-usage details")).toBe(details);
  expect(details.open).toBe(true);
  expect(view.container.querySelector("[data-chat-provider-usage]")).toBe(usageLink);
  expect(document.activeElement).toBe(usageLink);
  expect(usageLink.getAttribute("href")).toBe("/updated/usage");
  expect(usageLink.textContent).toContain("Max");
  expect(view.container.querySelector(".context-usage__context-value")?.textContent).toContain(
    "190k / 200k",
  );
  expect(view.container.querySelector(".context-ring")?.classList).toContain(
    "context-ring--warning",
  );
  expect(
    view.container.querySelector(".context-usage__limit-bar")?.getAttribute("aria-valuenow"),
  ).toBe("61");
  expect(view.container.querySelector(".context-usage__provenance")?.textContent).toContain(
    "Claude",
  );
  expect(view.container.querySelector(".context-usage__stats")?.textContent).toContain("9k");
  details.querySelector("summary")!.click();
  flush();
  expect(details.querySelector(".context-usage__popover")).toBeNull();
});
