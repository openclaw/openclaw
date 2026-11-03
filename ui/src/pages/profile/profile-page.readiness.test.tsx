/* @vitest-environment jsdom */
import { expect, it } from "vitest";
import { GIT_COAUTHOR_PREFERENCE_KEY } from "../../../../packages/gateway-protocol/src/index.ts";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import "../../app/user-prefs-request.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  createConnectedContext,
  modelAccountProfile,
  mountProfilePage,
} from "./profile-page.test-support.tsx";
import { disconnectedGitHub, mockRpc } from "./profile-rpc.test-support.ts";

it("reveals identity and following settings before preferences finish, then enables controls", async () => {
  const identity = createDeferred<{ profile: typeof modelAccountProfile }>();
  const preferences = createDeferred<{
    status: "ok";
    entries: Record<string, boolean>;
  }>();
  const request = mockRpc({
    "users.self": () => identity.promise,
    "users.prefs.get": () => preferences.promise,
    "users.listModelAccounts": () => ({
      profileId: modelAccountProfile.id,
      accounts: [],
      links: [],
    }),
    "users.github.status": () => disconnectedGitHub,
  });
  const harness = createConnectedContext(request as GatewayBrowserClient["request"], {
    id: modelAccountProfile.id,
    name: "Ada",
  });
  harness.emitHello(gatewayHelloForMethods([], ["operator.write"]));
  harness.emitSnapshot({ selfUser: undefined });
  const page = mountProfilePage(harness.context);
  const input = () => page.querySelector<HTMLInputElement>(".identity-name-control input");
  const personalInstructions = page.querySelector("openclaw-personal-instructions");
  try {
    await waitForSolid(() => {
      expect(request).not.toHaveBeenCalledWith("users.self", {});
      expect(page.querySelector(".profile-hero")).not.toBeNull();
      expect(page.querySelector("#settings-profile-access")).not.toBeNull();
      expect(page.querySelector(".settings-loading-skeleton")).not.toBeNull();
      expect(personalInstructions).not.toBeNull();
      expect(page.querySelector("openclaw-model-accounts")).toBeNull();
      expect(page.querySelector(".settings-row--nav")).toBeNull();
    });
    harness.emitSnapshot({ selfUser: { id: modelAccountProfile.id, name: "Ada" } });
    await waitForSolid(() => {
      expect(request).toHaveBeenCalledWith("users.self", {});
      expect(page.querySelector("openclaw-model-accounts")).toBeNull();
      expect(page.querySelector(".settings-row--nav")).toBeNull();
    });
    identity.resolve({ profile: modelAccountProfile });
    await waitForSolid(() => {
      expect(request).toHaveBeenCalledWith("users.prefs.get", {
        keys: [GIT_COAUTHOR_PREFERENCE_KEY, "github.prAttribution.enabled"],
      });
      expect(page.textContent).toContain("ada@example.test");
      expect(page.querySelector("openclaw-model-accounts")).not.toBeNull();
      expect(page.querySelector(".settings-row--nav")?.textContent).toContain("Usage statistics");
      expect(input()).toMatchObject({ value: "Ada", disabled: true });
      expect(
        [
          ...page.querySelectorAll<HTMLInputElement>('#settings-profile-identity [role="switch"]'),
        ].map((toggle) => toggle.disabled),
      ).toEqual([true, true]);
    });
    preferences.resolve({
      status: "ok",
      entries: { [GIT_COAUTHOR_PREFERENCE_KEY]: false, "github.prAttribution.enabled": true },
    });
    await waitForSolid(() => {
      expect(input()).toMatchObject({ value: "Ada", disabled: false });
      expect(
        [
          ...page.querySelectorAll<HTMLInputElement>('#settings-profile-identity [role="switch"]'),
        ].map((toggle) => ({ checked: toggle.checked, disabled: toggle.disabled })),
      ).toEqual([
        { checked: false, disabled: false },
        { checked: true, disabled: false },
      ]);
    });
    harness.emitSnapshot({ phase: "stopped", client: null, selfUser: undefined });
    await waitForSolid(() => {
      expect(page.querySelector(".identity-name-control")).toBeNull();
      expect(page.querySelector("openclaw-personal-instructions")).toBe(personalInstructions);
    });
  } finally {
    page.unmount();
  }
});
