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

beforeEach(async () => {
  await i18n.setLocale("en");
});

afterEach(async () => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await i18n.setLocale("en");
});

it("loads and updates co-author consent separately from verified GitHub identity", async () => {
  const profile: UserProfile = {
    ...modelAccountProfile,
    emails: [],
    githubIdentity: {
      login: "octocat",
      profileUrl: "https://github.com/octocat",
      avatarUrl: "https://avatars.githubusercontent.com/u/583231?v=4",
    },
  };
  const request = vi.fn(async (method: string, params?: unknown) => {
    if (method === "users.self") {
      return { profile };
    }
    if (method === "users.listModelAccounts") {
      return { profileId: "profile-1", accounts: [], links: [] };
    }
    if (method === "users.prefs.get") {
      expect(params).toEqual({ keys: [GIT_COAUTHOR_PREFERENCE_KEY] });
      return { status: "ok", entries: { [GIT_COAUTHOR_PREFERENCE_KEY]: false } };
    }
    if (method === "users.prefs.set") {
      expect(params).toEqual({ entries: { [GIT_COAUTHOR_PREFERENCE_KEY]: true } });
      return { status: "ok" };
    }
    throw new Error(`unexpected method: ${method}`);
  });
  const harness = createConnectedContext(request as GatewayBrowserClient["request"], {
    id: profile.id,
    name: profile.displayName ?? undefined,
  });
  const page = mountProfilePage(harness.context);

  await waitForFast(() => expect(page.querySelector(".settings-account")).not.toBeNull());
  await waitForFast(() =>
    expect(page.querySelector<HTMLElement & { checked: boolean }>("wa-switch")?.checked).toBe(
      false,
    ),
  );
  expect(request.mock.calls.map(([method]) => method).toSorted()).toEqual(
    ["users.self", "users.listModelAccounts", "users.prefs.get"].toSorted(),
  );
  expect(page.querySelector(".identity-github-form")).toBeNull();
  const toggle = page.querySelector<HTMLElement & { checked: boolean }>("wa-switch");
  expect(toggle?.checked).toBe(false);

  toggle!.checked = true;
  toggle?.dispatchEvent(new Event("change", { bubbles: true }));

  await waitForFast(() =>
    expect(request.mock.calls.filter(([method]) => method === "users.prefs.set")).toHaveLength(1),
  );
  await waitForFast(() => expect(toggle?.checked).toBe(true));
  expect(request.mock.calls.map(([method]) => method).toSorted()).toEqual(
    ["users.self", "users.listModelAccounts", "users.prefs.get", "users.prefs.set"].toSorted(),
  );
});

it("treats a malformed co-author preference as opted out", async () => {
  const profile: UserProfile = {
    ...modelAccountProfile,
    emails: [],
    githubIdentity: {
      login: "octocat",
      profileUrl: "https://github.com/octocat",
      avatarUrl: "https://avatars.githubusercontent.com/u/583231?v=4",
    },
  };
  const request = vi.fn(async (method: string) => {
    if (method === "users.self") {
      return { profile };
    }
    if (method === "users.prefs.get") {
      // The preference API stores arbitrary JSON; a non-boolean row must not publish a trailer.
      return { status: "ok", entries: { [GIT_COAUTHOR_PREFERENCE_KEY]: "not-a-boolean" } };
    }
    throw new Error(`unexpected method: ${method}`);
  });
  const harness = createConnectedContext(request as GatewayBrowserClient["request"], {
    id: profile.id,
    name: profile.displayName ?? undefined,
  });
  const page = mountProfilePage(harness.context);

  await waitForFast(() => expect(page.querySelector(".settings-account")).not.toBeNull());
  const toggle = page.querySelector<HTMLElement & { checked: boolean }>("wa-switch");
  await waitForFast(() => expect(toggle?.checked).toBe(false));
});

it("keeps co-author credit on until the person opts out", async () => {
  const profile: UserProfile = {
    ...modelAccountProfile,
    emails: [],
    githubIdentity: {
      login: "octocat",
      profileUrl: "https://github.com/octocat",
      avatarUrl: "https://avatars.githubusercontent.com/u/583231?v=4",
    },
  };
  const request = vi.fn(async (method: string, params?: unknown) => {
    if (method === "users.self") {
      return { profile };
    }
    if (method === "users.prefs.get") {
      // No stored row: the verified account is credited without an explicit opt-in.
      return { status: "ok", entries: {} };
    }
    if (method === "users.prefs.set") {
      expect(params).toEqual({ entries: { [GIT_COAUTHOR_PREFERENCE_KEY]: false } });
      return { status: "ok" };
    }
    throw new Error(`unexpected method: ${method}`);
  });
  const harness = createConnectedContext(request as GatewayBrowserClient["request"], {
    id: profile.id,
    name: profile.displayName ?? undefined,
  });
  const page = mountProfilePage(harness.context);

  await waitForFast(() => expect(page.querySelector(".settings-account")).not.toBeNull());
  const toggle = page.querySelector<HTMLElement & { checked: boolean }>("wa-switch");
  await waitForFast(() => expect(toggle?.checked).toBe(true));

  toggle!.checked = false;
  toggle?.dispatchEvent(new Event("change", { bubbles: true }));

  await waitForFast(() =>
    expect(request.mock.calls.filter(([method]) => method === "users.prefs.set")).toHaveLength(1),
  );
  await waitForFast(() => expect(toggle?.checked).toBe(false));
});
