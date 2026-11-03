/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  GIT_COAUTHOR_PREFERENCE_KEY,
  type UserProfile,
} from "../../../../packages/gateway-protocol/src/index.ts";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
// Settle the lazy preference reader before the bounded UI waits begin.
import "../../app/user-prefs-request.ts";
import { i18n } from "../../i18n/index.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { waitForSolid as waitForFast } from "../../test-helpers/solid-settle.ts";
import {
  createConnectedContext,
  modelAccountProfile,
  mountProfilePage,
} from "./profile-page.test-support.tsx";
import { mockRpc } from "./profile-rpc.test-support.ts";

function mountPreferences(request: GatewayBrowserClient["request"], id: string) {
  const harness = createConnectedContext(request, { id });
  return { ...harness, page: mountProfilePage(harness.context) };
}

function profileRpc(profile: () => UserProfile, handlers: Parameters<typeof mockRpc>[0]) {
  return mockRpc({
    "users.self": () => ({ profile: profile() }),
    "users.listModelAccounts": () => ({ profileId: profile().id, accounts: [], links: [] }),
    ...handlers,
  });
}

beforeEach(async () => {
  await i18n.setLocale("en");
});

afterEach(async () => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await i18n.setLocale("en");
});

it.each([
  { primary: true, stored: false, enabled: false, updated: true },
  { primary: true, stored: "not-a-boolean", enabled: false, updated: undefined },
  { primary: true, stored: undefined, enabled: true, updated: false },
  { primary: false, stored: false, enabled: false, updated: true },
  { primary: false, stored: undefined, enabled: true, updated: false },
])(
  "loads co-author consent $stored and saves changes without reloading (display primary=$primary)",
  async ({ primary, stored, enabled, updated }) => {
    const profile: UserProfile = {
      ...modelAccountProfile,
      emails: primary ? [] : ["github:ghe.example.test:101", "github:code.example.test:101"],
      githubIdentity: primary
        ? {
            login: "octocat",
            profileUrl: "https://github.com/octocat",
            avatarUrl: "https://avatars.githubusercontent.com/u/583231?v=4",
          }
        : null,
    };
    const request = profileRpc(() => profile, {
      "users.prefs.get": (params) => {
        expect(params).toEqual({
          keys: [GIT_COAUTHOR_PREFERENCE_KEY, "github.prAttribution.enabled"],
        });
        return {
          status: "ok",
          entries: stored === undefined ? {} : { [GIT_COAUTHOR_PREFERENCE_KEY]: stored },
        };
      },
      "users.prefs.set": (params) => {
        expect(params).toEqual({ entries: { [GIT_COAUTHOR_PREFERENCE_KEY]: updated } });
        return { status: "ok" };
      },
    });
    const harness = createConnectedContext(request as GatewayBrowserClient["request"], {
      id: profile.id,
      name: profile.displayName ?? undefined,
    });
    const page = mountProfilePage(harness.context);
    await waitForFast(() =>
      expect(page.querySelector("input.settings-toggle__input")).not.toBeNull(),
    );
    expect(Boolean(page.querySelector(".settings-account"))).toBe(primary);
    const toggle = page.querySelector<HTMLInputElement>("input.settings-toggle__input");
    await waitForFast(() => {
      expect(toggle).toMatchObject({ disabled: false, checked: enabled });
    });
    expect(request.mock.calls.map(([method]) => method).toSorted()).toEqual(
      [
        "users.self",
        "users.listModelAccounts",
        "users.prefs.get",
        "users.channelIdentity",
        "users.channelIdentity",
      ].toSorted(),
    );
    expect(page.querySelector(".identity-github-form")).toBeNull();
    if (updated === undefined) {
      return;
    }
    toggle!.checked = updated;
    toggle?.dispatchEvent(new Event("change", { bubbles: true }));
    await waitForFast(() =>
      expect(request.mock.calls.filter(([method]) => method === "users.prefs.set")).toHaveLength(1),
    );
    await waitForFast(() => expect(toggle?.checked).toBe(updated));
    expect(request.mock.calls.map(([method]) => method).toSorted()).toEqual(
      [
        "users.self",
        "users.listModelAccounts",
        "users.prefs.get",
        "users.prefs.set",
        "users.channelIdentity",
        "users.channelIdentity",
      ].toSorted(),
    );
  },
);

const prAttributionLabel = "Add OpenClaw attribution to pull requests";
function attributionToggle(page: ParentNode) {
  return [...page.querySelectorAll<HTMLInputElement>('input[role="switch"]')].find((input) => {
    const label = page.querySelector("#" + input.getAttribute("aria-labelledby"));
    return label?.textContent === prAttributionLabel;
  });
}

it.each([
  { stored: undefined, enabled: false, owner: false },
  { stored: false, enabled: false, owner: false },
  { stored: "true", enabled: false, owner: false },
  { stored: true, enabled: true, owner: false },
  { stored: undefined, enabled: false, owner: true },
  { stored: true, enabled: true, owner: true },
])(
  "loads personal PR attribution $stored and persists only its own preference (shared owner=$owner)",
  async ({ stored, enabled, owner }) => {
    const profile = {
      ...modelAccountProfile,
      id: owner ? "gateway-owner" : modelAccountProfile.id,
      emails: owner ? [] : modelAccountProfile.emails,
    };
    const request = profileRpc(() => profile, {
      "users.prefs.get": () => ({
        status: "ok",
        entries: { "github.prAttribution.enabled": stored },
      }),
      "users.prefs.set": (params) => {
        expect(params).toEqual({ entries: { "github.prAttribution.enabled": !enabled } });
        return { status: "ok" };
      },
    });
    const { page } = mountPreferences(request as GatewayBrowserClient["request"], profile.id);
    await waitForFast(() => {
      expect(attributionToggle(page)).toMatchObject({ disabled: false, checked: enabled });
    });
    if (owner) {
      const identity = page.querySelector("#settings-profile-identity")!;
      expect(identity.textContent).toContain(
        "GitHub-backed sign-in through Cloudflare Access or Tailscale Serve provides this identity.",
      );
      expect(identity.textContent).toContain(
        "Requires GitHub-backed sign-in through Cloudflare Access or Tailscale Serve.",
      );
      expect(identity.textContent).not.toContain("Linked emails");
      expect(identity.textContent).not.toContain("Refresh to retry");
      expect(
        identity.querySelector<HTMLInputElement>("input.settings-toggle__input"),
      ).toMatchObject({ checked: false, disabled: true });
    }
    const displayName = page.querySelector<HTMLInputElement>(".identity-name-control input")!;
    displayName.value = "Unsaved name";
    displayName.dispatchEvent(new Event("input", { bubbles: true }));
    attributionToggle(page)!.click();
    await waitForFast(() => expect(attributionToggle(page)?.checked).toBe(!enabled));
    expect(request.mock.calls.filter(([method]) => method === "users.prefs.set")).toHaveLength(1);
    expect(request.mock.calls.filter(([method]) => method === "users.self")).toHaveLength(1);
    expect(displayName.value).toBe("Unsaved name");
    expect(page.querySelector<HTMLInputElement>("input.settings-toggle__input")?.checked).toBe(
      !owner,
    );
  },
);

it.each(["read", "write"])(
  "keeps personal PR attribution off and shows %s errors",
  async (failure) => {
    const profile = modelAccountProfile;
    const unavailable = () => {
      throw new Error("Preference service unavailable");
    };
    const request = profileRpc(() => profile, {
      "users.prefs.get": () => (failure === "read" ? unavailable() : { status: "ok", entries: {} }),
      "users.prefs.set": unavailable,
    });
    const { page } = mountPreferences(request as GatewayBrowserClient["request"], profile.id);
    await waitForFast(() => expect(attributionToggle(page)?.disabled).toBe(false));
    if (failure === "write") {
      attributionToggle(page)!.click();
    }
    await waitForFast(() =>
      expect(page.querySelector('[role="alert"]')?.textContent).toContain(
        "Preference service unavailable",
      ),
    );
    expect(attributionToggle(page)?.checked).toBe(false);
  },
);

it("shows pending attribution, rolls back a rejected save, and reloads the accepted retry", async () => {
  const pending = createDeferred<{ status: "ok" }>();
  let enabled = false;
  const request = profileRpc(() => modelAccountProfile, {
    "users.prefs.get": () => ({
      status: "ok",
      entries: { "github.prAttribution.enabled": enabled, [GIT_COAUTHOR_PREFERENCE_KEY]: false },
    }),
    "users.prefs.set": (params) => {
      expect(params).toEqual({ entries: { "github.prAttribution.enabled": true } });
      if (request.mock.calls.filter(([name]) => name === "users.prefs.set").length === 1) {
        return pending.promise;
      }
      enabled = true;
      return { status: "ok" };
    },
  });
  const mounted = mountPreferences(
    request as GatewayBrowserClient["request"],
    modelAccountProfile.id,
  );
  const { context } = mounted;
  let { page } = mounted;
  await waitForFast(() => expect(attributionToggle(page)?.disabled).toBe(false));
  const toggle = attributionToggle(page)!;
  toggle.click();
  await waitForFast(() => {
    expect(attributionToggle(page)).toBe(toggle);
    expect(toggle).toMatchObject({ checked: true, disabled: true });
  });
  toggle.click();
  expect(request.mock.calls.filter(([method]) => method === "users.prefs.set")).toHaveLength(1);
  pending.reject(new Error("Attribution could not be saved"));
  await waitForFast(() => {
    expect(toggle).toMatchObject({ checked: false, disabled: false });
    expect(page.querySelector('[role="alert"]')?.textContent).toContain(
      "Attribution could not be saved",
    );
  });
  toggle.click();
  await waitForFast(() => {
    expect(toggle).toMatchObject({ checked: true, disabled: false });
    expect(page.querySelector('[role="alert"]')).toBeNull();
  });
  expect(request.mock.calls.filter(([method]) => method === "users.self")).toHaveLength(1);
  expect(page.querySelector<HTMLInputElement>("input.settings-toggle__input")?.checked).toBe(false);
  page.unmount();
  page = mountProfilePage(context);
  await waitForFast(() => {
    expect(attributionToggle(page)).toMatchObject({ disabled: false, checked: true });
  });
  expect(request.mock.calls.filter(([method]) => method === "users.prefs.get")).toHaveLength(2);
});

it("does not offer personal PR attribution without a durable profile", async () => {
  const request = mockRpc({ "users.self": () => ({ profile: null }) });
  const { page } = mountPreferences(
    request as GatewayBrowserClient["request"],
    "unresolved-profile",
  );
  await waitForFast(() =>
    expect(page.textContent).toContain("Your identity profile could not be loaded."),
  );
  expect(attributionToggle(page)).toBeUndefined();
  expect(request.mock.calls.some(([method]) => method.startsWith("users.prefs."))).toBe(false);
});

it("retires a pending attribution save when the requester changes", async () => {
  const save = createDeferred<{ status: "ok" }>();
  let profile = modelAccountProfile;
  const request = profileRpc(() => profile, {
    "users.prefs.get": () => ({ status: "ok", entries: {} }),
    "users.prefs.set": () => save.promise,
  });
  const harness = mountPreferences(request as GatewayBrowserClient["request"], profile.id);
  const { page } = harness;
  await waitForFast(() => expect(attributionToggle(page)?.disabled).toBe(false));
  attributionToggle(page)!.click();
  await waitForFast(() => expect(attributionToggle(page)?.disabled).toBe(true));
  profile = { ...modelAccountProfile, id: "profile-2", displayName: "Another person" };
  harness.emitSnapshot({ selfUser: { id: profile.id } });
  await waitForFast(() =>
    expect(page.querySelector<HTMLInputElement>(".identity-name-control input")?.value).toBe(
      "Another person",
    ),
  );
  await waitForFast(() => {
    expect(attributionToggle(page)).toMatchObject({ disabled: false, checked: false });
  });
  save.resolve({ status: "ok" });
  await waitForFast(() => expect(attributionToggle(page)?.disabled).toBe(false));
  expect(attributionToggle(page)?.checked).toBe(false);
});

it("shows pending coauthor consent and restores the accepted value after failure", async () => {
  const saved = createDeferred();
  const request = profileRpc(() => modelAccountProfile, {
    "users.prefs.get": () => ({ status: "ok", entries: { [GIT_COAUTHOR_PREFERENCE_KEY]: true } }),
    "users.prefs.set": () => saved.promise,
  });
  const harness = createConnectedContext(request as GatewayBrowserClient["request"], {
    id: modelAccountProfile.id,
    name: "Ada",
  });
  harness.emitHello(gatewayHelloForMethods([], ["operator.write"]));
  const page = mountProfilePage(harness.context);
  const toggle = () =>
    page.querySelector<HTMLInputElement>('#settings-profile-identity [role="switch"]');
  await waitForFast(() => {
    expect(toggle()?.checked).toBe(true);
    expect(toggle()?.getAttribute("aria-disabled")).toBeNull();
    expect(toggle()?.disabled).toBe(false);
  });
  toggle()!.click();
  await waitForFast(() => {
    expect(toggle()?.checked).toBe(false);
    expect(toggle()?.getAttribute("aria-disabled")).toBe("true");
    expect(toggle()?.disabled).toBe(false);
  });
  toggle()!.click();
  expect(request.mock.calls.filter(([method]) => method === "users.prefs.set")).toHaveLength(1);
  saved.reject(new Error("Consent could not be saved"));
  await waitForFast(() => {
    expect(toggle()?.checked).toBe(true);
    expect(toggle()?.getAttribute("aria-disabled")).toBeNull();
    expect(page.textContent).toContain("Consent could not be saved");
  });
});

it.each(["identity", "navigation"])(
  "releases a pending identity action on %s change",
  async (change) => {
    const saved = createDeferred();
    let profile = modelAccountProfile;
    const request = profileRpc(() => profile, {
      "users.prefs.get": () => ({ status: "ok", entries: { [GIT_COAUTHOR_PREFERENCE_KEY]: true } }),
      "users.prefs.set": () => saved.promise,
    });
    const harness = createConnectedContext(request as GatewayBrowserClient["request"], {
      id: profile.id,
      name: "Ada",
    });
    harness.emitHello(gatewayHelloForMethods([], ["operator.write"]));
    let page = mountProfilePage(harness.context);
    const toggle = () =>
      page.querySelector<HTMLInputElement>('#settings-profile-identity [role="switch"]');
    await waitForFast(() => {
      expect(toggle()?.checked).toBe(true);
      expect(toggle()?.getAttribute("aria-disabled")).toBeNull();
      expect(toggle()?.disabled).toBe(false);
    });
    toggle()!.click();
    await waitForFast(() =>
      expect(request.mock.calls.filter(([method]) => method === "users.prefs.set")).toHaveLength(1),
    );
    if (change === "navigation") {
      harness.emitNavigation();
      page.unmount();
    }
    profile = { ...modelAccountProfile, id: "profile-2", displayName: "Grace" };
    harness.emitSnapshot({ selfUser: { id: profile.id, name: "Grace" } });
    if (change === "navigation") {
      page = mountProfilePage(harness.context);
    }
    await waitForFast(() => {
      expect(page.querySelector<HTMLInputElement>(".identity-name-control input")?.value).toBe(
        "Grace",
      );
      expect(toggle()?.checked).toBe(true);
      expect(toggle()?.getAttribute("aria-disabled")).toBeNull();
    });
    saved.reject(new Error("Retired consent failure"));
    await saved.promise.catch(() => undefined);
    await waitForFast(() => {
      expect(toggle()?.checked).toBe(true);
      expect(toggle()?.getAttribute("aria-disabled")).toBeNull();
      expect(page.textContent).not.toContain("Retired consent failure");
    });
  },
);
