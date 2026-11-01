/* @vitest-environment jsdom */

import { beforeEach, expect, it } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { buildModelProviderCards } from "./data.ts";
import { card, mount, props, text } from "./view.test-support.tsx";

beforeEach(() => i18n.setLocale("en"));

it("uses catalog evidence for short-lived OAuth without treating expiry alone as sign-out", () => {
  const oauth = {
    profileId: "example:account",
    type: "oauth" as const,
    status: "expiring" as const,
    expiry: { at: 4_000_000, remainingMs: 3_600_000, label: "1h" },
  };
  const providerCard = card({
    id: "example",
    displayName: "Example",
    apiKey: undefined,
    auth: { kind: "expiring", expiryLabel: "1h" },
    profiles: [oauth],
    catalogStatus: "ready",
  });
  const viewProps = props({ cards: [providerCard], configuredModels: [] });
  const container = mount(viewProps);
  const status = () => text(container.querySelector(".provider-row__status"));
  expect(status()).toBe("Ready");
  expect(text(container.querySelector("[data-model-readiness]"))).toContain("No models available");
  mount({ ...viewProps, cards: [{ ...providerCard, catalogStatus: undefined }] }, container);
  expect(status()).toBe("Credentials configured");
  mount({ ...viewProps, cards: [{ ...providerCard, catalogStatus: "auth-rejected" }] }, container);
  expect(status()).toBe("Credentials rejected");
  mount(
    {
      ...viewProps,
      cards: [
        {
          ...providerCard,
          auth: { kind: "expired" },
          profiles: [{ ...oauth, status: "expired", reasonCode: "expired", expiry: undefined }],
        },
      ],
    },
    container,
  );
  expect(status()).toBe("Expired");
  mount(
    { ...viewProps, cards: [{ ...providerCard, auth: { kind: "expired" }, profiles: [] }] },
    container,
  );
  expect(status()).toBe("Expired");
  mount(
    {
      ...viewProps,
      cards: [
        {
          ...providerCard,
          profiles: [oauth, { profileId: "example:static", type: "token", status: "expiring" }],
        },
      ],
    },
    container,
  );
  expect(status()).toBe("Expiring");
  // Inventory can include an excluded unusable account; the Gateway rollup owns selection.
  mount(
    {
      ...viewProps,
      cards: [
        {
          ...providerCard,
          auth: { kind: "ok" },
          profiles: [
            { ...oauth, status: "ok" },
            {
              profileId: "example:excluded",
              type: "oauth",
              status: "expired",
              reasonCode: "expired",
            },
          ],
        },
      ],
    },
    container,
  );
  expect(status()).toBe("Ready");
});

it("does not prescribe OAuth sign-in for a rejected API key with excluded OAuth inventory", () => {
  const cards = buildModelProviderCards({
    authStatus: {
      ts: 1,
      providers: [
        {
          provider: "example",
          displayName: "Example",
          status: "static",
          profileOrder: ["example:api-key"],
          profiles: [
            { profileId: "example:api-key", type: "api_key", status: "static" },
            {
              profileId: "example:excluded",
              type: "oauth",
              status: "expired",
              reasonCode: "expired",
            },
          ],
        },
      ],
    },
    models: [],
    providerUsage: null,
    providerOutcomes: [
      { provider: "example", profileId: "example:api-key", status: "auth-rejected" },
    ],
  });
  const container = mount(props({ cards, configuredModels: [] }));
  expect(text(container.querySelector(".provider-row__status"))).toBe("Credentials rejected");
  const excluded = container.querySelector('[data-profile-id="example:excluded"]');
  expect(text(excluded)).toContain("Sign-in unavailable");
  expect(text(excluded)).not.toContain("Sign in again");
});

it.each(["missing_credential", "expired"] as const)(
  "preserves selected static-token expiry beside an excluded OAuth %s reason",
  (reasonCode) => {
    const cards = buildModelProviderCards({
      authStatus: {
        ts: 1,
        providers: [
          {
            provider: "example",
            displayName: "Example",
            status: "expiring",
            profileOrder: ["example:token"],
            profiles: [
              { profileId: "example:token", type: "token", status: "expiring" },
              {
                profileId: "example:excluded",
                type: "oauth",
                status: reasonCode === "missing_credential" ? "missing" : "expired",
                reasonCode,
              },
            ],
          },
        ],
      },
      models: [],
      providerUsage: null,
    });
    const container = mount(props({ cards, configuredModels: [] }));
    expect(text(container.querySelector(".provider-row__status"))).toBe("Expiring");
    container.querySelector<HTMLButtonElement>(".provider-row__summary")!.click();
    flush();
    expect(text(container.querySelector('[data-profile-id="example:excluded"]'))).toContain(
      reasonCode === "missing_credential" ? "Sign in again" : "Sign-in unavailable",
    );
  },
);
