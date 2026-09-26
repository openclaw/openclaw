/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelAuthStatusResult } from "../../api/types.ts";
import {
  loginHarness,
  openPicker,
  selectProvider,
  searchProviders,
  providerChoices,
} from "../../test-helpers/model-provider-login.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { appendPage, startSelectedLogin } from "./model-providers-page.test-support.ts";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Models provider picker", () => {
  it("groups and searches advertised providers before selecting their supported sign-in method", async () => {
    const base = loginHarness();
    const auth =
      await base.context.gateway.snapshot.client!.request<ModelAuthStatusResult>(
        "models.authStatus",
      );
    const example = auth.providerCapabilities![0]!;
    const { context, request } = loginHarness({
      capabilities: [
        {
          provider: "zebra-portal",
          apiKeySupported: false,
          quickApiKeySetup: false,
          loginOptions: [
            {
              id: "plugin/zebra-login",
              brandId: "zebra-portal",
              groupId: "zebra",
              groupLabel: "Zebra",
              label: "Device sign-in",
              kind: "device-code",
              featured: true,
            },
          ],
        },
        {
          provider: "zebra",
          apiKeySupported: true,
          quickApiKeySetup: true,
          loginOptions: [
            {
              id: "plugin/zebra-key",
              brandId: "zebra",
              groupId: "zebra",
              groupLabel: "Zebra",
              label: "Zebra subscription key",
              kind: "secret",
              featured: false,
            },
          ],
          setupOptions: [
            {
              id: "plugin/zebra-cli",
              brandId: "zebra",
              groupId: "zebra",
              groupLabel: "Zebra",
              label: "Zebra CLI",
              hint: "Reuse the login on your Gateway computer",
            },
          ],
        },
        example,
        { ...example, provider: "example-alias" },
        {
          provider: "alpha",
          apiKeySupported: true,
          quickApiKeySetup: true,
          loginOptions: [
            {
              id: "plugin/alpha-key",
              brandId: "alpha",
              groupLabel: "Alpha",
              label: "Account key",
              kind: "secret",
              featured: false,
            },
          ],
        },
        { provider: "unsupported", apiKeySupported: false, quickApiKeySetup: false },
      ],
    });
    const page = appendPage(context);
    await openPicker(page);
    expect(providerChoices(page)).toEqual(["alpha", "example", "zebra"]);
    expect(page.querySelector("[data-models-login-choice]")).toBeNull();
    expect(page.querySelector("[data-models-login-discover]")).not.toBeNull();
    expect(request.mock.calls.some(([method]) => method === "models.authLogin")).toBe(false);

    await searchProviders(page, "  EXAMPLE  ");
    expect(providerChoices(page)).toEqual(["example"]);
    await searchProviders(page, "browser sign-in");
    expect(providerChoices(page)).toEqual(["example"]);
    await searchProviders(page, "your Example account key");
    expect(providerChoices(page)).toEqual(["example"]);
    await selectProvider(page, "example");
    expect(
      [...page.querySelectorAll("[data-models-login-choice] strong")].map(
        (element) => element.textContent,
      ),
    ).toEqual(["Example browser sign-in", "Example API key"]);
    expect(document.activeElement).toBe(page.querySelector("[data-models-login-choice] button"));
    expect(page.querySelector("[data-models-login-start]")).toBeNull();
    expect(request.mock.calls.some(([method]) => method === "models.authLogin")).toBe(false);
    expect(page.querySelector("[data-models-login-discover]")).toBeNull();

    page.querySelector<HTMLButtonElement>("[data-models-login-back]")!.click();
    await page.updateComplete;
    expect(document.activeElement).toBe(page.querySelector("[data-models-login-search]"));
    expect(page.querySelector<HTMLInputElement>("[data-models-login-search]")!.value).toBe(
      "your Example account key",
    );
    await searchProviders(page, "no such provider");
    expect(providerChoices(page)).toEqual([]);
    expect(page.querySelector(".model-provider-login [role=status]")?.textContent).toContain(
      "No providers match",
    );
    await searchProviders(page, "");
    expect(providerChoices(page)).toEqual(["alpha", "example", "zebra"]);
    await selectProvider(page, "zebra");
    expect(page.querySelector("[data-models-login-api-key]")).toBeNull();
    expect(
      [...page.querySelectorAll("[data-models-login-choice] strong")].map(
        (element) => element.textContent,
      ),
    ).toEqual(["Device sign-in", "Zebra subscription key"]);
    const setup = page.querySelector<HTMLDetailsElement>(
      '[data-models-login-setup="plugin/zebra-cli"]',
    )!;
    expect(setup.textContent).toContain("openclaw configure --section model");
    setup.open = true;
    await page.updateComplete;
    expect(request.mock.calls.some(([method]) => method === "models.authLogin")).toBe(false);
    await startSelectedLogin(page, "plugin/zebra-login");
    expect(request).toHaveBeenCalledWith(
      "models.authLogin",
      {
        authChoice: "plugin/zebra-login",
        agentId: "writer",
        sessionId: expect.any(String),
      },
      { timeoutMs: null },
    );
  });

  it("keeps family methods and owner-bound accounts available from a provider card", async () => {
    const { context, request } = loginHarness({
      capabilities: [
        {
          provider: "example-owner",
          apiKeySupported: false,
          quickApiKeySetup: false,
          loginOptions: [
            {
              id: "example-browser",
              brandId: "example",
              groupId: "example",
              groupLabel: "Example provider",
              label: "Example browser sign-in",
              kind: "oauth",
              featured: true,
            },
          ],
        },
        {
          provider: "example-subscription",
          apiKeySupported: false,
          quickApiKeySetup: false,
          loginOptions: [
            {
              id: "example-subscription",
              brandId: "example-subscription",
              groupId: "example",
              groupLabel: "Example provider",
              label: "Example subscription",
              kind: "oauth",
              featured: false,
            },
          ],
        },
      ],
      providers: [
        {
          provider: "example-owner",
          authProvider: "example-owner",
          displayName: "Example provider",
          status: "ok",
          profiles: [
            {
              profileId: "example:external",
              type: "oauth",
              status: "ok",
              source: "external",
              email: "same-account@example.invalid",
              displayName: "External CLI account",
            },
            {
              profileId: "example:saved",
              type: "oauth",
              status: "expiring",
              source: "saved",
              email: "same-account@example.invalid",
              displayName: "Saved browser account",
            },
          ],
        },
        {
          provider: "unrelated",
          displayName: "Unrelated provider",
          status: "ok",
          profiles: [
            {
              profileId: "unrelated:one",
              type: "oauth",
              status: "ok",
              email: "other-provider@example.invalid",
            },
          ],
        },
      ],
    });
    const page = appendPage(context);
    await waitForFast(() =>
      expect(page.querySelector('[data-provider-id="example-owner"]')).not.toBeNull(),
    );
    const card = page.querySelector('[data-provider-id="example-owner"]')!;
    const addAccount = [...card.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "Add account",
    );
    expect(addAccount?.disabled).toBe(false);
    addAccount!.click();
    await page.updateComplete;
    expect(page.querySelector("[data-models-login-search]")).toBeNull();
    expect(page.querySelector(".model-provider-login__provider")?.textContent).toContain(
      "Example provider",
    );
    const dialog = page.querySelector("openclaw-modal-dialog")!;
    expect(dialog.textContent).toContain("Accounts available to this agent");
    const profiles = [...dialog.querySelectorAll<HTMLElement>("[data-profile-id]")];
    expect(profiles.map((profile) => profile.dataset.profileId)).toEqual([
      "example:external",
      "example:saved",
    ]);
    expect(
      profiles.every((profile) => profile.textContent?.includes("same-account@example.invalid")),
    ).toBe(true);
    expect(profiles[0]?.textContent).toContain("External CLI account");
    expect(profiles[1]?.textContent).toContain("Saved browser account");
    expect(profiles[1]?.textContent).toContain("Expiring");
    expect(dialog.textContent).not.toContain("other-provider@example.invalid");
    expect(request.mock.calls.some(([method]) => method === "models.authLogin")).toBe(false);
    await startSelectedLogin(page, "example-subscription");
    expect(request).toHaveBeenCalledWith(
      "models.authLogin",
      {
        authChoice: "example-subscription",
        agentId: "writer",
        sessionId: expect.any(String),
      },
      { timeoutMs: null },
    );
  });
});
