/* @vitest-environment jsdom */

import { expect, it } from "vitest";
import { card, mount, props, text } from "./view.test-support.tsx";

function actions(container: HTMLElement, providerId: string) {
  return [
    ...container.querySelectorAll<HTMLButtonElement>(
      `[data-provider-id="${providerId}"] .model-providers__card-actions button`,
    ),
  ].map((button) => ({
    name: button.getAttribute("aria-label") ?? text(button),
    text: text(button),
  }));
}

const providerCards = [
  card({ hasConfigApiKey: true }),
  card({
    id: "anthropic",
    displayName: "Anthropic",
    credentialProviderIds: ["anthropic"],
    hasConfigApiKey: true,
  }),
];

it("names each provider action after its provider and keeps the visible label first", () => {
  const container = mount(props({ cards: providerCards, canConnect: () => true }));
  expect(actions(container, "openai")).toEqual([
    { name: "Connect provider: OpenAI", text: "Connect provider" },
    { name: "Test connection: OpenAI", text: "Test connection" },
    { name: "Set API key: OpenAI", text: "Set API key" },
    { name: "Remove key: OpenAI", text: "Remove key" },
  ]);
  expect(actions(container, "anthropic")).toEqual([
    { name: "Connect provider: Anthropic", text: "Connect provider" },
    { name: "Test connection: Anthropic", text: "Test connection" },
    { name: "Set API key: Anthropic", text: "Set API key" },
    { name: "Remove key: Anthropic", text: "Remove key" },
  ]);
});

it("names a testing probe by its visible text", () => {
  const container = mount(props({ cards: providerCards, busy: { "probe:openai": true } }));
  expect(actions(container, "openai")[0]).toEqual({ name: "Testing…", text: "Testing…" });
  expect(actions(container, "anthropic")[0]).toEqual({
    name: "Test connection: Anthropic",
    text: "Test connection",
  });
});
