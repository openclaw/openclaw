/* @vitest-environment jsdom */

import type { UserProfile } from "@openclaw/gateway-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import * as uuid from "../../lib/uuid.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { button, createContext, element, fill, mountPage } from "./custodian-page.test-harness.ts";

function profile(displayName: string | null): UserProfile {
  return {
    id: "profile-1",
    displayName,
    avatarMime: null,
    mergedInto: null,
    createdAt: 1,
    updatedAt: 1,
    emails: [],
    githubIdentity: null,
    hasAvatar: false,
  };
}

function pageRequest(onDisplayName?: () => Promise<unknown>) {
  return vi.fn(async (method: string, _params?: unknown): Promise<unknown> => {
    if (method === "openclaw.chat.history") {
      return { turns: [] };
    }
    if (method === "openclaw.chat") {
      return { sessionId: "custodian-session", reply: "Ready.", action: "none" };
    }
    if (method === "users.setDisplayName" && onDisplayName) {
      return onDisplayName();
    }
    throw new Error(`unexpected request ${method}`);
  });
}

describe("custodian onboarding name", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.spyOn(uuid, "generateUUID").mockReturnValue("00000000-0000-4000-8000-000000000001");
    window.history.replaceState({}, "", "/");
  });

  afterEach(() => {
    localStorage.clear();
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("saves a nonblank onboarding name and uses the returned profile after a server no-op", async () => {
    let writes = 0;
    const alreadyNamed = profile("Saved on another device");
    const request = pageRequest(async () => {
      writes += 1;
      if (writes === 1) {
        throw new Error("write refused");
      }
      return { profile: alreadyNamed };
    });
    const { context } = createContext(request);
    context.gateway.loadSelfProfile = vi.fn().mockResolvedValue(profile(null));
    const { page } = await mountPage(context);
    await element<HTMLInputElement>(page, "#custodian-onboarding-display-name");
    const save = button(page, ".custodian__name-actions button[type='submit']");

    save.click();
    expect(save.disabled).toBe(true);
    await fill(page, "#custodian-onboarding-display-name", "   ");
    expect(button(page, ".custodian__name-actions button[type='submit']").disabled).toBe(true);

    await fill(page, "#custodian-onboarding-display-name", "  Vítor  ");
    button(page, ".custodian__name-actions button[type='submit']").click();
    await waitForFast(() => expect(page.querySelector('[role="alert"]')).not.toBeNull());
    expect(page.querySelector("#custodian-onboarding-display-name")).toHaveProperty(
      "value",
      "  Vítor  ",
    );

    button(page, ".custodian__name-actions button[type='submit']").click();
    await waitForFast(() => expect(page.querySelector(".custodian__name-prompt")).toBeNull());
    expect(
      page.querySelector(".custodian--page")?.classList.contains("custodian--onboarding"),
    ).toBe(false);

    const nameWrites = request.mock.calls.filter(([method]) => method === "users.setDisplayName");
    expect(nameWrites).toHaveLength(2);
    expect(nameWrites[0]?.[1]).toEqual({
      profileId: "profile-1",
      displayName: "Vítor",
      onlyIfUnset: true,
    });
    expect(context.gateway.updateSelfUser).toHaveBeenCalledExactlyOnceWith({
      name: "Saved on another device",
    });
  });

  it("preserves a newer same-profile name when the onboarding save settles", async () => {
    const pendingWrite = createDeferred<{ profile: UserProfile }>();
    const request = pageRequest(() => pendingWrite.promise);
    const harness = createContext(request);
    harness.setGatewaySnapshot({
      selfUser: {
        id: "profile-1",
        identity: { type: "profile", id: "profile-1" },
      },
    });
    harness.context.gateway.loadSelfProfile = vi
      .fn()
      .mockResolvedValueOnce(profile(null))
      .mockResolvedValueOnce(profile("Later name"));
    const { page } = await mountPage(harness.context);
    await fill(page, "#custodian-onboarding-display-name", "First name");
    button(page, ".custodian__name-actions button[type='submit']").click();
    await waitForFast(() =>
      expect(request.mock.calls.some(([method]) => method === "users.setDisplayName")).toBe(true),
    );

    harness.setGatewaySnapshot({
      selfUser: {
        id: "profile-1",
        identity: { type: "profile", id: "profile-1" },
        name: "Later name",
      },
    });
    await page.updateComplete;

    pendingWrite.resolve({ profile: profile("First name") });
    await waitForFast(() => expect(page.querySelector(".custodian__name-prompt")).toBeNull());

    expect(harness.context.gateway.snapshot.selfUser).toMatchObject({
      id: "profile-1",
      name: "Later name",
    });
    expect(harness.context.gateway.updateSelfUser).not.toHaveBeenCalled();
  });

  it.each([
    ["owner", undefined],
    ["profile-1", "Person profile-"],
    ["profile-1", "verified-login"],
  ] as const)("preserves a newer clear for %s with display %s", async (profileId, clearedName) => {
    const currentProfile = (displayName: string | null) => ({
      ...profile(displayName),
      id: profileId,
    });
    const pendingWrite = createDeferred<{ profile: UserProfile }>();
    const request = pageRequest(() => pendingWrite.promise);
    const harness = createContext(request);
    harness.setGatewaySnapshot({
      selfUser: {
        id: profileId,
        identity: { type: "profile", id: profileId },
        name: clearedName,
      },
    });
    harness.context.gateway.loadSelfProfile = vi.fn().mockResolvedValue(currentProfile(null));
    const { page } = await mountPage(harness.context);
    await fill(page, "#custodian-onboarding-display-name", "First name");
    button(page, ".custodian__name-actions button[type='submit']").click();
    await waitForFast(() =>
      expect(request.mock.calls.some(([method]) => method === "users.setDisplayName")).toBe(true),
    );

    harness.setGatewaySnapshot({
      selfUser: {
        id: profileId,
        identity: { type: "profile", id: profileId },
        name: "First name",
      },
    });
    await page.updateComplete;
    expect(harness.context.gateway.snapshot.selfUser?.name).toBe("First name");
    harness.setGatewaySnapshot({
      selfUser: {
        id: profileId,
        identity: { type: "profile", id: profileId },
        name: clearedName,
      },
    });
    await page.updateComplete;

    pendingWrite.resolve({ profile: currentProfile("First name") });
    await waitForFast(() =>
      expect(page.querySelector(".custodian__name-form")?.getAttribute("aria-busy")).toBe("false"),
    );

    expect(harness.context.gateway.snapshot.selfUser).toMatchObject({ id: profileId });
    expect(harness.context.gateway.snapshot.selfUser?.name).toBe(clearedName);
    expect(page.querySelector<HTMLInputElement>("#custodian-onboarding-display-name")?.value).toBe(
      "",
    );
    expect(harness.context.gateway.updateSelfUser).not.toHaveBeenCalled();
  });

  it("keeps Skip local to this page visit and never writes the name", async () => {
    const request = pageRequest();
    const { context } = createContext(request);
    context.gateway.loadSelfProfile = vi.fn().mockResolvedValue(profile(null));
    const firstVisit = await mountPage(context);
    await element<HTMLInputElement>(firstVisit.page, "#custodian-onboarding-display-name");

    button(firstVisit.page, ".custodian__name-actions button[type='button']").click();
    await waitForFast(() =>
      expect(firstVisit.page.querySelector(".custodian__name-prompt")).toBeNull(),
    );
    expect(
      firstVisit.page
        .querySelector(".custodian--page")
        ?.classList.contains("custodian--onboarding"),
    ).toBe(false);
    expect(request.mock.calls.some(([method]) => method === "users.setDisplayName")).toBe(false);
    expect(context.gateway.updateSelfUser).not.toHaveBeenCalled();

    firstVisit.provider.remove();
    const nextVisit = await mountPage(context);
    await element<HTMLInputElement>(nextVisit.page, "#custodian-onboarding-display-name");
  });

  it.each(["named", "disconnected", "read-only", "load-error"] as const)(
    "offers the optional name prompt only for a writable unnamed profile (%s)",
    async (scenario) => {
      const request = pageRequest();
      const harness = createContext(request);
      const loadSelfProfile = vi.fn();
      if (scenario === "named") {
        loadSelfProfile.mockResolvedValue(profile("Ada"));
      } else if (scenario === "load-error") {
        loadSelfProfile
          .mockRejectedValueOnce(new Error("profile unavailable"))
          .mockResolvedValueOnce(profile(null));
      } else {
        loadSelfProfile.mockResolvedValue(profile(null));
      }
      harness.context.gateway.loadSelfProfile = loadSelfProfile;
      if (scenario === "disconnected") {
        harness.setGatewaySnapshot({ phase: "offline", client: null });
      } else if (scenario === "read-only") {
        const hello = harness.context.gateway.snapshot.hello;
        if (!hello) {
          throw new Error("test setup requires a connected Gateway hello");
        }
        harness.setGatewaySnapshot({
          hello: { ...hello, auth: { role: "operator", scopes: ["operator.read"] } },
        });
      }
      const { page } = await mountPage(harness.context);

      if (scenario === "load-error") {
        await waitForFast(() => expect(page.querySelector('[role="alert"]')).not.toBeNull());
        button(page, ".custodian__name-prompt button").click();
        await element<HTMLInputElement>(page, "#custodian-onboarding-display-name");
        expect(loadSelfProfile).toHaveBeenCalledTimes(2);
        return;
      }
      if (scenario === "named") {
        await waitForFast(() => expect(loadSelfProfile).toHaveBeenCalledOnce());
      }
      await page.updateComplete;
      expect(page.querySelector(".custodian__name-prompt")).toBeNull();
      expect(
        page.querySelector(".custodian--page")?.classList.contains("custodian--onboarding"),
      ).toBe(false);
      expect(loadSelfProfile).toHaveBeenCalledTimes(scenario === "named" ? 1 : 0);
    },
  );

  it.each(["write", "refresh"] as const)(
    "ignores a pending %s when its Gateway connection is replaced",
    async (phase) => {
      const pendingWrite = createDeferred<{ profile: UserProfile }>();
      const pendingRefresh = createDeferred<UserProfile>();
      const request = pageRequest(async () => pendingWrite.promise);
      const harness = createContext(request);
      harness.setGatewaySnapshot({
        selfUser: { id: "profile-1", identity: { type: "profile", id: "profile-1" } },
      });
      const loadSelfProfile = vi.fn().mockResolvedValueOnce(profile(null));
      if (phase === "refresh") {
        loadSelfProfile.mockReturnValueOnce(pendingRefresh.promise);
      }
      loadSelfProfile.mockResolvedValueOnce(null);
      harness.context.gateway.loadSelfProfile = loadSelfProfile;
      const { page } = await mountPage(harness.context);
      await element<HTMLInputElement>(page, "#custodian-onboarding-display-name");
      await fill(page, "#custodian-onboarding-display-name", "Ada");
      button(page, ".custodian__name-actions button[type='submit']").click();
      await waitForFast(() =>
        expect(request.mock.calls.some(([method]) => method === "users.setDisplayName")).toBe(true),
      );

      if (phase === "refresh") {
        harness.setGatewaySnapshot({
          selfUser: {
            id: "profile-1",
            identity: { type: "profile", id: "profile-1" },
            name: "Later name",
          },
        });
        pendingWrite.resolve({ profile: profile("Ada") });
        await waitForFast(() => expect(loadSelfProfile).toHaveBeenCalledTimes(2));
      }

      const replacementClient = { request: vi.fn(async () => ({ turns: [] })) };
      harness.setGatewaySnapshot({
        client: replacementClient as unknown as GatewayBrowserClient,
      });
      await waitForFast(() =>
        expect(loadSelfProfile).toHaveBeenCalledTimes(phase === "refresh" ? 3 : 2),
      );
      pendingRefresh.resolve(profile("Later name"));
      pendingWrite.resolve({ profile: profile("Ada") });
      await pendingWrite.promise;
      await page.updateComplete;

      expect(harness.context.gateway.updateSelfUser).not.toHaveBeenCalled();
      expect(page.querySelector(".custodian__name-prompt")).toBeNull();
    },
  );
});
