/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GIT_COAUTHOR_PREFERENCE_KEY } from "../../../../packages/gateway-protocol/src/index.ts";
import type { UserProfile } from "../../../../packages/gateway-protocol/src/index.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { i18n } from "../../i18n/index.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  createConnectedContext,
  modelAccountProfile,
  mountProfilePage,
} from "./profile-page.test-support.ts";

const profile: UserProfile = {
  ...modelAccountProfile,
  emails: [],
  githubIdentity: {
    login: "octocat",
    profileUrl: "https://github.com/octocat",
    avatarUrl: "https://avatars.githubusercontent.com/u/583231?v=4",
  },
};

beforeEach(async () => {
  await i18n.setLocale("en");
});

afterEach(async () => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await i18n.setLocale("en");
});

async function mount(request: GatewayBrowserClient["request"]) {
  const harness = createConnectedContext(request, {
    id: profile.id,
    name: profile.displayName ?? undefined,
  });
  const page = mountProfilePage(harness.context);
  await waitForFast(() => expect(page.querySelector(".settings-account")).not.toBeNull());
  return page;
}

it.each([
  { stored: false, enabled: false, updated: true },
  { stored: "not-a-boolean", enabled: false, updated: undefined },
  { stored: undefined, enabled: true, updated: false },
])(
  "loads co-author consent $stored as $enabled and applies opt changes",
  async ({ stored, enabled, updated }) => {
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "users.self") {
        return { profile };
      }
      if (method === "users.listModelAccounts" && stored === false) {
        return { profileId: "profile-1", accounts: [], links: [] };
      }
      if (method === "users.prefs.get") {
        expect(params).toEqual({ keys: [GIT_COAUTHOR_PREFERENCE_KEY] });
        return {
          status: "ok",
          entries: stored === undefined ? {} : { [GIT_COAUTHOR_PREFERENCE_KEY]: stored },
        };
      }
      if (method === "users.prefs.set" && updated !== undefined) {
        expect(params).toEqual({ entries: { [GIT_COAUTHOR_PREFERENCE_KEY]: updated } });
        return { status: "ok" };
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const page = await mount(request as GatewayBrowserClient["request"]);
    const toggle = page.querySelector<HTMLElement & { checked: boolean }>("wa-switch");
    await waitForFast(() => expect(toggle?.checked).toBe(enabled));
    if (stored === false) {
      expect(request.mock.calls.map(([method]) => method).toSorted()).toEqual(
        ["users.self", "users.listModelAccounts", "users.prefs.get"].toSorted(),
      );
    }
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
    if (stored === false) {
      expect(request.mock.calls.map(([method]) => method).toSorted()).toEqual(
        ["users.self", "users.listModelAccounts", "users.prefs.get", "users.prefs.set"].toSorted(),
      );
    }
  },
);
