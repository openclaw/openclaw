/* @vitest-environment jsdom */

import { flush } from "solid-js";
import { expect, it, vi } from "vitest";
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
  // The saved key's own row owns replacing it, so the footer doesn't offer it again.
  expect(actions(container, "openai")).toEqual([
    { name: "Remove provider: OpenAI", text: "Remove provider", disabled: false },
    { name: "Test access: OpenAI", text: "Test access", disabled: false },
    { name: "Add account: OpenAI", text: "Add account", disabled: false },
  ]);
  const keyRow = container.querySelector(
    '[data-provider-id="openai"] .model-providers__credentials',
  );
  expect(text(keyRow)).toContain("Set in config");
  expect(keyRow?.querySelector("button")?.getAttribute("aria-label")).toBe(
    "Replace API key: OpenAI",
  );
  expect(actions(container, "anthropic")).toEqual([
    { name: "Add account: Anthropic", text: "Add account", disabled: false },
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
  expect(actions(container, "openai")[1]).toEqual({
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
    { name: "Test access: OpenAI", text: "Test access", disabled: true },
    { name: "Add account: OpenAI", text: "Add account", disabled: true },
  ]);
});

it("puts Replace on a key's row only when it is the provider's only key", () => {
  const savedKey = (profileId: string) =>
    ({ profileId, type: "api_key", status: "static" }) as const;
  const rowReplace = (container: HTMLElement) =>
    [
      ...container.querySelectorAll<HTMLButtonElement>(
        '[data-provider-id="openai"] .provider-row__accounts button',
      ),
    ]
      .map((button) => button.getAttribute("aria-label"))
      .filter((name) => name?.startsWith("Replace"));
  const open = (cards: ReturnType<typeof card>[]) => {
    const container = mount(props({ cards }));
    container
      .querySelector<HTMLButtonElement>('[data-provider-id="openai"] .provider-row__summary')!
      .click();
    flush();
    return container;
  };
  const setKey = { name: "Set API key: OpenAI", text: "Set API key", disabled: false };

  const single = open([card({ apiKey: undefined, profiles: [savedKey("openai:a")] })]);
  expect(rowReplace(single)).toEqual(["Replace API key: OpenAI"]);
  expect(actions(single, "openai")).not.toContainEqual(setKey);

  // The Gateway replaces the first eligible key, which may not be the row a button sits on.
  for (const cards of [
    [card({ apiKey: undefined, profiles: [savedKey("openai:a"), savedKey("openai:b")] })],
    [card({ apiKey: { source: "config" }, profiles: [savedKey("openai:a")] })],
  ]) {
    const container = open(cards);
    expect(rowReplace(container)).toEqual([]);
    expect(actions(container, "openai")).toContainEqual(setKey);
  }
});

it("probes an anonymous custom endpoint with no catalog through the shared row action", () => {
  const onProbe = vi.fn();
  const container = mount(
    props({
      cards: [
        card({
          id: "local-endpoint",
          displayName: "Local endpoint",
          modelCount: 0,
          availableModelCount: 0,
          apiKey: undefined,
          credentialProviderIds: [],
          customEndpoint: { editable: true },
          catalogStatus: "unavailable",
        }),
      ],
      onProbe,
      probeResults: {
        "local-endpoint": {
          provider: "local-endpoint",
          status: "ok",
          latencyMs: 42,
          results: [],
        },
      },
    }),
  );
  const row = container.querySelector("[data-provider-id=local-endpoint]")!;
  expect(row.classList.contains("provider-row--quiet")).toBe(true);
  const probe = [...row.querySelectorAll<HTMLButtonElement>("button")].find(
    (entry) => entry.textContent?.trim() === "Test access",
  );
  expect(probe).toBeDefined();
  expect(probe!.disabled).toBe(false);
  probe!.click();
  expect(onProbe).toHaveBeenCalledExactlyOnceWith("local-endpoint", ["local-endpoint"]);
  expect(row.querySelector(".model-providers__probe-summary")?.textContent).toContain(
    "Access verified",
  );
});
