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

const identityKey = "git.coauthor.identity";
const organizationKey = "git.coauthor.organization";
const consentKey = "git.coauthor.enabled";
const organization = { name: "Ada Organization", email: "ada@organization.example" };

function mount(
  entries: Record<string, unknown>,
  failSave = false,
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
      if (failSave) {
        throw new Error("Credit details could not be saved");
      }
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

function input(page: ParentNode, name: "name" | "email") {
  return page.querySelector<HTMLInputElement>(`#git-coauthor-${name}`)!;
}

function edit(page: ParentNode, name: "name" | "email", value: string) {
  input(page, name).value = value;
  input(page, name).dispatchEvent(new Event("input", { bubbles: true }));
}

function submit(page: ParentNode) {
  page
    .querySelector(".identity-coauthor-form")!
    .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}

beforeEach(async () => {
  await i18n.setLocale("en");
});

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

it("shows unavailable credit as not configured while keeping custom details editable", async () => {
  const { page, request } = mount({ [consentKey]: true });
  const toggle = () =>
    page.querySelector<HTMLInputElement>('#settings-profile-attribution [role="switch"]');
  await waitForSolid(() => expect(input(page, "name")?.disabled).toBe(false));
  expect(toggle()).toMatchObject({ checked: false, disabled: true });
  expect(page.textContent).toContain("Not configured");
  expect(page.textContent).toContain("Add a co-author name and email to enable credit.");
  expect(page.textContent).toContain("GitHub sign-in is optional");
  expect(page.textContent).toContain("only affect commit credit");
  toggle()!.click();
  expect(request.mock.calls.some(([method]) => method === "users.prefs.set")).toBe(false);
});

it("keeps unavailable credit disabled after a display-name edit when profile refresh fails", async () => {
  const profile = { ...modelAccountProfile, gitCoauthorAvailable: false };
  let reads = 0;
  const { page, request } = mount({}, false, profile, {
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

it.each([identityKey, organizationKey])(
  "requires explicit consent for %s even with a verified GitHub account",
  async (key) => {
    const profile = {
      ...modelAccountProfile,
      githubIdentity: {
        login: "octocat",
        profileUrl: "https://github.com/octocat",
        avatarUrl: "https://avatars.githubusercontent.com/u/583231?v=4",
      },
    };
    const { page } = mount({ [key]: organization }, false, profile);
    await waitForSolid(() =>
      expect(
        page.querySelector<HTMLInputElement>('#settings-profile-attribution [role="switch"]'),
      ).toMatchObject({ checked: false, disabled: false }),
    );
    expect(page.textContent).toContain(organization.email);
  },
);

it("keeps verified publishing-host credit available without a displayed primary GitHub account", async () => {
  const profile = {
    ...modelAccountProfile,
    githubIdentity: null,
    gitCoauthorAvailable: true,
    emails: ["github:engineering.example.test:101", "github:code.example.test:101"],
  };
  const { page } = mount({}, false, profile);
  await waitForSolid(() =>
    expect(
      page.querySelector<HTMLInputElement>('#settings-profile-attribution [role="switch"]'),
    ).toMatchObject({ checked: true, disabled: false }),
  );
  expect(page.textContent).toContain("GitHub identity for the publishing host");
  expect(page.textContent).not.toContain("Add a co-author name and email to enable credit.");
});

it.each([false, true])(
  "requires renewed consent for the first supplied pair (GitHub available=%s)",
  async (gitCoauthorAvailable) => {
    const { page, request } = mount({ [consentKey]: true }, false, {
      ...modelAccountProfile,
      gitCoauthorAvailable,
    });
    const toggle = () =>
      page.querySelector<HTMLInputElement>('#settings-profile-attribution [role="switch"]');
    await waitForSolid(() => expect(input(page, "name")?.disabled).toBe(false));
    edit(page, "name", "Ada Example");
    edit(page, "email", "ada@example.test");
    submit(page);
    await waitForSolid(() =>
      expect(request).toHaveBeenCalledWith("users.prefs.set", {
        entries: {
          [identityKey]: { name: "Ada Example", email: "ada@example.test" },
          [consentKey]: false,
        },
      }),
    );
    await waitForSolid(() => expect(toggle()).toMatchObject({ checked: false, disabled: false }));
  },
);

it("shows organization credit separately and requires explicit consent", async () => {
  const { page, request } = mount({ [organizationKey]: organization });
  await waitForSolid(() => expect(input(page, "name")).not.toBeNull());
  expect(page.textContent).toContain("From your organization");
  expect(page.textContent).toContain(organization.email);
  expect(input(page, "name").value).toBe("");
  expect(input(page, "email").value).toBe("");
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

it("saves an explicit pair without replacing organization defaults or enabling consent", async () => {
  const { page, request } = mount({ [organizationKey]: organization });
  await waitForSolid(() => expect(input(page, "name")).not.toBeNull());
  edit(page, "name", "Ada Example");
  edit(page, "email", "ada@personal.example");
  submit(page);
  await waitForSolid(() =>
    expect(request).toHaveBeenCalledWith("users.prefs.set", {
      entries: { [identityKey]: { name: "Ada Example", email: "ada@personal.example" } },
    }),
  );
  await waitForSolid(() => expect(page.textContent).toContain("Custom details"));
  expect(
    page.querySelector<HTMLInputElement>('#settings-profile-attribution [role="switch"]')?.checked,
  ).toBe(false);
});

it("clears only the override and restores organization credit", async () => {
  const { page, request } = mount({
    [identityKey]: { name: "Ada Custom", email: "custom@example.test" },
    [organizationKey]: organization,
    [consentKey]: true,
  });
  await waitForSolid(() => expect(input(page, "name")?.value).toBe("Ada Custom"));
  const clear = page.querySelector<HTMLButtonElement>(".identity-coauthor-clear")!;
  clear.click();
  await waitForSolid(() =>
    expect(request).toHaveBeenCalledWith("users.prefs.set", {
      entries: { [identityKey]: null },
    }),
  );
  await waitForSolid(() => expect(input(page, "name").value).toBe(""));
  expect(page.textContent).toContain("From your organization");
  expect(page.textContent).toContain(organization.email);
});

it("returns to not configured when the last custom credit pair is cleared", async () => {
  const { page, request } = mount({
    [identityKey]: { name: "Ada Custom", email: "custom@example.test" },
    [consentKey]: true,
  });
  const toggle = () =>
    page.querySelector<HTMLInputElement>('#settings-profile-attribution [role="switch"]');
  await waitForSolid(() => expect(toggle()).toMatchObject({ checked: true, disabled: false }));
  page.querySelector<HTMLButtonElement>(".identity-coauthor-clear")!.click();
  await waitForSolid(() => expect(toggle()).toMatchObject({ checked: false, disabled: true }));
  expect(page.textContent).toContain("Not configured");
  expect(page.textContent).toContain("Add a co-author name and email to enable credit.");
  expect(request.mock.calls.filter(([method]) => method === "users.self")).toHaveLength(1);
});

it.each([
  { name: "Ada", email: "" },
  { name: "Ada <Other>", email: "ada@example.test" },
  { name: "Ada", email: "ada@example.test>" },
])("rejects invalid or incomplete custom credit $name <$email>", async ({ name, email }) => {
  const { page, request } = mount({});
  await waitForSolid(() => expect(input(page, "name")).not.toBeNull());
  edit(page, "name", name);
  edit(page, "email", email);
  submit(page);
  await waitForSolid(() =>
    expect(page.querySelector('[role="alert"]')?.textContent).toContain(
      "Enter a valid co-author name and email address",
    ),
  );
  expect(request.mock.calls.filter(([method]) => method === "users.prefs.set")).toHaveLength(0);
});

it("retains custom drafts after a rejected save and a profile refresh", async () => {
  const { page, request } = mount({ [organizationKey]: organization }, true);
  await waitForSolid(() => expect(input(page, "name")).not.toBeNull());
  edit(page, "name", "Ada Draft");
  edit(page, "email", "draft@example.test");
  submit(page);
  await waitForSolid(() => expect(page.textContent).toContain("Credit details could not be saved"));
  expect(input(page, "name").value).toBe("Ada Draft");
  expect(input(page, "email").value).toBe("draft@example.test");
  page.querySelector<HTMLButtonElement>(".profile-refresh")!.click();
  await waitForSolid(() =>
    expect(request.mock.calls.filter(([method]) => method === "users.prefs.get")).toHaveLength(2),
  );
  expect(input(page, "name").value).toBe("Ada Draft");
  expect(input(page, "email").value).toBe("draft@example.test");
});
