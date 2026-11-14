/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { UserProfile } from "../../../../packages/gateway-protocol/src/index.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import "../../app/user-prefs-request.ts";
import { i18n } from "../../i18n/index.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  createConnectedContext,
  modelAccountProfile,
  mountProfilePage,
} from "./profile-page.test-support.tsx";
import { mockRpc } from "./profile-rpc.test-support.ts";

const organizationKey = "git.coauthor.organization";
const consentKey = "git.coauthor.enabled";
const organization = {
  name: "Ada Organization",
  email: "ada@organization.example",
  policy: "test-policy",
};

function mount(
  entries: Record<string, unknown>,
  profile: UserProfile = { ...modelAccountProfile, gitCoauthorAvailable: false },
  handlers: Parameters<typeof mockRpc>[0] = {},
) {
  const request = mockRpc({
    "users.self": () => ({ profile }),
    "users.listModelAccounts": () => ({
      profileId: profile.id,
      accounts: [],
      links: [],
    }),
    "users.prefs.get": () => ({ status: "ok", entries }),
    "users.prefs.set": (params) => {
      Object.assign(entries, (params as { entries: Record<string, unknown> }).entries);
      return { status: "ok" };
    },
    ...handlers,
  });
  const harness = createConnectedContext(request as GatewayBrowserClient["request"], {
    id: profile.id,
  });
  return { ...harness, request, page: mountProfilePage(harness.context) };
}

beforeEach(async () => {
  await i18n.setLocale("en");
});

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

it("shows unavailable credit as not configured without editable co-author fields", async () => {
  const { page, request } = mount({ [consentKey]: true });
  const toggle = () =>
    page.querySelector<HTMLInputElement>('#settings-profile-attribution [role="switch"]');
  await waitForSolid(() => expect(toggle()).toMatchObject({ checked: false, disabled: true }));
  expect(page.textContent).not.toContain("Credit source");
  expect(page.textContent).toContain("Ask your administrator to supply co-author details");
  expect(page.querySelector("#git-coauthor-name")).toBeNull();
  expect(page.querySelector("#git-coauthor-email")).toBeNull();
  toggle()!.click();
  expect(request.mock.calls.some(([method]) => method === "users.prefs.set")).toBe(false);
});

it.each([false, true])(
  "retains self-only credit projections after name save when refresh fails (available=%s)",
  async (available) => {
    const identity = { name: "verified-ada", email: "101+verified-ada@users.noreply.github.com" };
    const profile = {
      ...modelAccountProfile,
      gitCoauthorAvailable: available,
      ...(available ? { gitCoauthorIdentity: identity } : {}),
    };
    let reads = 0;
    const { page, request } = mount({}, profile, {
      "users.self": () => {
        if (reads++ > 0) {
          throw new Error("Profile refresh unavailable");
        }
        return { profile };
      },
      // Profile mutation responses contain ordinary profile data, not users.self projections.
      "users.setDisplayName": () => ({
        profile: { ...modelAccountProfile, displayName: "Ada Updated" },
      }),
    });
    const toggle = () =>
      page.querySelector<HTMLInputElement>('#settings-profile-attribution [role="switch"]');
    await waitForSolid(() =>
      expect(toggle()).toMatchObject({ checked: available, disabled: !available }),
    );
    const name = page.querySelector<HTMLInputElement>(".identity-name-control input")!;
    name.value = "Ada Updated";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    page
      .querySelector(".identity-name-control")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await waitForSolid(() =>
      expect(request).toHaveBeenCalledWith("users.setDisplayName", {
        profileId: profile.id,
        displayName: "Ada Updated",
      }),
    );
    await waitForSolid(() => expect(page.textContent).toContain("Profile refresh unavailable"));
    expect(toggle()).toMatchObject({ checked: available, disabled: !available });
    expect(page.querySelector("#settings-profile-attribution code")?.textContent).toBe(
      available ? `${identity.name} <${identity.email}>` : undefined,
    );
  },
);

it("shows the verified public GitHub credit rather than a linked sign-in email", async () => {
  const identity = { name: "verified-ada", email: "101+verified-ada@users.noreply.github.com" };
  const { page } = mount(
    {},
    {
      ...modelAccountProfile,
      emails: ["sign-in@example.test"],
      gitCoauthorAvailable: true,
      gitCoauthorIdentity: identity,
    },
  );
  await waitForSolid(() =>
    expect(page.querySelector("#settings-profile-attribution code")?.textContent).toBe(
      `${identity.name} <${identity.email}>`,
    ),
  );
  const row = page.querySelector("#settings-profile-attribution .settings-row--toggle")!;
  expect(row.textContent).toContain("public noreply address");
  expect(row.textContent).not.toContain("sign-in@example.test");
  expect(row.querySelector("code")?.nextElementSibling).toBeNull();
  expect(page.textContent).toContain("Used for sign-in and profile linking");
  expect(page.textContent).not.toContain("Credit source");
});

it("keeps verified publishing-host credit available without a displayed primary GitHub account", async () => {
  const profile = {
    ...modelAccountProfile,
    githubIdentity: null,
    gitCoauthorAvailable: true,
    emails: ["github:engineering.example.test:101", "github:code.example.test:101"],
  };
  const { page } = mount({}, profile);
  await waitForSolid(() =>
    expect(
      page.querySelector<HTMLInputElement>('#settings-profile-attribution [role="switch"]'),
    ).toMatchObject({ checked: true, disabled: false }),
  );
  expect(page.textContent).toContain("GitHub identity selected for the publishing host");
  expect(page.textContent).not.toContain("Ask your administrator to supply co-author details");
});

it.each([
  null,
  {
    login: "octocat",
    profileUrl: "https://github.com/octocat",
    avatarUrl: "https://avatars.githubusercontent.com/u/583231?v=4",
  },
])(
  "shows organization credit as read-only and requires explicit consent (GitHub=%j)",
  async (githubIdentity) => {
    const { page, request } = mount(
      { [organizationKey]: organization },
      { ...modelAccountProfile, githubIdentity, gitCoauthorAvailable: githubIdentity !== null },
    );
    await waitForSolid(() => expect(page.textContent).toContain(organization.email));
    expect(page.textContent).not.toContain("Credit source");
    const creditRow = page.querySelector("#settings-profile-attribution .settings-row--toggle")!;
    expect(creditRow.querySelector("code")?.textContent).toBe(
      `${organization.name} <${organization.email}>`,
    );
    expect(creditRow.textContent).toContain("public commit history");
    expect(creditRow.textContent).not.toContain("Enabling this makes");
    expect(creditRow.querySelector("code")?.nextElementSibling).toBeNull();
    expect(page.textContent).toContain(organization.name);
    expect(page.textContent).toContain(organization.email);
    expect(page.querySelector("#git-coauthor-name")).toBeNull();
    expect(page.querySelector("#git-coauthor-email")).toBeNull();
    const toggle = page.querySelector<HTMLInputElement>(
      '#settings-profile-attribution [role="switch"]',
    )!;
    await waitForSolid(() => expect(toggle).toMatchObject({ checked: false, disabled: false }));
    toggle.click();
    await waitForSolid(() => expect(toggle.checked).toBe(true));
    expect(request).toHaveBeenCalledWith("users.prefs.set", {
      entries: { [consentKey]: true },
      expectedEntries: { [organizationKey]: organization },
    });
    expect(creditRow.textContent).toContain("public commit history");
  },
);

it.each([null, organization])("rejects consent from a stale credit view (%j)", async (observed) => {
  const entries: Record<string, unknown> = {
    [consentKey]: false,
    ...(observed ? { [organizationKey]: observed } : {}),
  };
  const refreshed = { ...organization, email: "updated@organization.example" };
  let attempts = 0;
  const { page, request } = mount(
    entries,
    { ...modelAccountProfile, gitCoauthorAvailable: true },
    {
      "users.prefs.set": (params) => {
        expect(params).toEqual({
          entries: { [consentKey]: true },
          expectedEntries: { [organizationKey]: attempts++ === 0 ? observed : refreshed },
        });
        if (attempts === 1) {
          return { status: "conflict" };
        }
        entries[consentKey] = true;
        return { status: "ok" };
      },
    },
  );
  const toggle = () =>
    page.querySelector<HTMLInputElement>('#settings-profile-attribution [role="switch"]')!;
  await waitForSolid(() => expect(toggle()).toMatchObject({ checked: false, disabled: false }));
  entries[organizationKey] = refreshed;
  toggle().click();
  await waitForSolid(() => expect(page.textContent).toContain(refreshed.email));
  expect(page.textContent).toContain("Credit details changed");
  expect(entries[consentKey]).toBe(false);
  await waitForSolid(() => expect(toggle()).toMatchObject({ checked: false, disabled: false }));
  toggle().click();
  await waitForSolid(() => expect(entries[consentKey]).toBe(true));
  expect(request.mock.calls.filter(([method]) => method === "users.prefs.set")).toHaveLength(2);
});

it("refreshes cached proxy details after profile publication", async () => {
  const entries: Record<string, unknown> = { [organizationKey]: organization, [consentKey]: true };
  const { page, emitEvent } = mount(entries);
  await waitForSolid(() => expect(page.textContent).toContain(organization.email));
  const refreshed = { ...organization, email: "refreshed@organization.example" };
  entries[organizationKey] = refreshed;
  entries[consentKey] = false;
  emitEvent({ type: "event", event: "sessions.changed", payload: { reason: "profile-identity" } });
  await waitForSolid(() => expect(page.textContent).toContain(refreshed.email));
  expect(page.textContent).not.toContain(organization.email);
  expect(
    page.querySelector<HTMLInputElement>('#settings-profile-attribution [role="switch"]'),
  ).toMatchObject({ checked: false, disabled: false });
});

it("withholds inline credit for an unavailable publishing-host account", async () => {
  const { page } = mount(
    {},
    {
      ...modelAccountProfile,
      gitCoauthorAvailable: false,
      githubIdentity: {
        login: "octocat",
        profileUrl: "https://github.com/octocat",
        avatarUrl: "https://avatars.githubusercontent.com/u/583231",
      },
    },
  );
  const attribution = () => page.querySelector("#settings-profile-attribution");
  await waitForSolid(() =>
    expect(attribution()?.querySelector('[role="switch"]')).toMatchObject({
      checked: false,
      disabled: true,
    }),
  );
  expect(attribution()?.textContent).toContain(
    "Ask your administrator to supply co-author details",
  );
  expect(attribution()?.querySelector("code")).toBeNull();
});

it("reconciles proxy publication received while a preference save is pending", async () => {
  const saved = Promise.withResolvers<{ status: "ok" }>();
  const entries: Record<string, unknown> = { [organizationKey]: organization, [consentKey]: true };
  const { page, request, emitEvent } = mount(entries, undefined, {
    "users.prefs.set": () => saved.promise,
  });
  await waitForSolid(() => expect(page.textContent).toContain(organization.email));
  page
    .querySelectorAll<HTMLInputElement>('#settings-profile-attribution [role="switch"]')[1]!
    .click();
  await waitForSolid(() =>
    expect(request.mock.calls.filter(([method]) => method === "users.prefs.set")).toHaveLength(1),
  );
  const refreshed = { ...organization, email: "changed-during-save@organization.example" };
  entries[organizationKey] = refreshed;
  entries[consentKey] = false;
  emitEvent({ type: "event", event: "sessions.changed", payload: { reason: "profile-identity" } });
  saved.resolve({ status: "ok" });
  await waitForSolid(() => expect(page.textContent).toContain(refreshed.email));
  expect(
    page.querySelector<HTMLInputElement>('#settings-profile-attribution [role="switch"]'),
  ).toMatchObject({ checked: false, disabled: false });
});
