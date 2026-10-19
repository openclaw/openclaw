/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  GIT_COAUTHOR_PREFERENCE_KEY,
  type UserProfile,
} from "../../../../packages/gateway-protocol/src/index.ts";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createApplicationConfigCapability } from "../../app/config.ts";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
// These tests own identity loading, not the lazy preference reader; settle that module at setup
// so its cold transform cannot consume the one-second UI waits on a loaded CI runner.
import "../../app/user-prefs-request.ts";
import type { AuthenticatedUser } from "../../app/user-profile.ts";
import { i18n, t } from "../../i18n/index.ts";
import { uploadsDisabledMessage } from "../../lib/uploads.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { choosePickerValue } from "../../test-helpers/select-picker.ts";
import { waitForSolid as waitForFast, flush } from "../../test-helpers/solid-settle.ts";
import * as avatarProcessing from "./avatar-processing.ts";
import {
  createConnectedContext,
  modelAccountProfile,
  mountProfilePage,
} from "./profile-page.test-support.tsx";
import { disconnectedGitHub, mockRpc } from "./profile-rpc.test-support.ts";

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
function person(profile: UserProfile = modelAccountProfile): AuthenticatedUser {
  return { id: profile.id, email: profile.emails[0], name: profile.displayName ?? undefined };
}
function mount(request: GatewayBrowserClient["request"], user: AuthenticatedUser | null = null) {
  const harness = createConnectedContext(request, user);
  return { ...harness, page: mountProfilePage(harness.context) };
}
function nameInput(page: ParentNode) {
  return page.querySelector<HTMLInputElement>(".identity-name-control input");
}
function viewerAvatar(page: ParentNode) {
  return page.querySelector<HTMLElement & { user?: AuthenticatedUser }>("openclaw-viewer-avatar");
}
function callCount(request: { mock: { calls: unknown[][] } }, method: string) {
  return request.mock.calls.filter(([name]) => name === method).length;
}
function profileRequest(
  profile: () => UserProfile,
  overrides: Record<string, (params?: unknown) => unknown> = {},
) {
  return mockRpc({
    "users.prefs.get": () => ({ status: "ok", entries: {} }),
    "users.self": () => ({ profile: profile() }),
    "users.listModelAccounts": () => ({ profileId: profile().id, accounts: [], links: [] }),
    ...overrides,
  });
}
function stubProfileAvatarProcessing(decode = vi.fn<() => Promise<void>>(async () => undefined)) {
  class StubUrl extends URL {
    static override createObjectURL = vi.fn(() => "blob:avatar");
    static override revokeObjectURL = vi.fn();
  }
  class StubImage {
    decoding = "auto";
    src = "";
    naturalWidth = 512;
    naturalHeight = 256;
    decode = decode;
  }
  vi.stubGlobal("URL", StubUrl);
  vi.stubGlobal("Image", StubImage);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback, type) => {
    callback(new Blob([new Uint8Array([1, 2, 3])], { type: type ?? "image/png" }));
  });
}

function selectProfileAvatar(page: ParentNode) {
  const avatarInput = page.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(avatarInput, "files", {
    configurable: true,
    value: [new File(["avatar"], "avatar.png", { type: "image/png" })],
  });
  avatarInput.dispatchEvent(new Event("change", { bubbles: true }));
}

async function startProfileSignIn(page: ParentNode) {
  page.querySelector<HTMLButtonElement>(".profile-auth-add-account")!.click();
  await waitForFast(() =>
    expect(
      page.querySelector<HTMLButtonElement>(".profile-auth-provider .picker-select__trigger")
        ?.disabled,
    ).toBe(false),
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

beforeEach(() => i18n.setLocale("en"));

afterEach(async () => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await i18n.setLocale("en");
});

it("refreshes translated copy when the locale changes while mounted", async () => {
  const { context } = createConnectedContext(vi.fn() as GatewayBrowserClient["request"]);
  context.gateway.snapshot.phase = "stopped";
  context.gateway.snapshot.client = null;
  const page = mountProfilePage(context);
  flush();

  const note = page.querySelector(".settings-empty");
  const englishNote = note?.textContent?.trim();

  await i18n.setLocale("de");
  flush();

  expect(note?.textContent?.trim()).toBe(t("profilePage.offline"));
  expect(note?.textContent?.trim()).not.toBe(englishNote);
});

it("renders identity before Usage statistics and opens the usage page", async () => {
  const profile = modelAccountProfile;
  const request = profileRequest(() => profile);
  const harness = createConnectedContext(
    request as GatewayBrowserClient["request"],
    person(profile),
  );
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
  expect(docsLink).toMatchObject({ href: "https://docs.openclaw.ai/concepts/user-model" });
  expect(docsLink?.textContent?.trim()).toBe("Learn more");
  expect(page.querySelector(".profile-stats, .profile-heatmap")).toBeNull();
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
    method === "users.self" ? { profile: modelAccountProfile } : disconnectedGitHub,
  );
  const harness = createConnectedContext(request as GatewayBrowserClient["request"], person());
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
  expect(nameInput(page)?.disabled).toBe(true);
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
  const { page, ...harness } = mount(request as GatewayBrowserClient["request"]);

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
  const firstIdentity = createDeferred<never>();
  const request = mockRpc({
    "users.prefs.get": () => ({ status: "ok", entries: {} }),
    "users.self": () => (request.mock.calls.length === 1 ? firstIdentity.promise : { profile }),
  });
  const { page } = mount(request as GatewayBrowserClient["request"], person(profile));

  await waitForFast(() => expect(callCount(request, "users.self")).toBe(1));
  flush();
  const refresh = page.querySelector<HTMLButtonElement>(".profile-refresh")!;
  expect(refresh.disabled).toBe(true);
  expect(refresh.textContent?.trim()).toBe(t("common.refreshing"));

  refresh.click();
  refresh.click();
  flush();
  expect(callCount(request, "users.self")).toBe(1);

  firstIdentity.reject(new Error("identity unavailable: OPENAI_API_KEY=sk-1234567890abcdef"));
  await waitForFast(() => expect(refresh.disabled).toBe(false));
  expect(refresh.textContent?.trim()).toBe(t("common.refresh"));
  expect(page.textContent).toContain("identity unavailable: OPENAI_API_KEY=sk-123...cdef");
  expect(page.textContent).not.toContain("sk-1234567890abcdef");

  refresh.click();
  await waitForFast(() => expect(callCount(request, "users.self")).toBe(2));
  await waitForFast(() => expect(nameInput(page)?.value).toBe("Ada"));
});

it("replaces an in-flight identity request after a same-client reconnect", async () => {
  const staleProfile: UserProfile = {
    ...modelAccountProfile,
    displayName: "Stale identity",
  };
  const freshProfile = { ...staleProfile, displayName: "Fresh identity", updatedAt: 3 };
  const staleRequest = createDeferred<{ profile: UserProfile }>();
  const freshRequest = createDeferred<{ profile: UserProfile }>();
  const request = profileRequest(() => staleProfile, {
    "users.self": () =>
      callCount(request, "users.self") === 1 ? staleRequest.promise : freshRequest.promise,
  });
  const { page, ...harness } = mount(
    request as GatewayBrowserClient["request"],
    person(staleProfile),
  );

  const selfCalls = () => request.mock.calls.filter(([method]) => method === "users.self");
  await waitForFast(() => expect(selfCalls()).toHaveLength(1));
  harness.emitConnected(false);
  flush();
  harness.emitConnected(true);
  await waitForFast(() => expect(selfCalls()).toHaveLength(2));

  freshRequest.resolve({ profile: freshProfile });
  await waitForFast(() => expect(nameInput(page)?.value).toBe("Fresh identity"));
  staleRequest.resolve({ profile: staleProfile });
  await staleRequest.promise;
  await Promise.resolve();
  flush();

  expect(nameInput(page)?.value).toBe("Fresh identity");
  expect(selfCalls()).toHaveLength(2);
});

it.each([
  { stage: "preprocessing", outcome: "success" },
  { stage: "preprocessing", outcome: "failure" },
  { stage: "mutation", outcome: "success" },
  { stage: "mutation", outcome: "failure" },
])("retires avatar $stage $outcome without disturbing a newer save", async ({ stage, outcome }) => {
  let profile = { ...modelAccountProfile };
  const staleDecode = createDeferred();
  const staleMutation = createDeferred<{ profile: UserProfile; avatarRevision: string }>();
  const currentMutation = createDeferred<{ profile: UserProfile; avatarRevision: string }>();
  const decode = vi.fn<() => Promise<void>>(async () => undefined);
  if (stage === "preprocessing") {
    decode.mockImplementationOnce(() => staleDecode.promise);
  }
  stubProfileAvatarProcessing(decode);
  let avatarRequests = 0;
  const request = profileRequest(() => profile, {
    "users.setAvatar": () => {
      avatarRequests += 1;
      return stage === "mutation" && avatarRequests === 1
        ? staleMutation.promise
        : currentMutation.promise;
    },
  });
  const avatarBefore = "/api/users/profile-1/avatar?v=before";
  const { page, ...harness } = mount(request as GatewayBrowserClient["request"], {
    id: profile.id,
    name: profile.displayName ?? undefined,
    avatarUrl: avatarBefore,
  });
  const currentNameInput = () => nameInput(page);
  await waitForFast(() => expect(currentNameInput()?.disabled).toBe(false));
  selectProfileAvatar(page);
  await waitForFast(() =>
    expect(stage === "preprocessing" ? decode.mock.calls.length : avatarRequests).toBe(1),
  );

  harness.emitConnected(false);
  harness.emitConnected(true);
  await waitForFast(() => expect(currentNameInput()?.disabled).toBe(false));
  currentNameInput()!.value = "Current draft";
  currentNameInput()!.dispatchEvent(new Event("input", { bubbles: true }));
  selectProfileAvatar(page);
  const expectedAvatarRequests = stage === "preprocessing" ? 1 : 2;
  await waitForFast(() => expect(avatarRequests).toBe(expectedAvatarRequests));

  if (outcome === "failure") {
    (stage === "preprocessing" ? staleDecode : staleMutation).reject(new Error("Retired save"));
  } else if (stage === "preprocessing") {
    staleDecode.resolve();
  } else {
    staleMutation.resolve({
      profile: { ...profile, displayName: "Retired identity" },
      avatarRevision: "retired",
    });
  }
  // Settle the retired promise chain while the replacement RPC remains pending.
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
  flush();

  expect(avatarRequests).toBe(expectedAvatarRequests);
  expect(currentNameInput()).toMatchObject({ disabled: true, value: "Current draft" });
  expect(page.querySelector('[role="alert"]')).toBeNull();
  expect(harness.context.gateway.snapshot.selfUser?.avatarUrl).toBe(avatarBefore);
  expect(callCount(request, "users.self")).toBe(2);

  profile = { ...profile, hasAvatar: true, avatarMime: "image/png", updatedAt: 3 };
  currentMutation.resolve({ profile, avatarRevision: "current" });
  await waitForFast(() => expect(currentNameInput()?.disabled).toBe(false));
  expect(currentNameInput()?.value).toBe("Current draft");
  expect(harness.context.gateway.snapshot.selfUser?.avatarUrl).toContain("?v=current");
  expect(callCount(request, "users.self")).toBe(3);
});

it("bootstraps and refreshes the connected user's profile through users.self", async () => {
  let avatarRevision = "avatar-content-hash-png";
  let publishAvatarPresence: (() => void) | undefined;
  let profile: UserProfile = {
    ...modelAccountProfile,
    emails: ["ada@example.test", "ada@work.test"],
  };
  const request = profileRequest(() => profile, {
    "users.setDisplayName": (params) => {
      expect(params).toEqual({ profileId: "profile-1", displayName: "Augusta Ada" });
      profile = { ...profile, displayName: "Augusta Ada", updatedAt: 3 };
      return { profile };
    },
    "users.setAvatar": () => {
      profile = {
        ...profile,
        displayName: "Augusta Ada",
        avatarMime: "image/png",
        hasAvatar: true,
        updatedAt: 4,
      };
      publishAvatarPresence?.();
      return { profile, avatarRevision };
    },
  });
  const harness = createConnectedContext(request as GatewayBrowserClient["request"], person());
  publishAvatarPresence = () =>
    harness.context.gateway.updateSelfUser?.({
      avatarUrl: `/api/users/${profile.id}/avatar?v=${avatarRevision}`,
    });
  const page = mountProfilePage(harness.context);

  await waitForFast(() => expect(page.querySelector("#settings-profile-identity")).not.toBeNull());
  await waitForFast(() => expect(nameInput(page)?.value).toBe(profile.displayName));
  const viewer = viewerAvatar(page);
  expect(viewer?.user?.id).toBe(profile.id);
  expect(page.textContent).toContain("ada@example.test, ada@work.test");
  expect(request.mock.calls.some(([method]) => method === "users.list")).toBe(false);

  const input = page.querySelector<HTMLInputElement>('.identity-name-control input[type="text"]');
  await waitForFast(() => expect(input?.disabled).toBe(false));
  input!.value = "Augusta Ada";
  input!.dispatchEvent(new Event("input", { bubbles: true }));
  flush();
  page.querySelector<HTMLButtonElement>('.identity-name-control button[type="submit"]')?.click();

  await waitForFast(() =>
    expect(request.mock.calls.some(([method]) => method === "users.setDisplayName")).toBe(true),
  );
  await waitForFast(() => expect(callCount(request, "users.self")).toBe(2));
  flush();
  expect(nameInput(page)?.value).toBe("Augusta Ada");
  expect(harness.context.gateway.snapshot.selfUser?.name).toBe("Augusta Ada");

  const displayNameInput = nameInput(page)!;
  await waitForFast(() => expect(displayNameInput.disabled).toBe(false));
  displayNameInput.value = "Unsaved draft";
  displayNameInput.dispatchEvent(new Event("input", { bubbles: true }));
  flush();
  const accountContext = page.querySelector("openclaw-model-accounts");
  expect(accountContext?.textContent).toContain("Augusta Ada");
  expect(accountContext?.textContent).not.toContain("Unsaved draft");
  stubProfileAvatarProcessing();
  selectProfileAvatar(page);
  await waitForFast(() =>
    expect(request.mock.calls.some(([method]) => method === "users.setAvatar")).toBe(true),
  );
  await waitForFast(() => expect(callCount(request, "users.self")).toBe(3));
  flush();
  expect(harness.context.gateway.snapshot.selfUser?.avatarUrl).toContain(
    `/api/users/profile-1/avatar?v=${avatarRevision}`,
  );
  expect(viewerAvatar(page)?.user?.avatarUrl).toBe(
    `/api/users/profile-1/avatar?v=${avatarRevision}`,
  );
  expect(nameInput(page)?.value).toBe("Unsaved draft");

  const avatarRequestCount = callCount(request, "users.setAvatar");
  avatarRevision = "response-content-hash-png";
  publishAvatarPresence = undefined;
  await waitForFast(() => expect(displayNameInput.disabled).toBe(false));
  selectProfileAvatar(page);
  await waitForFast(() =>
    expect(callCount(request, "users.setAvatar")).toBe(avatarRequestCount + 1),
  );
  await waitForFast(() =>
    expect(harness.context.gateway.snapshot.selfUser?.avatarUrl).toContain(
      `/api/users/profile-1/avatar?v=${avatarRevision}`,
    ),
  );
  await waitForFast(() =>
    expect(viewerAvatar(page)?.user?.avatarUrl).toContain(
      `/api/users/profile-1/avatar?v=${avatarRevision}`,
    ),
  );

  await waitForFast(() => expect(displayNameInput.disabled).toBe(false));
  request.mockClear();
  page.querySelector<HTMLButtonElement>(".profile-refresh")?.click();
  await waitForFast(() =>
    expect(request.mock.calls.some(([method]) => method === "users.self")).toBe(true),
  );
  await waitForFast(() => expect(nameInput(page)?.disabled).toBe(false));
  expect(nameInput(page)?.value).toBe("Unsaved draft");
  const processing =
    createDeferred<Awaited<ReturnType<typeof avatarProcessing.processProfileAvatar>>>();
  vi.spyOn(avatarProcessing, "processProfileAvatar").mockReturnValue(processing.promise);
  selectProfileAvatar(page);
  flush();
  request.mockClear();
  page.querySelector<HTMLButtonElement>(".profile-refresh")?.click();
  flush();
  expect(request.mock.calls.some(([method]) => method === "users.self")).toBe(false);
  processing.resolve({ mime: "image/png", avatarBase64: "aA==" });
});

it("keeps model-account actions usable when identity refresh overlaps ChatGPT completion", async () => {
  const profile = { ...modelAccountProfile };
  let links: Array<{ provider: string; authProfileId: string; updatedAt: number }> = [];
  const completion = createDeferred();
  const request = profileRequest(() => profile, {
    "users.listModelAccounts": () => ({
      profileId: profile.id,
      accounts: links.map((link) => ({
        ...link,
        label: "Ada · Personal workspace",
        authType: "oauth",
        selected: true,
      })),
      links,
    }),
    "users.authConnect.start": (params) => {
      expect(params).toEqual({ profileId: "profile-1", provider: "openai", method: "browser" });
      return { connectId: "connect-1", expiresAtMs: Date.now() + 60_000 };
    },
    "users.authConnect.catalog": () => modelAccountCatalog,
    "users.authConnect.status": () => ({ status: "pending", step: modelAccountStep }),
    "users.authConnect.answer": async (params) => {
      expect(params).toEqual({
        profileId: "profile-1",
        connectId: "connect-1",
        stepId: "redirect",
        value: "http://localhost:1455/auth/callback?code=abc&state=s",
      });
      await completion.promise;
      links = [{ provider: "openai", authProfileId: "openai:ada", updatedAt: 5 }];
      return { status: "connected", authProfileId: "openai:ada", links };
    },
  });
  const { page } = mount(request as GatewayBrowserClient["request"], person());

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
  await waitForFast(() => expect(callCount(request, "users.self")).toBe(2));
  await waitForFast(() =>
    expect(page.querySelector<HTMLButtonElement>(".profile-refresh")?.disabled).toBe(false),
  );
  completion.resolve();
  await waitForFast(() => expect(page.textContent).toContain("Ada · Personal workspace"));
  expect(page.querySelector("#profile-account-auth-answer")).toBeNull();
  expect(page.querySelector<HTMLButtonElement>(".profile-auth-add-account")?.disabled).toBe(false);
  expect(page.querySelector<HTMLButtonElement>(".profile-auth-link-unlink")?.disabled).toBe(false);
});

it("rechecks avatar upload policy after processing and rerenders on config updates", async () => {
  const profile = { ...modelAccountProfile };
  const request = profileRequest(() => profile);
  const harness = createConnectedContext(request as GatewayBrowserClient["request"], {
    id: profile.id,
    name: "Ada",
  });
  const config = createApplicationConfigCapability({ resourceBasePath: "" });
  const page = mountProfilePage({ ...harness.context, config });
  await waitForFast(() =>
    expect(page.querySelector<HTMLInputElement>('input[type="file"]')?.disabled).toBe(false),
  );
  const processed =
    createDeferred<Awaited<ReturnType<typeof avatarProcessing.processProfileAvatar>>>();
  const process = vi
    .spyOn(avatarProcessing, "processProfileAvatar")
    .mockReturnValue(processed.promise);
  selectProfileAvatar(page);
  expect(process).toHaveBeenCalledOnce();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ uploadsEnabled: false }))),
  );
  await config.refresh();
  await waitForFast(() => expect(page.querySelector('input[type="file"]')).toBeNull());
  processed.resolve({ mime: "image/png", avatarBase64: "aA==" });
  await waitForFast(() =>
    expect(page.querySelector(".identity-error")?.textContent).toContain(uploadsDisabledMessage()),
  );
  expect(request.mock.calls.some(([method]) => method === "users.setAvatar")).toBe(false);
  expect(page.querySelector('input[type="file"]')).toBeNull();
  expect(process).toHaveBeenCalledOnce();
  expect(nameInput(page)?.disabled).toBe(false);
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
  expect(nameInput(page)?.value).toBe(modelAccountProfile.displayName);
});

it.each([
  [["operator.read"], "You have permission to view server information."],
  [["operator.write"], "You have permission to send messages and make changes."],
  [["operator.sessions.read"], "You have permission to view your own sessions."],
  [["operator.admin"], "You have permission to manage this server."],
  [["operator.approvals"], "This connection has a limited set of permissions."],
  [
    ["operator.read", "operator.sessions.write"],
    "You have permission to work in your own sessions.",
  ],
] as const)("explains %j with diagnostics collapsed", async (scopes, summary) => {
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
  const { page, ...harness } = mount(vi.fn(async () => ({})) as GatewayBrowserClient["request"]);
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
    const request = profileRequest(() => profile, {
      "users.prefs.get": (params) => {
        expect(params).toEqual({ keys: [GIT_COAUTHOR_PREFERENCE_KEY] });
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
    const { page } = mount(request as GatewayBrowserClient["request"], {
      id: profile.id,
      name: profile.displayName ?? undefined,
    });
    await waitForFast(() =>
      expect(page.querySelector("input.settings-toggle__input")).not.toBeNull(),
    );
    expect(Boolean(page.querySelector(".settings-account"))).toBe(primary);
    const toggle = page.querySelector<HTMLInputElement>("input.settings-toggle__input");
    await waitForFast(() => {
      expect(toggle).toMatchObject({ disabled: false, checked: enabled });
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
    await waitForFast(() => expect(callCount(request, "users.prefs.set")).toBe(1));
    await waitForFast(() => expect(toggle?.checked).toBe(updated));
    expect(request.mock.calls.map(([method]) => method).toSorted()).toEqual(
      ["users.self", "users.listModelAccounts", "users.prefs.get", "users.prefs.set"].toSorted(),
    );
  },
);
