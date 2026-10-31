/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { i18n } from "../../i18n/index.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { cleanupSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
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

it.each(["link", "unlink"] as const)(
  "retires a pending %s across admin revoke-and-restore while preserving a fresh draft",
  async (operation) => {
    const profileId = modelAccountProfile.id;
    const identity = { channelId: "telegram", accountId: "main", senderId: "retired-operation" };
    const freshDraft = { channelId: "signal", accountId: "next", senderId: "fresh-draft" };
    let links = operation === "unlink" ? [{ profileId, identity }] : [];
    const pendingMutation = createDeferred<unknown>();
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "users.self") {
        return { profile: modelAccountProfile };
      }
      if (method === "users.listModelAccounts") {
        return { profileId, accounts: [], links: [] };
      }
      if (method === "users.listChannelIdentities") {
        return { links };
      }
      if (method === "users.linkChannelIdentity" && operation === "link") {
        expect(params).toEqual({ profileId, identity });
        links = [{ profileId, identity }];
        return pendingMutation.promise;
      }
      if (method === "users.unlinkChannelIdentity" && operation === "unlink") {
        expect(params).toEqual({ profileId, identity });
        return pendingMutation.promise;
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
      let section = page.querySelector<HTMLElement>("#settings-profile-channel-identities")!;
      if (operation === "link") {
        for (const [label, value] of [
          ["Channel ID", identity.channelId],
          ["Configured account ID", identity.accountId],
          ["Native sender ID", identity.senderId],
        ] as const) {
          const input = section.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
          input.value = value;
          input.dispatchEvent(new Event("input", { bubbles: true }));
        }
        section.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
      } else {
        section
          .querySelector<HTMLButtonElement>(
            'button[aria-label="Remove link telegram, main, retired-operation"]',
          )!
          .click();
      }
      const method =
        operation === "link" ? "users.linkChannelIdentity" : "users.unlinkChannelIdentity";
      await waitForFast(() =>
        expect(request.mock.calls.some(([name]) => name === method)).toBe(true),
      );

      harness.emitHello(gatewayHelloForMethods(channelIdentityMethods, ["operator.read"]));
      flush();
      expect(page.querySelector("#settings-profile-channel-identities")).toBeNull();

      harness.emitHello(gatewayHelloForMethods(channelIdentityMethods, ["operator.admin"]));
      await waitForFast(() =>
        expect(
          page.querySelector<HTMLButtonElement>(
            "#settings-profile-channel-identities button[type=submit]",
          )?.disabled,
        ).toBe(false),
      );
      section = page.querySelector<HTMLElement>("#settings-profile-channel-identities")!;
      for (const [label, value] of [
        ["Channel ID", freshDraft.channelId],
        ["Configured account ID", freshDraft.accountId],
        ["Native sender ID", freshDraft.senderId],
      ] as const) {
        const input = section.querySelector<HTMLInputElement>('input[aria-label="' + label + '"]')!;
        input.value = value;
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }

      pendingMutation.resolve(operation === "link" ? { profileId, identity } : { removed: true });
      await pendingMutation.promise;
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      flush();

      for (const [label, value] of [
        ["Channel ID", freshDraft.channelId],
        ["Configured account ID", freshDraft.accountId],
        ["Native sender ID", freshDraft.senderId],
      ] as const) {
        expect(
          page.querySelector<HTMLInputElement>(
            '#settings-profile-channel-identities input[aria-label="' + label + '"]',
          )?.value,
        ).toBe(value);
      }
      expect(page.querySelector("#settings-profile-channel-identities [role=status]")).toBeNull();
      if (operation === "unlink") {
        expect(page.querySelector("#settings-profile-channel-identities")?.textContent).toContain(
          identity.senderId,
        );
      }
    } finally {
      pendingMutation.resolve(operation === "link" ? { profileId, identity } : { removed: true });
      await Promise.resolve();
      await Promise.resolve();
      flush();
    }
  },
);
