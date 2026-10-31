/* @vitest-environment jsdom */

import { afterEach, expect, it, vi } from "vitest";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  loginHarness,
  openPicker,
  selectProvider,
} from "./model-providers-page.login.test-support.ts";
import {
  appendPage,
  clickLoginChoice,
  createAuthStatus,
  expandProvider,
  submitCredential,
} from "./model-providers-page.test-support.tsx";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function reconnectHarness(
  kinds: ("oauth" | "device-code" | "secret")[],
  profile: {
    source?: "saved" | "external" | "config" | "inherited";
    logoutSupported?: boolean;
    reconnectSupported?: boolean;
  } = { source: "saved", logoutSupported: true, reconnectSupported: true },
) {
  const health = createAuthStatus([
    {
      provider: "xai",
      displayName: "xAI",
      status: "expired",
      profiles: [{ profileId: "xai:expired", type: "oauth", status: "expired", ...profile }],
    },
  ]);
  const capabilities = [
    {
      provider: "xai",
      apiKeySupported: true,
      quickApiKeySetup: true,
      loginOptions: kinds.map((kind, index) => ({
        id: `xai/method-${index}`,
        brandId: "xai",
        label: `xAI ${kind}`,
        kind,
        featured: kind !== "secret",
      })),
    },
  ];
  return loginHarness({ providers: health.providers, capabilities });
}

it.each([
  { kind: "oauth", source: "saved" },
  { kind: "device-code", source: "saved" },
  { kind: "oauth", source: "config" },
] as const)(
  "reconnects an expired $source account using its advertised $kind route without the picker",
  async ({ kind, source }) => {
    vi.spyOn(window, "open").mockReturnValue(null);
    const { context, request, answer } = reconnectHarness(["secret", kind], {
      source,
      logoutSupported: true,
      reconnectSupported: true,
    });
    const original = request.getMockImplementation()!;
    let restored = false;
    request.mockImplementation(async (method, ...args) => {
      if (method === "models.authStatus" && restored) {
        return createAuthStatus([
          {
            provider: "xai",
            displayName: "xAI",
            profiles: [{ profileId: "xai:restored", type: "oauth", status: "ok" }],
          },
        ]);
      }
      return original(method, ...args);
    });
    const page = appendPage(context);
    const row = await expandProvider(page, "xai");
    const reconnect = row.querySelector<HTMLButtonElement>(".model-providers__profile-reconnect");
    await waitForSolid(() => expect(reconnect?.disabled).toBe(false));
    reconnect!.click();
    await waitForSolid(() =>
      expect(page.querySelector<HTMLInputElement>('input[name="wizard-text"]')?.disabled).toBe(
        false,
      ),
    );
    expect(page.querySelector("[data-models-login-choice]")).toBeNull();
    expect(request).toHaveBeenCalledWith(
      "models.authLogin",
      { sessionId: expect.any(String), authChoice: "xai/method-1", agentId: "writer" },
      { timeoutMs: null },
    );
    expect(reconnect?.disabled).toBe(true);
    restored = true;
    answer.resolve({ done: true, status: "done" });
    await submitCredential(page);
    await waitForSolid(() =>
      expect(page.renderRoot.textContent).toContain("Provider credentials saved."),
    );
    const close = [...page.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "Close",
    );
    expect(close).toBeDefined();
    close!.click();
    await page.updateComplete;
    const restoredRow = await expandProvider(page, "xai");
    await waitForSolid(() =>
      expect(page.querySelector('[data-profile-id="xai:restored"]')).not.toBeNull(),
    );
    expect(restoredRow.querySelector(".model-providers__profile-reconnect")).toBeNull();
  },
);

it.each(["picker", "reconnect"] as const)(
  "keeps the advertised provider logo in the %s sign-in dialog",
  async (entry) => {
    vi.spyOn(window, "open").mockReturnValue(null);
    const { context, request, answer } = reconnectHarness(["oauth"]);
    const original = request.getMockImplementation()!;
    let signInShown = false;
    request.mockImplementation(async (method, ...args) => {
      if (method === "wizard.next") {
        if (signInShown) {
          return answer.promise;
        }
        signInShown = true;
        return {
          done: false,
          status: "running",
          step: {
            id: "browser-sign-in",
            type: "progress",
            executor: "gateway",
            externalUrl: "https://example.invalid/authorize",
          },
        };
      }
      return original(method, ...args);
    });
    const page = appendPage(context);
    if (entry === "picker") {
      await openPicker(page);
      await selectProvider(page, "xai");
      clickLoginChoice(page, "xAI oauth");
    } else {
      const row = await expandProvider(page, "xai");
      const reconnect = row.querySelector<HTMLButtonElement>(".model-providers__profile-reconnect");
      await waitForSolid(() => expect(reconnect?.disabled).toBe(false));
      reconnect!.click();
    }
    await waitForSolid(() =>
      expect(
        page.querySelector('.wizard-sign-in__badge [data-provider-icon="grok"]'),
      ).not.toBeNull(),
    );
  },
);

it.each([
  { name: "no OAuth route", kinds: ["secret"] as const },
  { name: "ambiguous OAuth routes", kinds: ["oauth", "device-code"] as const },
])("does not guess a reconnect method with $name", async ({ kinds }) => {
  const { context, request } = reconnectHarness([...kinds]);
  const page = appendPage(context);
  const row = await expandProvider(page, "xai");
  expect(row.querySelector(".model-providers__profile-reconnect")).toBeNull();
  expect(request.mock.calls.filter(([method]) => method === "models.authLogin")).toHaveLength(0);
});

it.each(["external", "config", "inherited", "saved"] as const)(
  "keeps an expired %s account read-only without the Gateway ownership capability",
  async (source) => {
    const { context, request } = reconnectHarness(["oauth"], { source });
    const page = appendPage(context);
    const row = await expandProvider(page, "xai");
    expect(row.querySelector('[data-profile-id="xai:expired"]')).not.toBeNull();
    expect(row.querySelector(".model-providers__profile-reconnect")).toBeNull();
    expect(request.mock.calls.filter(([method]) => method === "models.authLogin")).toHaveLength(0);
  },
);

it("does not reconnect an inherited profile even when the Gateway advertises removal", async () => {
  const { context, request } = reconnectHarness(["oauth"], {
    source: "inherited",
    logoutSupported: true,
  });
  const page = appendPage(context);
  const row = await expandProvider(page, "xai");
  expect(row.querySelector(".model-providers__profile-reconnect")).toBeNull();
  expect(request.mock.calls.filter(([method]) => method === "models.authLogin")).toHaveLength(0);
});
