/* @vitest-environment jsdom */

import { afterEach, expect, it } from "vitest";
import type { ModelAuthStatusResult } from "../../api/types.ts";
import { loginHarness, openPicker } from "./model-providers-page.login.test-support.ts";
import {
  appendPage,
  type ModelProvidersPageTestElement,
} from "./model-providers-page.test-support.tsx";

afterEach(() => {
  document.body.replaceChildren();
});

async function searchProviders(page: ModelProvidersPageTestElement, query: string) {
  const input = page.querySelector<HTMLInputElement>("[data-models-login-search]")!;
  input.focus();
  input.value = query;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await page.updateComplete;
}

function providerChoices(page: Pick<ParentNode, "querySelectorAll">) {
  return [...page.querySelectorAll<HTMLElement>("[data-models-login-provider]")].map(
    (element) => element.getAttribute("data-models-login-provider") ?? "",
  );
}

it.each([["münchen".normalize("NFC")], ["münchen".normalize("NFD")]])(
  "matches NFC and NFD provider queries against NFD group labels: %s",
  async (query) => {
    const nfdLabel = "München".normalize("NFD");
    const capabilities: NonNullable<ModelAuthStatusResult["providerCapabilities"]> = [
      {
        provider: "muenchen",
        apiKeySupported: false,
        quickApiKeySetup: false,
        loginOptions: [
          {
            id: "plugin/muenchen-login",
            brandId: "muenchen",
            groupLabel: nfdLabel,
            label: "Device sign-in",
            kind: "device-code",
            featured: true,
          },
        ],
      },
    ];
    const { context } = loginHarness({ capabilities });
    const page = appendPage(context);
    await openPicker(page);
    expect(providerChoices(page)).toEqual(["muenchen"]);
    await searchProviders(page, query);
    expect(providerChoices(page)).toEqual(["muenchen"]);
  },
);
