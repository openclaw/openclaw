/* @vitest-environment jsdom */
import { render, nothing } from "lit";
import { afterEach, expect, it, onTestFinished } from "vitest";
import { flush } from "../../test-helpers/solid-settle.ts";
import {
  createComposerContainer,
  createComposerProps,
  resetComposerFixture,
} from "./chat-composer.test-support.ts";
import { renderChatComposer } from "./components/chat-composer.tsx";

afterEach(() => resetComposerFixture());

it("keeps the context popover open and its usage link focused during live usage refreshes", () => {
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
    render(nothing, view.container);
  });
  render(renderChatComposer(current), view.container);
  const details = view.container.querySelector<HTMLDetailsElement>(".context-usage details");
  const usageLink = view.container.querySelector<HTMLAnchorElement>("[data-chat-provider-usage]");
  if (!details || !usageLink) {
    throw new Error("Expected the composer's context usage popover and provider link");
  }
  details.open = true;
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
  render(renderChatComposer(current), view.container);
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
});
