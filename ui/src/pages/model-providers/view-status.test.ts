/* @vitest-environment jsdom */

import { beforeEach, expect, it } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { buildModelProviderCards } from "./data.ts";
import { card, mount, props, text } from "./view.test-support.tsx";

beforeEach(() => i18n.setLocale("en"));

it("uses the scoped check outcome without hiding catalog or account problems", () => {
  const viewProps = props({ cards: [card({ catalogStatus: "ready" })] });
  const container = mount(viewProps);
  const status = () => text(container.querySelector(".provider-row__status"));
  const probe = { provider: "openai", status: "billing" as const, results: [] };
  mount({ ...viewProps, probeResults: { openai: probe } }, container);
  expect(status()).toBe("Billing problem");
  mount({ ...viewProps, probeResults: { another: probe } }, container);
  expect(status()).toBe("Ready");
  const partial = {
    provider: "openai",
    status: "ok" as const,
    results: [{ label: "Secondary account", status: "auth" as const }],
  };
  mount({ ...viewProps, probeResults: { openai: partial } }, container);
  expect(status()).toBe("Access verified with warnings");
  for (const [catalogStatus, label] of [
    ["auth-rejected", "Credentials rejected"],
    ["unavailable", "Models unavailable"],
  ] as const) {
    mount(
      { ...viewProps, cards: [card({ catalogStatus })], probeResults: { openai: partial } },
      container,
    );
    expect(status()).toBe(label);
  }
  mount({ ...viewProps, probeResults: { openai: { ...partial, results: [] } } }, container);
  expect(status()).toBe("Ready");
});

it("preserves setup status when a probe has no model to check", () => {
  const viewProps = props({ cards: [card({ catalogStatus: "ready" })] });
  const container = mount({
    ...viewProps,
    probeResults: { openai: { provider: "openai", status: "no_model", results: [] } },
  });
  expect(text(container.querySelector(".provider-row__status"))).toBe("Ready");
  mount(
    {
      ...viewProps,
      cards: [card({ catalogStatus: "auth-rejected" })],
      probeResults: { openai: { provider: "openai", status: "no_model", results: [] } },
    },
    container,
  );
  expect(text(container.querySelector(".provider-row__status"))).toBe("Credentials rejected");
});

it("labels a single measured account when per-login limits are unavailable", () => {
  const profile = { profileId: "openai:first", type: "oauth" as const, status: "ok" as const };
  const base = card({
    apiKey: undefined,
    auth: { kind: "ok" },
    catalogStatus: "ready",
    usage: {
      provider: "openai",
      displayName: "OpenAI",
      windows: [{ label: "Week", usedPercent: 100 }],
    },
  });
  const view = (profiles: (typeof profile)[]) => props({ cards: [{ ...base, profiles }] });
  const container = mount(view([profile, { ...profile, profileId: "openai:second" }]));
  container.querySelector<HTMLButtonElement>(".provider-row__summary")!.click();
  flush();
  expect(text(container.querySelector(".provider-row__limits-pane"))).toContain(
    "Limits for one account",
  );
  expect(text(container.querySelector(".provider-row__summary"))).not.toContain("0% left");
  mount(view([profile]), container);
  expect(text(container.querySelector(".provider-row__summary"))).toContain("Week 0% left");
});

it.each([true, false])(
  "shows a plan-only sample for one account, not the whole provider (profiles visible: %s)",
  (canViewProfiles) => {
    const profiles = ["first", "second"].map((profileId) => ({
      profileId,
      type: "oauth" as const,
      status: "ok" as const,
    }));
    const usage = { provider: "openai", displayName: "OpenAI", plan: "Team", windows: [] };
    const container = mount(
      props({ canViewProfiles, canMutate: false, cards: [card({ profiles, usage })] }),
    );
    const summary = container.querySelector<HTMLButtonElement>(".provider-row__summary")!;
    expect(text(summary)).not.toContain("Team");
    summary.click();
    flush();
    expect(text(container.querySelector(".provider-row__limits-pane"))).toMatch(
      /Limits for one account.*Team/u,
    );
  },
);

it("uses the scoped quota once for a single login, retaining the collapsed summary", async () => {
  const profiles = [{ profileId: "openai:first", type: "oauth" as const, status: "ok" as const }];
  const usage = {
    provider: "openai",
    displayName: "OpenAI",
    plan: "Pro",
    windows: [{ label: "Week", usedPercent: 100 }],
  };
  const client = createTestGatewayClient(() => ({
    providers: [{ ...usage, windows: [{ label: "Week", usedPercent: 45 }] }],
  }));
  const view = props({
    cards: [
      card({ apiKey: undefined, profiles, usage, catalogStatus: "ready", auth: { kind: "ok" } }),
    ],
    accountUsage: { client, agentId: "main", revision: 0 },
  });
  const container = mount(view);
  const summary = container.querySelector<HTMLButtonElement>(".provider-row__summary")!;
  expect(text(summary)).toContain("Pro");
  expect(text(summary)).toContain("Week 0% left");
  summary.click();
  await waitForSolid(() =>
    expect(text(container.querySelector(".model-providers__account-limits"))).toContain("55% left"),
  );
  expect(container.querySelectorAll(".provider-usage__window")).toHaveLength(1);
  expect(text(summary)).not.toContain("Pro");
  expect(text(summary)).not.toContain("Week 0% left");
  expect(text(container.querySelector(".model-providers__account-limits"))).toContain("Pro");

  // A provider-level Admin API spend snapshot isn't a duplicate of the login quota.
  mount(
    {
      ...view,
      cards: [
        card({
          profiles,
          usage: {
            ...usage,
            plan: "Admin API",
            windows: [],
            billing: [{ type: "spend", amount: 25, unit: "USD" }],
          },
        }),
      ],
    },
    container,
  );
  expect(text(container.querySelector(".provider-row__limits-pane"))).toContain("$25.00");
  expect(text(summary)).toContain("Admin API");
  const error = "Admin API key required";
  mount(
    {
      ...view,
      cards: [
        card({
          profiles,
          usage: { provider: "openai", displayName: "OpenAI", windows: [], error },
        }),
      ],
    },
    container,
  );
  expect(text(container.querySelector(".provider-row__limits-pane"))).toContain(error);
  expect(text(container.querySelector(".model-providers__account-limits"))).toContain("55% left");
});

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
  const viewProps = props({ cards: [providerCard], configuredModels: [], modelRequired: true });
  const container = mount(viewProps);
  const status = () => text(container.querySelector(".provider-row__status"));
  expect(status()).toBe("Ready");
  expect(text(container.querySelector("[data-model-readiness]"))).toContain("no usable models");
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
          profiles: [
            { ...oauth, status: "expired", reasonCode: "refresh_failed", expiry: undefined },
          ],
        },
      ],
    },
    container,
  );
  expect(status()).toBe("Expired");
  // A refresh in progress settles on its own; the row keeps its catalog evidence.
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
  expect(status()).toBe("Ready");
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
  expect(text(excluded)).toContain("Refreshing");
  expect(text(excluded)).not.toContain("Sign in again");
});

it.each([
  ["missing_credential", "Not signed in"],
  ["refresh_failed", "Sign-in expired"],
  ["expired", "Refreshing"],
] as const)(
  "preserves selected static-token expiry beside an excluded OAuth %s reason",
  (reasonCode, label) => {
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
    expect(text(container.querySelector('[data-profile-id="example:excluded"]'))).toContain(label);
  },
);

it("keeps one signal per state: the row speaks for an only account, not beside other credentials", () => {
  const failing = {
    profileId: "example:failing",
    type: "oauth" as const,
    status: "expired" as const,
    reasonCode: "refresh_failed" as const,
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
  expect(accountStatus(failing.profileId, several)).toBe("Sign-in expired");
  expect(accountStatus(healthy.profileId, several)).toBe("");

  // A key could be what was rejected, so the account can't be assumed to be the cause.
  const besideKey = mount(
    props({ cards: [card({ ...rejected, apiKey: { source: "config" }, profiles: [failing] })] }),
  );
  expect(accountStatus(failing.profileId, besideKey)).toBe("Sign-in expired");
});

it("counts a provider's only unavailable model in the singular", () => {
  const container = mount(
    props({ cards: [card({ modelCount: 1, availableModelCount: 0 })], configuredModels: [] }),
  );
  expect(text(container.querySelector(".provider-row__meta"))).toContain("0 of 1 model available");
  mount(
    props({ cards: [card({ modelCount: 3, availableModelCount: 2 })], configuredModels: [] }),
    container,
  );
  expect(text(container.querySelector(".provider-row__meta"))).toContain("2 of 3 models available");
});
