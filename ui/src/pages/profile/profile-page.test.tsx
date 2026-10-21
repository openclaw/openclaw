/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  GIT_COAUTHOR_PREFERENCE_KEY,
  type UserProfile,
} from "../../../../packages/gateway-protocol/src/index.ts";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
// These tests own identity loading, not the lazy preference reader; settle that module at setup
// so its cold transform cannot consume the one-second UI waits on a loaded CI runner.
import "../../app/user-prefs-request.ts";
import { i18n, t } from "../../i18n/index.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { openPicker, choosePickerValue } from "../../test-helpers/select-picker.ts";
import { waitForSolid as waitForFast, flush } from "../../test-helpers/solid-settle.ts";
import {
  createConnectedContext,
  modelAccountProfile,
  mountProfilePage,
} from "./profile-page.test-support.tsx";

const modelAccountCatalog = {
  providers: [
    { id: "openai", label: "OpenAI", methods: [{ id: "browser", label: "Browser sign-in" }] },
  ],
};
const modelAccountStep = {
  id: "redirect",
  type: "text",
  message: "Paste the redirect URL or wait for sign-in to finish.",
  externalUrl: "https://auth.openai.com/oauth/authorize?state=s",
};

async function startProfileSignIn(page: ParentNode) {
  page.querySelector<HTMLButtonElement>(".profile-auth-add-account")!.click();
  await waitForFast(() =>
    expect(
      page.querySelector<HTMLButtonElement>(".profile-auth-provider .picker-select__trigger")
        ?.disabled,
    ).toBe(false),
  );
  await openPicker(page.querySelector<HTMLElement>(".profile-auth-provider")!);
  await waitForFast(() =>
    expect(page.querySelector('[role="option"][data-value="openai"]')).not.toBeNull(),
  );
  const picker = page.querySelector<HTMLElement>(".profile-auth-provider")!;
  await choosePickerValue(picker, "openai");
  await waitForFast(() =>
    expect(page.querySelector<HTMLButtonElement>(".profile-auth-connect-start")?.disabled).toBe(
      false,
    ),
  );
  page.querySelector<HTMLButtonElement>(".profile-auth-connect-start")!.click();
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

it("renders identity before Usage statistics and opens the usage page", async () => {
  const profile = modelAccountProfile;
  const request = vi.fn(async (method: string) => {
    if (method === "users.prefs.get") {
      return { status: "ok", entries: {} };
    }
    if (method === "users.self") {
      return { profile };
    }
    if (method === "users.listModelAccounts") {
      return { profileId: profile.id, accounts: [], links: [] };
    }
    throw new Error(`unexpected method: ${method}`);
  });
  const harness = createConnectedContext(request as GatewayBrowserClient["request"], {
    id: profile.id,
    email: profile.emails[0],
    name: profile.displayName ?? undefined,
  });
  const page = mountProfilePage(harness.context);
  await waitForFast(() => expect(page.querySelector("#settings-profile-identity")).not.toBeNull());
  await waitForFast(() =>
    expect(page.querySelector('[data-github-connection="personal"]')).not.toBeNull(),
  );

  await waitForFast(() =>
    expect(request.mock.calls.map(([method]) => method).toSorted()).toEqual(
      ["users.self", "users.listModelAccounts", "users.prefs.get"].toSorted(),
    ),
  );
  const identity = page.querySelector("#settings-profile-identity");
  expect(identity?.textContent).toContain("No single verified GitHub sign-in account");
  expect(
    [...(identity?.querySelectorAll(".settings-row__title") ?? [])].filter(
      (node) => node.textContent?.trim() === "Linked emails",
    ),
  ).toHaveLength(1);
  const docsLink = page.querySelector<HTMLAnchorElement>(".page-subtitle a");
  expect(docsLink?.textContent?.trim()).toBe("Learn more");
  expect(docsLink?.href).toBe("https://docs.openclaw.ai/concepts/user-model");
  expect(page.querySelector(".profile-stats")).toBeNull();
  expect(page.querySelector(".profile-heatmap")).toBeNull();
  const usageRow = page.querySelector<HTMLButtonElement>(".settings-row--nav");
  expect(usageRow?.textContent).toContain("Usage statistics");
  expect(page.querySelector("#settings-profile-identity")?.compareDocumentPosition(usageRow!)).toBe(
    Node.DOCUMENT_POSITION_FOLLOWING,
  );

  usageRow?.click();
  expect(harness.context.navigate).toHaveBeenCalledWith("usage");
});

it("loads a read-only profile without enabling mutations", async () => {
  const scope = "operator.read";
  const request = vi.fn(async (method: string) =>
    method === "users.self"
      ? { profile: modelAccountProfile }
      : {
          personal: {
            state: "disconnected",
            generation: null,
            account: null,
            accessExpiresAtMs: null,
            refreshState: "not_applicable",
            pending: null,
          },
          system: {
            source: "system-detected",
            credentialKind: "native",
            credentialState: "unavailable",
            account: null,
            gitAuthor: { name: null, email: null },
            evidence: "none",
            accessExpiresAtMs: null,
            refreshState: "not_applicable",
            oauthScopes: [],
            repositoryGrants: "unknown",
          },
        },
  );
  const harness = createConnectedContext(request as GatewayBrowserClient["request"], {
    id: "profile-1",
    email: "ada@example.test",
    name: "Ada",
  });
  harness.context.gateway.snapshot.hello = {
    type: "hello-ok",
    protocol: 1,
    auth: { role: "operator", scopes: [scope] },
    features: { methods: ["users.self"] },
  } as ApplicationGatewaySnapshot["hello"];
  const page = mountProfilePage(harness.context);

  flush();
  await waitForFast(() =>
    expect(page.querySelector(".identity-name-control input")).not.toBeNull(),
  );
  expect(request.mock.calls.some(([method]) => method === "users.self")).toBe(true);
  expect(page.textContent).toContain("Your current access does not allow profile editing.");
  expect(page.querySelector("#settings-profile-access .settings-row__value")?.textContent).toBe(
    scope,
  );
  expect(page.querySelector<HTMLInputElement>(".identity-name-control input")?.disabled).toBe(true);
  expect(page.querySelector<HTMLButtonElement>(".identity-name-control button")?.disabled).toBe(
    true,
  );
  expect(page.querySelector('input[type="file"]')).toBeNull();
  expect(page.querySelector(".profile-refresh")).not.toBeNull();
  expect(
    request.mock.calls.some(
      ([method]) => method.startsWith("users.set") || method === "users.prefs.set",
    ),
  ).toBe(false);
});

it("offers identity connection setup without profile RPCs or secret inputs for unidentified connections", async () => {
  const request = vi.fn();
  const harness = createConnectedContext(request as GatewayBrowserClient["request"]);
  const page = mountProfilePage(harness.context);

  await waitForFast(() =>
    expect(page.querySelector("#settings-profile-identity")?.textContent).toContain(
      "This connection has no personal profile",
    ),
  );

  expect(
    request.mock.calls.some(
      ([method]) =>
        method === "users.self" ||
        method === "users.listModelAccounts" ||
        method.startsWith("users.authConnect."),
    ),
  ).toBe(false);
  const identity = page.querySelector("#settings-profile-identity");
  expect(identity?.textContent).toContain("This connection has no personal profile");
  expect(identity?.textContent).toContain("Cloudflare Access, Tailscale Serve, or a trusted proxy");
  expect(
    page.querySelector('a[href="https://docs.openclaw.ai/concepts/user-model"]'),
  ).not.toBeNull();
  expect(page.querySelector(".identity-name-control")).toBeNull();
  expect(page.querySelector('input[type="file"]')).toBeNull();
  expect(page.querySelector(".profile-refresh")).not.toBeNull();
  expect(page.querySelector('.profile-auth-add-account, input[type="password"]')).toBeNull();
  expect(page.textContent).toContain("ws://test.invalid");
  expect(page.textContent).toContain("Personal");
  [...page.querySelectorAll("button")]
    .find((button) => button.textContent?.trim() === "Connection settings")
    ?.click();
  expect(harness.context.navigate).toHaveBeenCalledWith("connection");
});

it("keeps identity refresh single-flight and allows retry after settlement", async () => {
  const profile = { ...modelAccountProfile };
  let rejectIdentity: ((reason: Error) => void) | undefined;
  const firstIdentity = new Promise<never>((_resolve, reject) => {
    rejectIdentity = reject;
  });
  const request = vi.fn(async (method: string) => {
    if (method === "users.prefs.get") {
      return { status: "ok", entries: {} };
    }
    if (method !== "users.self") {
      throw new Error(`unexpected method: ${method}`);
    }
    if (request.mock.calls.length === 1) {
      return await firstIdentity;
    }
    return { profile };
  });
  const harness = createConnectedContext(request as GatewayBrowserClient["request"], {
    id: profile.id,
    email: profile.emails[0],
    name: profile.displayName ?? undefined,
  });
  const page = mountProfilePage(harness.context);

  await waitForFast(() =>
    expect(request.mock.calls.filter(([method]) => method === "users.self")).toHaveLength(1),
  );
  flush();
  const refresh = page.querySelector<HTMLButtonElement>(".profile-refresh")!;
  expect(refresh.disabled).toBe(true);
  expect(refresh.textContent?.trim()).toBe(t("common.refreshing"));

  refresh.click();
  refresh.click();
  flush();
  expect(request.mock.calls.filter(([method]) => method === "users.self")).toHaveLength(1);

  rejectIdentity?.(new Error("identity unavailable: OPENAI_API_KEY=sk-1234567890abcdef"));
  await waitForFast(() => expect(refresh.disabled).toBe(false));
  expect(refresh.textContent?.trim()).toBe(t("common.refresh"));
  expect(page.textContent).toContain("identity unavailable: OPENAI_API_KEY=sk-123...cdef");
  expect(page.textContent).not.toContain("sk-1234567890abcdef");

  refresh.click();
  await waitForFast(() =>
    expect(request.mock.calls.filter(([method]) => method === "users.self")).toHaveLength(2),
  );
  await waitForFast(() =>
    expect(page.querySelector<HTMLInputElement>(".identity-name-control input")?.value).toBe("Ada"),
  );
});

it("replaces an in-flight identity request after a same-client reconnect", async () => {
  const staleProfile: UserProfile = {
    ...modelAccountProfile,
    displayName: "Stale identity",
  };
  const freshProfile = { ...staleProfile, displayName: "Fresh identity", updatedAt: 3 };
  let resolveStale: ((value: { profile: UserProfile }) => void) | undefined;
  let resolveFresh: ((value: { profile: UserProfile }) => void) | undefined;
  const staleRequest = new Promise<{ profile: UserProfile }>((resolve) => {
    resolveStale = resolve;
  });
  const freshRequest = new Promise<{ profile: UserProfile }>((resolve) => {
    resolveFresh = resolve;
  });
  const request = vi.fn(async (method: string) => {
    if (method === "users.prefs.get") {
      return { status: "ok", entries: {} };
    }
    if (method === "users.listModelAccounts") {
      return { profileId: "profile-1", accounts: [], links: [] };
    }
    if (method !== "users.self") {
      throw new Error(`unexpected method: ${method}`);
    }
    return await (request.mock.calls.filter(([called]) => called === "users.self").length === 1
      ? staleRequest
      : freshRequest);
  });
  const harness = createConnectedContext(request as GatewayBrowserClient["request"], {
    id: staleProfile.id,
    email: staleProfile.emails[0],
    name: staleProfile.displayName ?? undefined,
  });
  const page = mountProfilePage(harness.context);

  const selfCalls = () => request.mock.calls.filter(([method]) => method === "users.self");
  await waitForFast(() => expect(selfCalls()).toHaveLength(1));
  harness.emitConnected(false);
  flush();
  harness.emitConnected(true);
  await waitForFast(() => expect(selfCalls()).toHaveLength(2));

  resolveFresh?.({ profile: freshProfile });
  await waitForFast(() =>
    expect(page.querySelector<HTMLInputElement>(".identity-name-control input")?.value).toBe(
      "Fresh identity",
    ),
  );
  resolveStale?.({ profile: staleProfile });
  await staleRequest;
  await Promise.resolve();
  flush();

  expect(page.querySelector<HTMLInputElement>(".identity-name-control input")?.value).toBe(
    "Fresh identity",
  );
  expect(selfCalls()).toHaveLength(2);
});

it("keeps model-account actions usable when identity refresh overlaps ChatGPT completion", async () => {
  const profile = { ...modelAccountProfile };
  let links: Array<{ provider: string; authProfileId: string; updatedAt: number }> = [];
  const completion = createDeferred();
  const request = vi.fn(async (method: string, params?: unknown) => {
    if (method === "users.prefs.get") {
      return { status: "ok", entries: {} };
    }
    if (method === "users.self") {
      return { profile };
    }
    if (method === "users.listModelAccounts") {
      return {
        profileId: profile.id,
        accounts: links.map((link) => ({
          ...link,
          label: "Ada · Personal workspace",
          authType: "oauth",
          selected: true,
        })),
        links,
      };
    }
    if (method === "users.authConnect.start") {
      expect(params).toEqual({ profileId: "profile-1", provider: "openai", method: "browser" });
      return {
        connectId: "connect-1",
        expiresAtMs: Date.now() + 60_000,
      };
    }
    if (method === "users.authConnect.catalog") {
      return modelAccountCatalog;
    }
    if (method === "users.authConnect.status") {
      return { status: "pending", step: modelAccountStep };
    }
    if (method === "users.authConnect.answer") {
      expect(params).toEqual({
        profileId: "profile-1",
        connectId: "connect-1",
        stepId: "redirect",
        value: "http://localhost:1455/auth/callback?code=abc&state=s",
      });
      await completion.promise;
      links = [{ provider: "openai", authProfileId: "openai:ada", updatedAt: 5 }];
      return { status: "connected", authProfileId: "openai:ada", links };
    }
    throw new Error(`unexpected method: ${method}`);
  });
  const harness = createConnectedContext(request as GatewayBrowserClient["request"], {
    id: "profile-1",
    email: "ada@example.test",
    name: "Ada",
  });
  const page = mountProfilePage(harness.context);

  await waitForFast(() => expect(page.querySelector(".profile-auth-add-account")).not.toBeNull());
  await startProfileSignIn(page);
  await waitForFast(() =>
    expect(page.querySelector("#profile-account-auth-answer")).not.toBeNull(),
  );
  expect(page.querySelector<HTMLAnchorElement>(".wizard-step__external-link")?.href).toContain(
    "auth.openai.com",
  );

  const redirect = page.querySelector<HTMLInputElement>("#profile-account-auth-answer")!;
  redirect.value = "http://localhost:1455/auth/callback?code=abc&state=s";
  redirect.dispatchEvent(new Event("input", { bubbles: true }));
  flush();
  page.querySelector<HTMLButtonElement>('.wizard-step__form button[type="submit"]')!.click();

  await waitForFast(() =>
    expect(request.mock.calls.some(([method]) => method === "users.authConnect.answer")).toBe(true),
  );
  page.querySelector<HTMLButtonElement>(".profile-refresh")!.click();
  await waitForFast(() =>
    expect(request.mock.calls.filter(([method]) => method === "users.self")).toHaveLength(2),
  );
  await waitForFast(() =>
    expect(page.querySelector<HTMLButtonElement>(".profile-refresh")?.disabled).toBe(false),
  );
  completion.resolve();
  await waitForFast(() => expect(page.textContent).toContain("Ada · Personal workspace"));
  expect(page.querySelector("#profile-account-auth-answer")).toBeNull();
  expect(page.querySelector<HTMLButtonElement>(".profile-auth-add-account")?.disabled).toBe(false);
  expect(page.querySelector<HTMLButtonElement>(".profile-auth-link-unlink")?.disabled).toBe(false);
});

it("replaces a retired profile read when the same ID gains profile qualification", async () => {
  const harness = createConnectedContext(
    vi.fn(async () => ({})) as GatewayBrowserClient["request"],
    { id: modelAccountProfile.id },
  );
  harness.emitHello(gatewayHelloForMethods([], ["operator.read"]));
  const retired = createDeferred<null>();
  const load = vi.fn(harness.context.gateway.loadSelfProfile);
  load.mockReturnValueOnce(retired.promise).mockResolvedValue(modelAccountProfile);
  harness.context.gateway.loadSelfProfile = load;
  const page = mountProfilePage(harness.context);
  flush();
  harness.context.gateway.updateSelfUser?.({
    identity: { type: "profile", id: modelAccountProfile.id },
  });
  retired.resolve(null);
  await retired.promise;
  flush();
  expect(load).toHaveBeenCalledTimes(2);
  expect(page.querySelector<HTMLInputElement>(".identity-name-control input")?.value).toBe(
    modelAccountProfile.displayName,
  );
});

it.each([
  { scopes: ["operator.read"], summary: "You have permission to view server information." },
  { scopes: ["operator.write"], summary: "You have permission to send messages and make changes." },
  {
    scopes: ["operator.sessions.read"],
    summary: "You have permission to view your own sessions.",
  },
  { scopes: ["operator.admin"], summary: "You have permission to manage this server." },
  {
    scopes: ["operator.approvals"],
    summary: "This connection has a limited set of permissions.",
  },
  {
    scopes: ["operator.read", "operator.sessions.write"],
    summary: "You have permission to work in your own sessions.",
  },
])("explains $scopes with diagnostics collapsed", async ({ scopes, summary }) => {
  const request = vi.fn(async () => ({}));
  const harness = createConnectedContext(request as GatewayBrowserClient["request"]);
  harness.emitHello(gatewayHelloForMethods([], scopes));
  const page = mountProfilePage(harness.context);
  flush();

  const access = page.querySelector("#settings-profile-access");
  expect(access?.querySelector(".settings-row__title")?.textContent).toBe(summary);
  const details = access?.querySelector("details");
  expect(details?.open).toBe(false);
  expect(details?.querySelector("summary")?.textContent).toBe("Technical details");
  expect(details?.querySelector(".settings-row__value")?.textContent).toBe(scopes.join(", "));
  expect(access?.textContent).toContain(
    "Sessions, browsers, and tools may have additional restrictions.",
  );
  expect(access?.textContent).toContain("Ask your server administrator to review your access.");
  expect(request).not.toHaveBeenCalled();
});

it("distinguishes unreported permissions from an explicit empty grant", async () => {
  const harness = createConnectedContext(
    vi.fn(async () => ({})) as GatewayBrowserClient["request"],
  );
  const page = mountProfilePage(harness.context);
  flush();
  expect(page.querySelector("#settings-profile-access")?.textContent).toContain(
    "Your permissions could not be confirmed.",
  );

  harness.emitHello(gatewayHelloForMethods([], []));
  flush();
  expect(page.querySelector("#settings-profile-access")?.textContent).toContain(
    "This connection has no permissions.",
  );
  expect(page.querySelector("#settings-profile-access")?.textContent).not.toContain(
    "could not be confirmed",
  );
});

it("reconnects through the connection owner while retaining the last access summary and editor", async () => {
  const scope = "operator.admin";
  const harness = createConnectedContext(
    vi.fn(async () => ({})) as GatewayBrowserClient["request"],
  );
  harness.emitHello(gatewayHelloForMethods([], [scope]));
  vi.mocked(harness.context.gateway.connect).mockImplementation(() => harness.emitConnected(false));
  const page = mountProfilePage(harness.context);
  flush();
  expect(page.querySelector(".settings-row__value")?.textContent).toBe(scope);

  const reconnect = page.querySelector<HTMLButtonElement>("#settings-profile-access button");
  const personalEditor = page.querySelector("openclaw-personal-instructions");
  expect(personalEditor).not.toBeNull();
  expect(reconnect?.textContent?.trim()).toBe("Reconnect");
  reconnect?.click();
  expect(harness.context.gateway.connect).toHaveBeenCalledExactlyOnceWith();
  flush();
  expect(page.querySelector("#settings-profile-access .settings-row__value")?.textContent).toBe(
    scope,
  );
  expect(page.textContent).toContain("You have permission to manage this server.");
  expect(page.querySelector("openclaw-personal-instructions")).toBe(personalEditor);

  harness.emitHello(gatewayHelloForMethods([], ["operator.read"]));
  harness.emitConnected(true);
  flush();
  expect(page.querySelector(".settings-row__value")?.textContent).toBe("operator.read");

  // Narrow-grant updates do not change the profile editor's broad write permission.
  harness.emitHello(gatewayHelloForMethods([], ["operator.sessions.read"]));
  flush();
  expect(page.querySelector(".settings-row__value")?.textContent).toBe("operator.sessions.read");
});

it("preserves an unsaved display-name draft when unrelated negotiated scopes change", async () => {
  const reload = createDeferred<{ profile: typeof modelAccountProfile }>();
  let selfReads = 0;
  const request = vi.fn(async (method: string) => {
    if (method === "users.self") {
      return ++selfReads === 1 ? { profile: modelAccountProfile } : reload.promise;
    }
    if (method === "users.listModelAccounts") {
      return { profileId: modelAccountProfile.id, accounts: [], links: [] };
    }
    throw new Error(`unexpected method: ${method}`);
  });
  const harness = createConnectedContext(request, {
    id: modelAccountProfile.id,
    name: modelAccountProfile.displayName ?? undefined,
  });
  harness.emitHello(gatewayHelloForMethods([], ["operator.admin"]));
  const page = mountProfilePage(harness.context);

  const input = () => page.querySelector<HTMLInputElement>(".identity-name-control input");
  const refresh = () => page.querySelector<HTMLButtonElement>(".profile-refresh");
  await waitForFast(() => expect(input()?.value).toBe(modelAccountProfile.displayName));
  input()!.value = "Unsaved profile draft";
  input()!.dispatchEvent(new Event("input", { bubbles: true }));
  flush();

  harness.emitHello(gatewayHelloForMethods([], ["operator.admin", "operator.read"]));
  await waitForFast(() => expect(refresh()?.disabled).toBe(true));
  reload.resolve({ profile: modelAccountProfile });
  await waitForFast(() => expect(refresh()?.disabled).toBe(false));
  expect(input()?.value).toBe("Unsaved profile draft");
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
        expect(params).toEqual({ keys: [GIT_COAUTHOR_PREFERENCE_KEY] });
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
