/* @vitest-environment jsdom */

import { flush } from "solid-js";
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
    disabled: button.disabled,
  }));
}

const providerCards = [
  card({
    displayName: "openai",
    apiKey: { source: "config" },
    configApiKeys: [{ key: "openai", reference: false }],
  }),
  card({
    id: "anthropic",
    displayName: "Anthropic",
    credentialProviderIds: ["anthropic"],
    apiKey: undefined,
    modelCount: 0,
    availableModelCount: 0,
  }),
];

it("names connected and unconnected provider actions with their displayed provider", () => {
  const container = mount(props({ cards: providerCards, canConnect: () => true }));
  container
    .querySelector<HTMLButtonElement>('[data-provider-id="openai"] .provider-row__summary')!
    .click();
  flush();
  expect(actions(container, "openai")).toEqual([
    { name: "Remove provider: OpenAI", text: "Remove provider", disabled: false },
    { name: "Add account: OpenAI", text: "Add account", disabled: false },
    { name: "Test connection: OpenAI", text: "Test connection", disabled: false },
    { name: "Set API key: OpenAI", text: "Set API key", disabled: false },
  ]);
  expect(actions(container, "anthropic")).toEqual([
    { name: "Connect provider: Anthropic", text: "Connect provider", disabled: false },
    { name: "Set API key: Anthropic", text: "Set API key", disabled: false },
  ]);
});

it("keeps provider identification through probe and access changes", () => {
  const viewProps = props({
    cards: providerCards,
    canConnect: () => true,
    busy: { "probe:openai": true },
  });
  const container = mount(viewProps);
  expect(actions(container, "openai")[2]).toEqual({
    name: "Testing…: OpenAI",
    text: "Testing…",
    disabled: true,
  });
  mount({ ...viewProps, busy: {}, canMutate: false }, container);
  container
    .querySelector<HTMLButtonElement>('[data-provider-id="openai"] .provider-row__summary')!
    .click();
  flush();
  expect(actions(container, "openai")).toEqual([
    { name: "Remove provider: OpenAI", text: "Remove provider", disabled: true },
    { name: "Add account: OpenAI", text: "Add account", disabled: true },
    { name: "Test connection: OpenAI", text: "Test connection", disabled: true },
    { name: "Set API key: OpenAI", text: "Set API key", disabled: true },
  ]);
});
