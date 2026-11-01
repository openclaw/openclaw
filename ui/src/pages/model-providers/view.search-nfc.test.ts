/* @vitest-environment jsdom */

import { flush } from "solid-js";
import { expect, it } from "vitest";
import { card, mount, props } from "./view.test-support.tsx";

it.each([["münchen".normalize("NFC")], ["münchen".normalize("NFD")]])(
  "matches NFC and NFD provider queries against NFD display names: %s",
  (query) => {
    const nfdName = "München AI".normalize("NFD");
    const container = mount(
      props({
        cards: [card({ id: "muenchen-ai", displayName: nfdName })],
        providerQuery: query,
      }),
    );

    expect(container.querySelectorAll("[data-provider-id]")).toHaveLength(1);
    expect(container.querySelector('[data-provider-id="muenchen-ai"]')).not.toBeNull();

    const search = container.querySelector<HTMLInputElement>('input[type="search"]')!;
    search.value = query;
    search.dispatchEvent(new Event("input", { bubbles: true }));
    flush();
    expect(container.querySelectorAll("[data-provider-id]")).toHaveLength(1);
  },
);
