/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { UserProfile } from "../../../../packages/gateway-protocol/src/index.ts";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createApplicationConfigCapability } from "../../app/config.ts";
import "../../app/user-prefs-request.ts";
import type { AuthenticatedUser } from "../../app/user-profile.ts";
import { i18n } from "../../i18n/index.ts";
import { setAvatarGatewayOrigin } from "../../lib/identity-avatar-context.ts";
import { uploadsDisabledMessage } from "../../lib/uploads.ts";
import { flush, waitForSolid as waitForFast } from "../../test-helpers/solid-settle.ts";
import * as avatarProcessing from "./avatar-processing.ts";
import {
  createConnectedContext,
  modelAccountProfile,
  mountProfilePage,
} from "./profile-page.test-support.tsx";

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

beforeEach(async () => {
  setAvatarGatewayOrigin(null);
  await i18n.setLocale("en");
});

afterEach(async () => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  setAvatarGatewayOrigin(null);
  await i18n.setLocale("en");
});

it("falls back to the text avatar when the hero image fails to load", async () => {
  const request = vi.fn();
  const harness = createConnectedContext(request as GatewayBrowserClient["request"]);
  const agentsState = harness.context.agents.state as unknown as {
    agentsList: {
      defaultId: string;
      agents: Array<{
        id: string;
        identity: { name: string; emoji: string; avatarUrl: string };
      }>;
    };
  };
  agentsState.agentsList = {
    defaultId: "main",
    agents: [
      {
        id: "main",
        identity: {
          name: "Molty",
          emoji: "🦞",
          avatarUrl: "data:image/png;base64,unloadable",
        },
      },
    ],
  };
  const page = mountProfilePage(harness.context);

  flush();
  const avatar = page.querySelector(".profile-hero__avatar .identity-avatar--agent")!;
  const image = avatar.querySelector("img");
  expect(image?.getAttribute("src")).toBe("data:image/png;base64,unloadable");
  expect(avatar.classList).toContain("is-pending");

  image?.dispatchEvent(new Event("error"));
  await waitForFast(() => expect(avatar.classList).toContain("is-fallback"));

  expect(avatar.querySelector(".identity-avatar__image")).toBe(image);
  expect(avatar.getAttribute("data-avatar-state")).toBe("failed");
  expect(avatar.classList).toContain("is-fallback");
  expect(avatar.classList).not.toContain("is-pending");
  expect(avatar.querySelector(".identity-avatar__text")?.getAttribute("data-avatar")).toBe("🦞");
});

it("fetches a protected hero avatar with the current Control UI credential", async () => {
  const createObjectURL = vi.fn(() => "blob:hero-avatar");
  const revokeObjectURL = vi.fn();
  vi.stubGlobal(
    "URL",
    class extends URL {
      static override createObjectURL = createObjectURL;
      static override revokeObjectURL = revokeObjectURL;
    },
  );
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    blob: async () => new Blob(["avatar"], { type: "image/svg+xml" }),
  });
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
  const harness = createConnectedContext(vi.fn() as GatewayBrowserClient["request"]);
  harness.context.gateway.connection.token = "profile-token";
  setAvatarGatewayOrigin(harness.context.gateway.connection.gatewayUrl, ["profile-token"]);
  const agentsState = harness.context.agents.state as unknown as {
    agentsList: {
      defaultId: string;
      agents: Array<{
        id: string;
        identity: { name: string; emoji: string; avatarUrl: string };
      }>;
    };
  };
  agentsState.agentsList = {
    defaultId: "main",
    agents: [
      {
        id: "main",
        identity: { name: "Molty", emoji: "🦞", avatarUrl: "/avatar/main" },
      },
    ],
  };
  const page = mountProfilePage(harness.context);

  await waitForFast(() => {
    expect(fetchMock).toHaveBeenCalledWith(new URL("/avatar/main", window.location.origin).href, {
      credentials: "include",
      headers: { Authorization: "Bearer profile-token" },
      signal: expect.any(AbortSignal),
    });
    expect(
      page
        .querySelector<HTMLImageElement>(".profile-hero__avatar .identity-avatar__image")
        ?.getAttribute("src"),
    ).toBe("blob:hero-avatar");
  });

  page.unmount();
  setAvatarGatewayOrigin(null);
  expect(revokeObjectURL).toHaveBeenCalledWith("blob:hero-avatar");
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
    if (method === "users.setAvatar") {
      avatarRequests += 1;
      return stage === "mutation" && avatarRequests === 1
        ? staleMutation.promise
        : currentMutation.promise;
    }
    throw new Error(`unexpected method: ${method}`);
  });
  const avatarBefore = "/api/users/profile-1/avatar?v=before";
  const harness = createConnectedContext(request as GatewayBrowserClient["request"], {
    id: profile.id,
    name: profile.displayName ?? undefined,
    avatarUrl: avatarBefore,
  });
  const page = mountProfilePage(harness.context);
  const nameInput = () => page.querySelector<HTMLInputElement>(".identity-name-control input");
  await waitForFast(() => expect(nameInput()?.disabled).toBe(false));
  selectProfileAvatar(page);
  await waitForFast(() =>
    expect(stage === "preprocessing" ? decode.mock.calls.length : avatarRequests).toBe(1),
  );

  harness.emitConnected(false);
  harness.emitConnected(true);
  await waitForFast(() => expect(nameInput()?.disabled).toBe(false));
  nameInput()!.value = "Current draft";
  nameInput()!.dispatchEvent(new Event("input", { bubbles: true }));
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
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
  flush();

  expect(avatarRequests).toBe(expectedAvatarRequests);
  expect(nameInput()?.disabled).toBe(true);
  expect(nameInput()?.value).toBe("Current draft");
  expect(page.querySelector('[role="alert"]')).toBeNull();
  expect(harness.context.gateway.snapshot.selfUser?.avatarUrl).toBe(avatarBefore);
  expect(request.mock.calls.filter(([method]) => method === "users.self")).toHaveLength(2);

  profile = { ...profile, hasAvatar: true, avatarMime: "image/png", updatedAt: 3 };
  currentMutation.resolve({ profile, avatarRevision: "current" });
  await waitForFast(() => expect(nameInput()?.disabled).toBe(false));
  expect(nameInput()?.value).toBe("Current draft");
  expect(harness.context.gateway.snapshot.selfUser?.avatarUrl).toContain("?v=current");
  expect(request.mock.calls.filter(([method]) => method === "users.self")).toHaveLength(3);
});

it("bootstraps and refreshes the connected user's profile through users.self", async () => {
  let avatarRevision = "avatar-content-hash-png";
  let publishAvatarPresence: (() => void) | undefined;
  let profile: UserProfile = {
    ...modelAccountProfile,
    emails: ["ada@example.test", "ada@work.test"],
  };
  const request = vi.fn(async (method: string, params?: unknown) => {
    if (method === "users.prefs.get") {
      return { status: "ok", entries: {} };
    }
    if (method === "users.self") {
      return { profile };
    }
    if (method === "users.listModelAccounts") {
      return { profileId: "profile-1", accounts: [], links: [] };
    }
    if (method === "users.setDisplayName") {
      expect(params).toEqual({ profileId: "profile-1", displayName: "Augusta Ada" });
      profile = { ...profile, displayName: "Augusta Ada", updatedAt: 3 };
      return { profile };
    }
    if (method === "users.setAvatar") {
      profile = {
        ...profile,
        displayName: "Augusta Ada",
        avatarMime: "image/png",
        hasAvatar: true,
        updatedAt: 4,
      };
      publishAvatarPresence?.();
      return { profile, avatarRevision };
    }
    throw new Error(`unexpected method: ${method}`);
  });
  const harness = createConnectedContext(request as GatewayBrowserClient["request"], {
    id: "profile-1",
    email: "ada@example.test",
    name: "Ada",
  });
  publishAvatarPresence = () =>
    harness.context.gateway.updateSelfUser?.({
      avatarUrl: `/api/users/${profile.id}/avatar?v=${avatarRevision}`,
    });
  const page = mountProfilePage(harness.context);

  await waitForFast(() => expect(page.querySelector("#settings-profile-identity")).not.toBeNull());
  await waitForFast(() =>
    expect(page.querySelector<HTMLInputElement>(".identity-name-control input")?.value).toBe(
      profile.displayName,
    ),
  );
  const viewer = page.querySelector<HTMLElement & { user?: AuthenticatedUser }>(
    "openclaw-viewer-avatar",
  );
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
  await waitForFast(() =>
    expect(request.mock.calls.filter(([method]) => method === "users.self")).toHaveLength(2),
  );
  flush();
  expect(page.querySelector<HTMLInputElement>(".identity-name-control input")?.value).toBe(
    "Augusta Ada",
  );
  expect(harness.context.gateway.snapshot.selfUser?.name).toBe("Augusta Ada");

  const displayNameInput = page.querySelector<HTMLInputElement>(".identity-name-control input")!;
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
  await waitForFast(() =>
    expect(request.mock.calls.filter(([method]) => method === "users.self")).toHaveLength(3),
  );
  flush();
  expect(harness.context.gateway.snapshot.selfUser?.avatarUrl).toContain(
    `/api/users/profile-1/avatar?v=${avatarRevision}`,
  );
  expect(
    (
      page.querySelector("openclaw-viewer-avatar") as
        | (HTMLElement & { user?: AuthenticatedUser })
        | null
    )?.user?.avatarUrl,
  ).toBe(`/api/users/profile-1/avatar?v=${avatarRevision}`);
  expect(page.querySelector<HTMLInputElement>(".identity-name-control input")?.value).toBe(
    "Unsaved draft",
  );

  const avatarRequestCount = request.mock.calls.filter(
    ([method]) => method === "users.setAvatar",
  ).length;
  avatarRevision = "response-content-hash-png";
  publishAvatarPresence = undefined;
  await waitForFast(() => expect(displayNameInput.disabled).toBe(false));
  selectProfileAvatar(page);
  await waitForFast(() =>
    expect(request.mock.calls.filter(([method]) => method === "users.setAvatar")).toHaveLength(
      avatarRequestCount + 1,
    ),
  );
  await waitForFast(() =>
    expect(harness.context.gateway.snapshot.selfUser?.avatarUrl).toContain(
      `/api/users/profile-1/avatar?v=${avatarRevision}`,
    ),
  );
  await waitForFast(() =>
    expect(
      (
        page.querySelector("openclaw-viewer-avatar") as
          | (HTMLElement & { user?: AuthenticatedUser })
          | null
      )?.user?.avatarUrl,
    ).toContain(`/api/users/profile-1/avatar?v=${avatarRevision}`),
  );

  await waitForFast(() => expect(displayNameInput.disabled).toBe(false));
  request.mockClear();
  page.querySelector<HTMLButtonElement>(".profile-refresh")?.click();
  await waitForFast(() =>
    expect(request.mock.calls.some(([method]) => method === "users.self")).toBe(true),
  );
  await waitForFast(() =>
    expect(page.querySelector<HTMLInputElement>(".identity-name-control input")?.disabled).toBe(
      false,
    ),
  );
  expect(page.querySelector<HTMLInputElement>(".identity-name-control input")?.value).toBe(
    "Unsaved draft",
  );
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

it("rechecks avatar upload policy after processing and rerenders on config updates", async () => {
  const profile = { ...modelAccountProfile };
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
  expect(page.querySelector(".identity-error")?.textContent).toContain(uploadsDisabledMessage());
  expect(page.querySelector('input[type="file"]')).toBeNull();
  expect(process).toHaveBeenCalledOnce();
  expect(page.querySelector<HTMLInputElement>(".identity-name-control input")?.disabled).toBe(
    false,
  );
});
