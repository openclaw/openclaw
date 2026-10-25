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
import { waitForSolid as waitForFast } from "../../test-helpers/solid-settle.ts";
import {
  createConnectedContext,
  modelAccountProfile,
  mountProfilePage,
} from "./profile-page.test-support.tsx";

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
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "users.self") {
        return { profile };
      }
      if (method === "users.listModelAccounts") {
        return { profileId: "profile-1", accounts: [], links: [] };
      }
      if (method === "users.prefs.get") {
        expect(params).toEqual({
          keys: [GIT_COAUTHOR_PREFERENCE_KEY, "github.prAttribution.enabled"],
        });
        return {
          status: "ok",
          entries: stored === undefined ? {} : { [GIT_COAUTHOR_PREFERENCE_KEY]: stored },
        };
      }
      if (method === "users.prefs.set") {
        expect(params).toEqual({ entries: { [GIT_COAUTHOR_PREFERENCE_KEY]: updated } });
        return { status: "ok" };
      }
      throw new Error(`unexpected method: ${method}`);
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
      expect(toggle?.disabled).toBe(false);
      expect(toggle?.checked).toBe(enabled);
    });
    expect(request.mock.calls.map(([method]) => method).toSorted()).toEqual(
      ["users.self", "users.listModelAccounts", "users.prefs.get"].toSorted(),
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
      ["users.self", "users.listModelAccounts", "users.prefs.get", "users.prefs.set"].toSorted(),
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
    };
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "users.self") {
        return { profile };
      }
      if (method === "users.listModelAccounts") {
        return { profileId: profile.id, accounts: [], links: [] };
      }
      if (method === "users.prefs.get") {
        return { status: "ok", entries: { "github.prAttribution.enabled": stored } };
      }
      if (method === "users.prefs.set") {
        expect(params).toEqual({ entries: { "github.prAttribution.enabled": !enabled } });
        return { status: "ok" };
      }
      throw new Error("unexpected method: " + method);
    });
    const { context } = createConnectedContext(request as GatewayBrowserClient["request"], {
      id: profile.id,
    });
    const page = mountProfilePage(context);
    await waitForFast(() => {
      expect(attributionToggle(page)).toBeDefined();
      expect(attributionToggle(page)?.disabled).toBe(false);
      expect(attributionToggle(page)?.checked).toBe(enabled);
    });
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
    const request = vi.fn(async (method: string) => {
      if (method === "users.self") {
        return { profile };
      }
      if (method === "users.listModelAccounts") {
        return { profileId: profile.id, accounts: [], links: [] };
      }
      if (method === "users.prefs.get" && failure !== "read") {
        return { status: "ok", entries: {} };
      }
      throw new Error("Preference service unavailable");
    });
    const { context } = createConnectedContext(request as GatewayBrowserClient["request"], {
      id: profile.id,
    });
    const page = mountProfilePage(context);
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
  const request = vi.fn(async (method: string, params?: unknown) => {
    if (method === "users.self") {
      return { profile: modelAccountProfile };
    }
    if (method === "users.listModelAccounts") {
      return { profileId: modelAccountProfile.id, accounts: [], links: [] };
    }
    if (method === "users.prefs.get") {
      return {
        status: "ok",
        entries: { "github.prAttribution.enabled": enabled, [GIT_COAUTHOR_PREFERENCE_KEY]: false },
      };
    }
    if (method === "users.prefs.set") {
      expect(params).toEqual({ entries: { "github.prAttribution.enabled": true } });
      if (request.mock.calls.filter(([name]) => name === "users.prefs.set").length === 1) {
        return pending.promise;
      }
      enabled = true;
      return { status: "ok" };
    }
    throw new Error("unexpected method: " + method);
  });
  const { context } = createConnectedContext(request as GatewayBrowserClient["request"], {
    id: modelAccountProfile.id,
  });
  let page = mountProfilePage(context);
  await waitForFast(() => expect(attributionToggle(page)?.disabled).toBe(false));
  const toggle = attributionToggle(page)!;
  toggle.click();
  await waitForFast(() => {
    expect(attributionToggle(page)).toBe(toggle);
    expect(toggle.checked).toBe(true);
    expect(toggle.disabled).toBe(true);
  });
  toggle.click();
  expect(request.mock.calls.filter(([method]) => method === "users.prefs.set")).toHaveLength(1);
  pending.reject(new Error("Attribution could not be saved"));
  await waitForFast(() => {
    expect(toggle.checked).toBe(false);
    expect(toggle.disabled).toBe(false);
    expect(page.querySelector('[role="alert"]')?.textContent).toContain(
      "Attribution could not be saved",
    );
  });
  toggle.click();
  await waitForFast(() => {
    expect(toggle.checked).toBe(true);
    expect(toggle.disabled).toBe(false);
    expect(page.querySelector('[role="alert"]')).toBeNull();
  });
  expect(request.mock.calls.filter(([method]) => method === "users.self")).toHaveLength(1);
  expect(page.querySelector<HTMLInputElement>("input.settings-toggle__input")?.checked).toBe(false);
  page.unmount();
  page = mountProfilePage(context);
  await waitForFast(() => {
    expect(attributionToggle(page)?.disabled).toBe(false);
    expect(attributionToggle(page)?.checked).toBe(true);
  });
  expect(request.mock.calls.filter(([method]) => method === "users.prefs.get")).toHaveLength(2);
});

it("does not offer personal PR attribution without a durable profile", async () => {
  const request = vi.fn(async (method: string) => {
    if (method === "users.self") {
      return { profile: null };
    }
    throw new Error("unexpected method: " + method);
  });
  const { context } = createConnectedContext(request as GatewayBrowserClient["request"], {
    id: "unresolved-profile",
  });
  const page = mountProfilePage(context);
  await waitForFast(() =>
    expect(page.textContent).toContain("Your identity profile could not be loaded."),
  );
  expect(attributionToggle(page)).toBeUndefined();
  expect(request.mock.calls.some(([method]) => method.startsWith("users.prefs."))).toBe(false);
});

it("retires a pending attribution save when the requester changes", async () => {
  const save = createDeferred<{ status: "ok" }>();
  let profile = modelAccountProfile;
  const request = vi.fn(async (method: string) => {
    if (method === "users.self") {
      return { profile };
    }
    if (method === "users.listModelAccounts") {
      return { profileId: profile.id, accounts: [], links: [] };
    }
    if (method === "users.prefs.get") {
      return { status: "ok", entries: {} };
    }
    if (method === "users.prefs.set") {
      return save.promise;
    }
    throw new Error("unexpected method: " + method);
  });
  const harness = createConnectedContext(request as GatewayBrowserClient["request"], {
    id: profile.id,
  });
  const page = mountProfilePage(harness.context);
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
    expect(attributionToggle(page)?.disabled).toBe(false);
    expect(attributionToggle(page)?.checked).toBe(false);
  });
  save.resolve({ status: "ok" });
  await waitForFast(() => expect(attributionToggle(page)?.disabled).toBe(false));
  expect(attributionToggle(page)?.checked).toBe(false);
});
