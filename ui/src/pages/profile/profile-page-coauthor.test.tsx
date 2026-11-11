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
const organization = { name: "Ada Organization", email: "ada@organization.example" };

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
  expect(page.textContent).toContain("Not configured");
  expect(page.textContent).toContain("Ask your administrator to supply co-author details");
  expect(page.querySelector("#git-coauthor-name")).toBeNull();
  expect(page.querySelector("#git-coauthor-email")).toBeNull();
  toggle()!.click();
  expect(request.mock.calls.some(([method]) => method === "users.prefs.set")).toBe(false);
});

it("keeps unavailable credit disabled after a display-name edit when profile refresh fails", async () => {
  const profile = { ...modelAccountProfile, gitCoauthorAvailable: false };
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
  await waitForSolid(() => expect(toggle()).toMatchObject({ checked: false, disabled: true }));
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
  expect(toggle()).toMatchObject({ checked: false, disabled: true });
});

it("requires explicit consent for organization details even with a verified GitHub account", async () => {
  const profile = {
    ...modelAccountProfile,
    githubIdentity: {
      login: "octocat",
      profileUrl: "https://github.com/octocat",
      avatarUrl: "https://avatars.githubusercontent.com/u/583231?v=4",
    },
  };
  const { page } = mount({ [organizationKey]: organization }, profile);
  await waitForSolid(() =>
    expect(
      page.querySelector<HTMLInputElement>('#settings-profile-attribution [role="switch"]'),
    ).toMatchObject({ checked: false, disabled: false }),
  );
  expect(page.textContent).toContain(organization.email);
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
  expect(page.textContent).toContain("GitHub identity for the publishing host");
  expect(page.textContent).not.toContain("Ask your administrator to supply co-author details");
});

it("shows organization credit as read-only and requires explicit consent", async () => {
  const { page, request } = mount({ [organizationKey]: organization });
  await waitForSolid(() => expect(page.textContent).toContain(organization.email));
  expect(page.textContent).toContain("From your organization");
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
  });
  expect(page.textContent).toContain("visible in commit history");
});
