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
  // Unverified credentials report nothing; the row's own meta line names them.
  expect(status()).toBe("");
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

it("keeps one signal per state: the row speaks for an only account, not beside other credentials", () => {
  const failing = {
    profileId: "example:failing",
    type: "oauth" as const,
    status: "expired" as const,
    reasonCode: "expired" as const,
  };
  const rejected = {
    id: "example",
    displayName: "Example",
    apiKey: undefined,
    catalogStatus: "auth-rejected" as const,
  };
  const accountStatus = (id: string, container: HTMLElement) =>
    text(container.querySelector(`[data-profile-id="${id}"] .model-providers__profile-status`));

  const only = mount(props({ cards: [card({ ...rejected, profiles: [failing] })] }));
  expect(text(only.querySelector(".provider-row__status"))).toBe("Credentials rejected");
  expect(accountStatus(failing.profileId, only)).toBe("");

  const healthy = { profileId: "example:healthy", type: "oauth" as const, status: "ok" as const };
  const several = mount(props({ cards: [card({ ...rejected, profiles: [healthy, failing] })] }));
  expect(accountStatus(failing.profileId, several)).toBe("Sign-in unavailable");
  expect(accountStatus(healthy.profileId, several)).toBe("");

  // A key could be what was rejected, so the account can't be assumed to be the cause.
  const besideKey = mount(
    props({ cards: [card({ ...rejected, apiKey: { source: "config" }, profiles: [failing] })] }),
  );
  expect(accountStatus(failing.profileId, besideKey)).toBe("Sign-in unavailable");
});

it("counts a provider's only unavailable model in the singular", () => {
  const unavailable = { availableModelCount: 0, unavailableModelCount: 1 };
  const container = mount(
    props({ cards: [card({ modelCount: 1, ...unavailable })], configuredModels: [] }),
  );
  expect(text(container.querySelector(".provider-row__meta"))).toContain("0 of 1 model available");
  const partly = { modelCount: 3, availableModelCount: 2, unavailableModelCount: 1 };
  mount(props({ cards: [card(partly)], configuredModels: [] }), container);
  expect(text(container.querySelector(".provider-row__meta"))).toContain("2 of 3 models available");
  // Unknown readiness is not reported as unavailability (#195247).
  const unknown = { modelCount: 4, availableModelCount: 0, unavailableModelCount: 0 };
  mount(props({ cards: [card(unknown)], configuredModels: [] }), container);
  expect(text(container.querySelector(".provider-row__meta"))).toContain("4 models");
  expect(text(container.querySelector(".provider-row__meta"))).not.toContain("available");
});

it("hands the accent to an open API key form", () => {
  const editable = card({ id: "example", displayName: "Example", catalogStatus: "ready" });
  const viewProps = props({ cards: [editable], configuredModels: [] });
  const container = mount(viewProps);
  const connect = () => container.querySelector("[data-model-readiness] .btn") as HTMLButtonElement;
  expect(connect().classList.contains("primary")).toBe(true);
  mount({ ...viewProps, keyEditorProvider: "example" }, container);
  expect(connect().classList.contains("primary")).toBe(false);
});
