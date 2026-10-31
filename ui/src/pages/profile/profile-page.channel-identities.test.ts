/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { UserProfile } from "../../../../packages/gateway-protocol/src/index.ts";
import { GATEWAY_OWNER_PROFILE_ID } from "../../../../packages/gateway-protocol/src/schema/user-profile-constants.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { i18n } from "../../i18n/index.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { cleanupSolid } from "../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  channelIdentityMethods,
  createChannelIdentityHarness,
} from "./profile-page.channel-identities.test-support.ts";
import { modelAccountProfile, mountProfilePage } from "./profile-page.test-support.tsx";

beforeEach(async () => {
  await i18n.setLocale("en");
});

afterEach(async () => {
  cleanupSolid();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await i18n.setLocale("en");
});

it.each(["removed", "already absent", "ownership rejected"])(
  "lists and links exact bindings across profile refresh, then handles unlink %s",
  async (outcome) => {
    const original = {
      profileId: modelAccountProfile.id,
      identity: { channelId: "telegram", accountId: "main", senderId: "12345" },
    };
    let emitProfileIdentityChange = () => {};
    let links = [original];
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "users.self") {
        return { profile: modelAccountProfile };
      }
      if (method === "users.listModelAccounts") {
        return { profileId: modelAccountProfile.id, accounts: [], links: [] };
      }
      if (method === "users.prefs.get") {
        return { status: "no_durable_identity" };
      }
      if (method === "users.listChannelIdentities") {
        expect(params).toEqual({ profileId: modelAccountProfile.id });
        return { links };
      }
      if (method === "users.linkChannelIdentity") {
        const linked = params as typeof original;
        links = [...links, linked];
        emitProfileIdentityChange();
        return linked;
      }
      if (method === "users.unlinkChannelIdentity") {
        if (outcome === "ownership rejected") {
          throw new Error("That channel identity is already linked to another profile.");
        }
        const unlinked = params as typeof original;
        links = links.filter(
          (link) =>
            link.profileId !== unlinked.profileId ||
            !(
              link.identity.channelId === unlinked.identity.channelId &&
              link.identity.accountId === unlinked.identity.accountId &&
              link.identity.senderId === unlinked.identity.senderId
            ),
        );
        if (outcome === "removed") {
          emitProfileIdentityChange();
        }
        return { removed: outcome === "removed" };
      }
      throw new Error("unexpected method: " + method);
    });
    const harness = createChannelIdentityHarness(request as GatewayBrowserClient["request"]);
    const eventListeners = new Set<Parameters<typeof harness.context.gateway.subscribeEvents>[0]>();
    harness.context.gateway.subscribeEvents = (listener) => {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    };
    emitProfileIdentityChange = () => {
      for (const listener of eventListeners) {
        listener({
          type: "event",
          event: "sessions.changed",
          payload: { reason: "profile-identity" },
        });
      }
    };
    const page = mountProfilePage(harness.context);
    await waitForFast(() =>
      expect(page.querySelector("#settings-profile-channel-identities")?.textContent).toContain(
        "12345",
      ),
    );

    expect(request).toHaveBeenCalledWith("users.listChannelIdentities", {
      profileId: modelAccountProfile.id,
    });
    const section = page.querySelector<HTMLElement>("#settings-profile-channel-identities")!;
    expect(
      page.querySelector<HTMLElement>("openclaw-profile-channel-identities")?.style.display,
    ).toBe("contents");
    expect(section.textContent).toContain("telegram");
    expect(section.textContent).toContain("Configured account ID:");
    expect(section.textContent).toContain("main");
    expect(section.textContent).toContain("Native sender ID:");
    expect(section.querySelectorAll("input[aria-label]")).toHaveLength(3);

    const entered = {
      channelId: "discord",
      accountId: "workspace-2",
      senderId: "user-7",
    };
    const submit = section.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    await waitForFast(() => expect(submit.disabled).toBe(false));
    for (const [label, value] of [
      ["Channel ID", entered.channelId],
      ["Configured account ID", entered.accountId],
      ["Native sender ID", entered.senderId],
    ] as const) {
      const input = section.querySelector<HTMLInputElement>('input[aria-label="' + label + '"]')!;
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    submit.click();
    await waitForFast(() =>
      expect(section.querySelector('[role="status"]')?.textContent).toContain(
        "Channel account link added.",
      ),
    );
    expect(request).toHaveBeenCalledWith("users.linkChannelIdentity", {
      profileId: modelAccountProfile.id,
      identity: entered,
    });
    expect(section.textContent).toContain("user-7");
    expect(section.querySelector<HTMLInputElement>('input[aria-label="Channel ID"]')?.value).toBe(
      "",
    );

    const removeOriginal = section.querySelector<HTMLButtonElement>(
      'button[aria-label^="Remove link telegram"]',
    )!;
    await waitForFast(() => expect(removeOriginal.disabled).toBe(false));
    removeOriginal.click();
    if (outcome === "ownership rejected") {
      await waitForFast(() =>
        expect(section.querySelector('[role="alert"]')?.textContent).toContain(
          "already linked to another profile",
        ),
      );
      expect(request).toHaveBeenCalledWith("users.unlinkChannelIdentity", original);
      expect(section.textContent).toContain("12345");
      expect(section.textContent).toContain("user-7");
      expect(section.querySelector('[role="status"]')).toBeNull();
      return;
    }
    await waitForFast(() =>
      expect(section.querySelector('[role="status"]')?.textContent).toContain(
        "Channel account link removed.",
      ),
    );
    expect(request).toHaveBeenCalledWith("users.unlinkChannelIdentity", original);
    expect(section.textContent).not.toContain("12345");
    expect(section.textContent).toContain("user-7");
  },
);

it("keeps exact identity input visible when the server rejects a colliding link", async () => {
  const request = vi.fn(async (method: string) => {
    if (method === "users.self") {
      return { profile: modelAccountProfile };
    }
    if (method === "users.listModelAccounts") {
      return { profileId: modelAccountProfile.id, accounts: [], links: [] };
    }
    if (method === "users.listChannelIdentities") {
      return { links: [] };
    }
    if (method === "users.linkChannelIdentity") {
      throw new Error("That channel identity is already linked to another profile.");
    }
    throw new Error("unexpected method: " + method);
  });
  const harness = createChannelIdentityHarness(request as GatewayBrowserClient["request"]);
  const page = mountProfilePage(harness.context);
  await waitForFast(() =>
    expect(page.querySelector("#settings-profile-channel-identities input")).not.toBeNull(),
  );
  const section = page.querySelector<HTMLElement>("#settings-profile-channel-identities")!;
  const entered = [
    ["Channel ID", "matrix"],
    ["Configured account ID", "primary"],
    ["Native sender ID", "@ada:example.test"],
  ] as const;
  for (const [label, value] of entered) {
    const input = section.querySelector<HTMLInputElement>('input[aria-label="' + label + '"]')!;
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }
  section.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
  await waitForFast(() => expect(section.querySelector('[role="alert"]')).not.toBeNull());

  expect(section.querySelector('[role="alert"]')?.textContent).toContain(
    "already linked to another profile",
  );
  for (const [label, value] of entered) {
    expect(
      section.querySelector<HTMLInputElement>('input[aria-label="' + label + '"]')?.value,
    ).toBe(value);
  }
  expect(section.querySelector('[role="status"]')).toBeNull();
});

it("offers an accessible retry after a failed list and renders the empty state", async () => {
  let listCalls = 0;
  const request = vi.fn(async (method: string) => {
    if (method === "users.self") {
      return { profile: modelAccountProfile };
    }
    if (method === "users.listModelAccounts") {
      return { profileId: modelAccountProfile.id, accounts: [], links: [] };
    }
    if (method === "users.listChannelIdentities") {
      listCalls += 1;
      if (listCalls === 1) {
        throw new Error("temporary identity service failure");
      }
      return { links: [] };
    }
    throw new Error("unexpected method: " + method);
  });
  const harness = createChannelIdentityHarness(request as GatewayBrowserClient["request"]);
  const page = mountProfilePage(harness.context);
  await waitForFast(() =>
    expect(
      page.querySelector('#settings-profile-channel-identities [role="alert"]'),
    ).not.toBeNull(),
  );
  const retry = page.querySelector<HTMLButtonElement>(
    '#settings-profile-channel-identities button[aria-label="Retry"]',
  );
  expect(retry?.textContent).toContain("Retry");
  retry!.click();
  await waitForFast(() =>
    expect(
      page.querySelector("#settings-profile-channel-identities .settings-empty")?.textContent,
    ).toContain("No channel accounts are linked"),
  );
  expect(listCalls).toBe(2);
  expect(page.querySelector('#settings-profile-channel-identities [role="alert"]')).toBeNull();
});

it("renders first-link and last-unlink transitions with single-flight mutation admission", async () => {
  const pendingLink = createDeferred<{
    profileId: string;
    identity: { channelId: string; accountId: string; senderId: string };
  }>();
  const identity = { channelId: "telegram", accountId: "main", senderId: "same-turn" };
  let links: Array<{ profileId: string; identity: typeof identity }> = [];
  const request = vi.fn(async (method: string, params?: unknown) => {
    if (method === "users.self") {
      return { profile: modelAccountProfile };
    }
    if (method === "users.listModelAccounts") {
      return { profileId: modelAccountProfile.id, accounts: [], links: [] };
    }
    if (method === "users.listChannelIdentities") {
      return { links };
    }
    if (method === "users.linkChannelIdentity") {
      expect(params).toEqual({ profileId: modelAccountProfile.id, identity });
      links = [{ profileId: modelAccountProfile.id, identity }];
      return pendingLink.promise;
    }
    if (method === "users.unlinkChannelIdentity") {
      links = links.filter(
        (link) =>
          link.profileId !== modelAccountProfile.id ||
          link.identity.channelId !== identity.channelId ||
          link.identity.accountId !== identity.accountId ||
          link.identity.senderId !== identity.senderId,
      );
      return { removed: true };
    }
    if (method === "users.prefs.get") {
      return { status: "no_durable_identity" };
    }
    throw new Error("unexpected method: " + method);
  });
  const harness = createChannelIdentityHarness(request as GatewayBrowserClient["request"]);
  const page = mountProfilePage(harness.context);
  try {
    await waitForFast(() =>
      expect(
        page.querySelector<HTMLButtonElement>(
          "#settings-profile-channel-identities button[type=submit]",
        )?.disabled,
      ).toBe(false),
    );

    const section = page.querySelector<HTMLFormElement>("#settings-profile-channel-identities")!;
    for (const [label, value] of [
      ["Channel ID", identity.channelId],
      ["Configured account ID", identity.accountId],
      ["Native sender ID", identity.senderId],
    ] as const) {
      const input = section.querySelector<HTMLInputElement>('input[aria-label="' + label + '"]')!;
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    flush();

    const form = section;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    const linkCalls = request.mock.calls.filter(
      ([method]) => method === "users.linkChannelIdentity",
    );
    expect(linkCalls).toHaveLength(1);
    expect(linkCalls[0]).toEqual([
      "users.linkChannelIdentity",
      { profileId: modelAccountProfile.id, identity },
    ]);

    pendingLink.resolve({ profileId: modelAccountProfile.id, identity });
    await waitForFast(() =>
      expect(section.querySelector('[role="status"]')?.textContent).toContain(
        "Channel account link added.",
      ),
    );
    await waitForFast(() => expect(section.textContent).toContain(identity.senderId));
    expect(section.querySelector(".settings-empty")).toBeNull();

    const remove = section.querySelector<HTMLButtonElement>(
      'button[aria-label="Remove link telegram, main, same-turn"]',
    )!;
    await waitForFast(() => expect(remove.disabled).toBe(false));
    remove.click();
    await waitForFast(() =>
      expect(section.querySelector(".settings-empty")?.textContent).toContain(
        "No channel accounts are linked to your profile.",
      ),
    );
    expect(request).toHaveBeenCalledWith("users.unlinkChannelIdentity", {
      profileId: modelAccountProfile.id,
      identity,
    });
    expect(section.textContent).not.toContain(identity.senderId);
  } finally {
    pendingLink.resolve({ profileId: modelAccountProfile.id, identity });
    await pendingLink.promise;
    await Promise.resolve();
    await Promise.resolve();
    flush();
  }
});

it("reloads links after a stale mutation releases its guard without a view flush", async () => {
  const pendingLink = createDeferred<{
    profileId: string;
    identity: { channelId: string; accountId: string; senderId: string };
  }>();
  const identity = { channelId: "telegram", accountId: "main", senderId: "refreshed" };
  let links: Array<{ profileId: string; identity: typeof identity }> = [];
  let listCalls = 0;
  let selfCalls = 0;
  let preferenceCalls = 0;
  const request = vi.fn(async (method: string, params?: unknown) => {
    if (method === "users.self") {
      selfCalls += 1;
      return { profile: modelAccountProfile };
    }
    if (method === "users.listModelAccounts") {
      return { profileId: modelAccountProfile.id, accounts: [], links: [] };
    }
    if (method === "users.prefs.get") {
      preferenceCalls += 1;
      return { status: "no_durable_identity" };
    }
    if (method === "users.listChannelIdentities") {
      expect(params).toEqual({ profileId: modelAccountProfile.id });
      listCalls += 1;
      return { links };
    }
    if (method === "users.linkChannelIdentity") {
      links = [params as { profileId: string; identity: typeof identity }];
      return pendingLink.promise;
    }
    throw new Error("unexpected method: " + method);
  });
  const harness = createChannelIdentityHarness(request as GatewayBrowserClient["request"]);
  const page = mountProfilePage(harness.context);
  try {
    await waitForFast(() =>
      expect(
        page.querySelector<HTMLButtonElement>(
          "#settings-profile-channel-identities button[type=submit]",
        )?.disabled,
      ).toBe(false),
    );
    expect(listCalls).toBe(1);
    expect(selfCalls).toBe(1);

    const section = page.querySelector<HTMLFormElement>("#settings-profile-channel-identities")!;
    for (const [label, value] of [
      ["Channel ID", identity.channelId],
      ["Configured account ID", identity.accountId],
      ["Native sender ID", identity.senderId],
    ] as const) {
      const input = section.querySelector<HTMLInputElement>('input[aria-label="' + label + '"]')!;
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    section.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await waitForFast(() =>
      expect(request.mock.calls.some(([method]) => method === "users.linkChannelIdentity")).toBe(
        true,
      ),
    );

    harness.emitHello(gatewayHelloForMethods(channelIdentityMethods, ["operator.admin"]));
    await waitForFast(() => expect(preferenceCalls).toBe(2));
    expect(selfCalls).toBe(2);
    expect(listCalls).toBe(1);
    flush();

    pendingLink.resolve({ profileId: modelAccountProfile.id, identity });
    await waitForFast(() => expect(listCalls).toBe(2));

    await waitForFast(() => expect(section.textContent).toContain(identity.senderId));
    expect(request).toHaveBeenCalledWith("users.listChannelIdentities", {
      profileId: modelAccountProfile.id,
    });
  } finally {
    pendingLink.resolve({ profileId: modelAccountProfile.id, identity });
    await pendingLink.promise;
    await Promise.resolve();
    await Promise.resolve();
    flush();
  }
});

it("retires an in-flight channel identity list when negotiated grants change", async () => {
  const oldList = createDeferred<{
    links: Array<{
      profileId: string;
      identity: { channelId: string; accountId: string; senderId: string };
    }>;
  }>();
  let listCalls = 0;
  const request = vi.fn(async (method: string) => {
    if (method === "users.self") {
      return { profile: modelAccountProfile };
    }
    if (method === "users.listModelAccounts") {
      return { profileId: modelAccountProfile.id, accounts: [], links: [] };
    }
    if (method === "users.listChannelIdentities") {
      listCalls += 1;
      return listCalls === 1
        ? oldList.promise
        : {
            links: [
              {
                profileId: modelAccountProfile.id,
                identity: { channelId: "fresh", accountId: "main", senderId: "sender-fresh" },
              },
            ],
          };
    }
    throw new Error("unexpected method: " + method);
  });
  const harness = createChannelIdentityHarness(request as GatewayBrowserClient["request"]);
  const page = mountProfilePage(harness.context);
  await waitForFast(() => expect(listCalls).toBe(1));

  harness.emitHello(
    gatewayHelloForMethods(channelIdentityMethods, ["operator.admin", "operator.read"]),
  );
  await waitForFast(() => expect(listCalls).toBe(2));
  await waitForFast(() =>
    expect(page.querySelector("#settings-profile-channel-identities")?.textContent).toContain(
      "sender-fresh",
    ),
  );
  oldList.resolve({
    links: [
      {
        profileId: modelAccountProfile.id,
        identity: { channelId: "stale", accountId: "main", senderId: "sender-stale" },
      },
    ],
  });
  await oldList.promise;
  flush();

  expect(listCalls).toBe(2);
  expect(page.querySelector("#settings-profile-channel-identities")?.textContent).toContain(
    "sender-fresh",
  );
  expect(page.querySelector("#settings-profile-channel-identities")?.textContent).not.toContain(
    "sender-stale",
  );
});

it("does not show or request channel identity links without the negotiated admin scope", async () => {
  const profile = { ...modelAccountProfile, role: "admin" };
  const request = vi.fn(async (method: string) => {
    if (method === "users.self") {
      return { profile };
    }
    if (method === "users.listModelAccounts") {
      return { profileId: profile.id, accounts: [], links: [] };
    }
    throw new Error("unexpected method: " + method);
  });
  const harness = createChannelIdentityHarness(
    request as GatewayBrowserClient["request"],
    profile,
    ["operator.write"],
  );
  const page = mountProfilePage(harness.context);
  await waitForFast(() =>
    expect(page.querySelector(".identity-name-control input")).not.toBeNull(),
  );

  expect(page.querySelector("#settings-profile-channel-identities")).toBeNull();
  expect(request.mock.calls.some(([method]) => method === "users.listChannelIdentities")).toBe(
    false,
  );
});

it("retires a hidden channel identity owner before a same-turn reconnect", async () => {
  const request = vi.fn(async (method: string, params?: unknown) => {
    if (method === "users.self") {
      return { profile: modelAccountProfile };
    }
    if (method === "users.listModelAccounts") {
      return { profileId: modelAccountProfile.id, accounts: [], links: [] };
    }
    if (method === "users.listChannelIdentities") {
      return { links: [] };
    }
    if (method === "users.linkChannelIdentity") {
      return params as {
        profileId: string;
        identity: { channelId: string; accountId: string; senderId: string };
      };
    }
    throw new Error("unexpected method: " + method);
  });
  const harness = createChannelIdentityHarness(request as GatewayBrowserClient["request"]);
  const connectedSnapshot = { ...harness.context.gateway.snapshot };
  const page = mountProfilePage(harness.context);
  await waitForFast(() =>
    expect(
      page.querySelector<HTMLButtonElement>(
        "#settings-profile-channel-identities button[type=submit]",
      )?.disabled,
    ).toBe(false),
  );

  const section = page.querySelector<HTMLElement>("#settings-profile-channel-identities")!;
  for (const [label, value] of [
    ["Channel ID", "old-channel"],
    ["Configured account ID", "old-account"],
    ["Native sender ID", "old-target-draft"],
  ] as const) {
    const input = section.querySelector<HTMLInputElement>('input[aria-label="' + label + '"]')!;
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }
  const initialListCalls = request.mock.calls.filter(
    ([method]) => method === "users.listChannelIdentities",
  ).length;

  harness.emitSnapshot({ client: null, phase: "reconnecting", hello: null, selfUser: null });
  harness.emitSnapshot(connectedSnapshot);

  await waitForFast(() =>
    expect(
      page.querySelector<HTMLButtonElement>(
        "#settings-profile-channel-identities button[type=submit]",
      )?.disabled,
    ).toBe(false),
  );
  await waitForFast(() =>
    expect(
      request.mock.calls.filter(([method]) => method === "users.listChannelIdentities").length,
    ).toBeGreaterThan(initialListCalls),
  );
  const reconnectedSection = page.querySelector<HTMLElement>(
    "#settings-profile-channel-identities",
  )!;
  for (const label of ["Channel ID", "Configured account ID", "Native sender ID"]) {
    expect(
      reconnectedSection.querySelector<HTMLInputElement>('input[aria-label="' + label + '"]')
        ?.value,
    ).toBe("");
  }

  const identity = { channelId: "telegram", accountId: "main", senderId: "usable-after-reconnect" };
  for (const [label, value] of [
    ["Channel ID", identity.channelId],
    ["Configured account ID", identity.accountId],
    ["Native sender ID", identity.senderId],
  ] as const) {
    const input = reconnectedSection.querySelector<HTMLInputElement>(
      'input[aria-label="' + label + '"]',
    )!;
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }
  reconnectedSection.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
  await waitForFast(() =>
    expect(reconnectedSection.querySelector('[role="status"]')?.textContent).toContain(
      "Channel account link added.",
    ),
  );
  expect(request).toHaveBeenCalledWith("users.linkChannelIdentity", {
    profileId: modelAccountProfile.id,
    identity,
  });

  harness.emitSnapshot({ client: null, phase: "reconnecting", hello: null, selfUser: null });
  await waitForFast(() =>
    expect(page.querySelector("#settings-profile-channel-identities")).toBeNull(),
  );
});

it("does not expose channel identity management for the shared Gateway Owner profile", async () => {
  const profile = { ...modelAccountProfile, id: GATEWAY_OWNER_PROFILE_ID, role: "owner" };
  const request = vi.fn(async (method: string) => {
    if (method === "users.self") {
      return { profile };
    }
    if (method === "users.listModelAccounts") {
      return { profileId: profile.id, accounts: [], links: [] };
    }
    throw new Error("unexpected method: " + method);
  });
  const harness = createChannelIdentityHarness(request as GatewayBrowserClient["request"], profile);
  const page = mountProfilePage(harness.context);
  await waitForFast(() =>
    expect(page.querySelector(".identity-name-control input")).not.toBeNull(),
  );

  expect(page.querySelector("#settings-profile-channel-identities")).toBeNull();
  expect(request.mock.calls.some(([method]) => method === "users.listChannelIdentities")).toBe(
    false,
  );
});

it("retires the prior personal identity and channel form on principal change", async () => {
  const nextProfile: UserProfile = {
    ...modelAccountProfile,
    id: "replacement-profile",
    displayName: "Grace",
    emails: ["grace@example.test"],
  };
  let profile = modelAccountProfile;
  const linkRequests: unknown[] = [];
  const request = vi.fn(async (method: string, params?: unknown) => {
    if (method === "users.self") {
      return { profile };
    }
    if (method === "users.listModelAccounts") {
      return { profileId: profile.id, accounts: [], links: [] };
    }
    if (method === "users.listChannelIdentities") {
      return { links: [] };
    }
    if (method === "users.linkChannelIdentity") {
      linkRequests.push(params);
      return params;
    }
    throw new Error("unexpected method: " + method);
  });
  const harness = createChannelIdentityHarness(request as GatewayBrowserClient["request"]);
  const page = mountProfilePage(harness.context);
  await waitForFast(() =>
    expect(
      page.querySelector<HTMLButtonElement>(
        "#settings-profile-channel-identities button[type=submit]",
      )?.disabled,
    ).toBe(false),
  );

  const staleForm = page.querySelector<HTMLFormElement>("#settings-profile-channel-identities")!;
  for (const [label, value] of [
    ["Channel ID", "old-channel"],
    ["Configured account ID", "old-account"],
    ["Native sender ID", "old-sender"],
  ] as const) {
    const input = staleForm.querySelector<HTMLInputElement>('input[aria-label="' + label + '"]')!;
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  profile = nextProfile;
  harness.emitSnapshot({
    selfUser: {
      id: nextProfile.id,
      email: nextProfile.emails[0],
      name: nextProfile.displayName ?? undefined,
    },
  });
  flush();
  expect(page.textContent).not.toContain("ada@example.test");
  expect(page.querySelector(".identity-name-control")).toBeNull();
  expect(page.querySelector("#settings-profile-channel-identities")).toBeNull();

  staleForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  flush();
  expect(linkRequests).toHaveLength(0);

  await waitForFast(() =>
    expect(
      page.querySelector<HTMLButtonElement>(
        "#settings-profile-channel-identities button[type=submit]",
      )?.disabled,
    ).toBe(false),
  );
  expect(page.textContent).toContain("grace@example.test");
  expect(page.querySelector<HTMLInputElement>(".identity-name-control input")?.value).toBe("Grace");
  expect(linkRequests).toHaveLength(0);
});

it("does not report a pending link as successful after the admin grant is revoked", async () => {
  const pendingLink = createDeferred<{
    profileId: string;
    identity: { channelId: string; accountId: string; senderId: string };
  }>();
  const identity = { channelId: "telegram", accountId: "main", senderId: "pending-sender" };
  let links: Array<{ profileId: string; identity: typeof identity }> = [];
  const request = vi.fn(async (method: string, params?: unknown) => {
    if (method === "users.self") {
      return { profile: modelAccountProfile };
    }
    if (method === "users.listModelAccounts") {
      return { profileId: modelAccountProfile.id, accounts: [], links: [] };
    }
    if (method === "users.listChannelIdentities") {
      return { links };
    }
    if (method === "users.linkChannelIdentity") {
      links = [params as { profileId: string; identity: typeof identity }];
      return pendingLink.promise;
    }
    throw new Error("unexpected method: " + method);
  });
  const harness = createChannelIdentityHarness(request as GatewayBrowserClient["request"]);
  const page = mountProfilePage(harness.context);
  await waitForFast(() =>
    expect(page.querySelector("#settings-profile-channel-identities input")).not.toBeNull(),
  );
  let section = page.querySelector<HTMLElement>("#settings-profile-channel-identities")!;
  await waitForFast(() =>
    expect(
      page.querySelector<HTMLButtonElement>(
        "#settings-profile-channel-identities button[type=submit]",
      )?.disabled,
    ).toBe(false),
  );
  for (const [label, value] of [
    ["Channel ID", identity.channelId],
    ["Configured account ID", identity.accountId],
    ["Native sender ID", identity.senderId],
  ] as const) {
    const input = section.querySelector<HTMLInputElement>('input[aria-label="' + label + '"]')!;
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }
  section.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
  await waitForFast(() =>
    expect(request.mock.calls.some(([method]) => method === "users.linkChannelIdentity")).toBe(
      true,
    ),
  );

  const staleForm = section;
  harness.emitHello(gatewayHelloForMethods(channelIdentityMethods, ["operator.read"]));
  staleForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  flush();
  expect(page.querySelector("#settings-profile-channel-identities")).toBeNull();
  expect(page.querySelector(".identity-name-control")).not.toBeNull();
  expect(
    request.mock.calls.filter(([method]) => method === "users.linkChannelIdentity"),
  ).toHaveLength(1);

  pendingLink.resolve({ profileId: modelAccountProfile.id, identity });
  await pendingLink.promise;
  await Promise.resolve();
  await Promise.resolve();
  flush();

  harness.emitHello(gatewayHelloForMethods(channelIdentityMethods, ["operator.admin"]));
  await waitForFast(() =>
    expect(page.querySelector("#settings-profile-channel-identities")?.textContent).toContain(
      "pending-sender",
    ),
  );
  section = page.querySelector<HTMLElement>("#settings-profile-channel-identities")!;
  expect(section.querySelector<HTMLInputElement>('input[aria-label="Channel ID"]')?.value).toBe(
    identity.channelId,
  );
  expect(section.querySelector('[role="status"]')).toBeNull();
});

it.each(["link", "unlink"] as const)(
  "reconciles the full channel list when a %s commits during a profile preference save",
  async (operation) => {
    const profileId = modelAccountProfile.id;
    const linked = {
      profileId,
      identity: { channelId: "discord", accountId: "main", senderId: "new-link" },
    };
    const removed = {
      profileId,
      identity: { channelId: "telegram", accountId: "main", senderId: "removed-link" },
    };
    const retained = {
      profileId,
      identity: { channelId: "matrix", accountId: "main", senderId: "retained-link" },
    };
    const concurrent = {
      profileId,
      identity: { channelId: "signal", accountId: "main", senderId: "concurrent-link" },
    };
    let links = operation === "link" ? [retained] : [removed, retained];
    const canonicalLinks =
      operation === "link" ? [retained, linked, concurrent] : [retained, concurrent];
    let channelListReads = 0;
    let lastListedLinks: typeof canonicalLinks = [];
    const pendingMutation = createDeferred<unknown>();
    const pendingPreference = createDeferred<{ status: "ok" }>();
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "users.self") {
        return { profile: modelAccountProfile };
      }
      if (method === "users.listModelAccounts") {
        return { profileId, accounts: [], links: [] };
      }
      if (method === "users.prefs.get") {
        return { status: "ok", entries: {} };
      }
      if (method === "users.prefs.set") {
        return pendingPreference.promise;
      }
      if (method === "users.listChannelIdentities") {
        channelListReads += 1;
        lastListedLinks = [...links];
        return { links };
      }
      if (method === "users.linkChannelIdentity" && operation === "link") {
        links = canonicalLinks;
        expect(params).toEqual({ profileId, identity: linked.identity });
        return pendingMutation.promise;
      }
      if (method === "users.unlinkChannelIdentity" && operation === "unlink") {
        links = canonicalLinks;
        expect(params).toEqual({ profileId, identity: removed.identity });
        return pendingMutation.promise;
      }
      throw new Error("unexpected method: " + method);
    });
    const harness = createChannelIdentityHarness(request as GatewayBrowserClient["request"]);
    const eventListeners = new Set<Parameters<typeof harness.context.gateway.subscribeEvents>[0]>();
    harness.context.gateway.subscribeEvents = (listener) => {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    };
    const emitProfileIdentityChange = () => {
      for (const listener of eventListeners) {
        listener({
          type: "event",
          event: "sessions.changed",
          payload: { reason: "profile-identity" },
        });
      }
    };
    const page = mountProfilePage(harness.context);
    try {
      await waitForFast(() =>
        expect(
          page.querySelector<HTMLButtonElement>(
            "#settings-profile-channel-identities button[type=submit]",
          )?.disabled,
        ).toBe(false),
      );
      expect(channelListReads).toBe(1);
      const section = page.querySelector<HTMLElement>("#settings-profile-channel-identities")!;
      if (operation === "link") {
        for (const [label, value] of [
          ["Channel ID", linked.identity.channelId],
          ["Configured account ID", linked.identity.accountId],
          ["Native sender ID", linked.identity.senderId],
        ] as const) {
          const input = section.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
          input.value = value;
          input.dispatchEvent(new Event("input", { bubbles: true }));
        }
        section.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
      } else {
        section
          .querySelector<HTMLButtonElement>(
            'button[aria-label="Remove link telegram, main, removed-link"]',
          )!
          .click();
      }
      const mutationMethod =
        operation === "link" ? "users.linkChannelIdentity" : "users.unlinkChannelIdentity";
      await waitForFast(() =>
        expect(request.mock.calls.some(([method]) => method === mutationMethod)).toBe(true),
      );

      const preference = page.querySelector<HTMLInputElement>("input.settings-toggle__input")!;
      const preferenceResult = !preference.checked;
      preference.checked = preferenceResult;
      preference.dispatchEvent(new Event("change", { bubbles: true }));
      await waitForFast(() =>
        expect(request.mock.calls.some(([method]) => method === "users.prefs.set")).toBe(true),
      );

      const selfReadsBeforeEvent = request.mock.calls.filter(
        ([method]) => method === "users.self",
      ).length;
      emitProfileIdentityChange();
      flush();
      expect(request.mock.calls.filter(([method]) => method === "users.self")).toHaveLength(
        selfReadsBeforeEvent,
      );
      pendingMutation.resolve(operation === "link" ? linked : { removed: true });
      await pendingMutation.promise;
      await Promise.resolve();
      await Promise.resolve();
      await waitForFast(() => expect(channelListReads).toBe(2));
      expect(lastListedLinks).toEqual(canonicalLinks);

      pendingPreference.resolve({ status: "ok" });
      await waitForSolid(() => {
        const finalPreference = page.querySelector<HTMLInputElement>(
          "input.settings-toggle__input",
        );
        expect(finalPreference).not.toBeNull();
        expect(finalPreference?.disabled).toBe(false);
        expect(finalPreference?.checked).toBe(preferenceResult);
        const finalSection = page.querySelector<HTMLElement>(
          "#settings-profile-channel-identities",
        );
        expect(finalSection).not.toBeNull();
        expect(finalSection?.getAttribute("aria-busy")).toBe("false");
        expect(finalSection?.textContent).toContain(retained.identity.senderId);
        if (operation === "link") {
          expect(finalSection?.textContent).toContain(linked.identity.senderId);
        } else {
          expect(finalSection?.textContent).not.toContain(removed.identity.senderId);
        }
        expect(finalSection?.textContent).toContain(concurrent.identity.senderId);
      });
    } finally {
      pendingMutation.resolve(operation === "link" ? linked : { removed: true });
      pendingPreference.resolve({ status: "ok" });
      await Promise.resolve();
      await Promise.resolve();
      flush();
    }
  },
);
