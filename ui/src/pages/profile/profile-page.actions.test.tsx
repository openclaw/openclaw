/* @vitest-environment jsdom */
import { expect, it } from "vitest";
import { GIT_COAUTHOR_PREFERENCE_KEY } from "../../../../packages/gateway-protocol/src/index.ts";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  createConnectedContext,
  modelAccountProfile,
  mountProfilePage,
} from "./profile-page.test-support.tsx";
import { mockRpc } from "./profile-rpc.test-support.ts";

it("shows pending coauthor consent and restores the accepted value after failure", async () => {
  const saved = createDeferred();
  const request = mockRpc({
    "users.self": () => ({ profile: modelAccountProfile }),
    "users.listModelAccounts": () => ({
      profileId: modelAccountProfile.id,
      accounts: [],
      links: [],
    }),
    "users.prefs.get": () => ({ status: "ok", entries: { [GIT_COAUTHOR_PREFERENCE_KEY]: true } }),
    "users.prefs.set": () => saved.promise,
  });
  const harness = createConnectedContext(request as GatewayBrowserClient["request"], {
    id: modelAccountProfile.id,
    name: "Ada",
  });
  harness.emitHello(gatewayHelloForMethods([], ["operator.write"]));
  const page = mountProfilePage(harness.context);
  const toggle = () =>
    page.querySelector<HTMLInputElement>('#settings-profile-identity [role="switch"]');
  await waitForSolid(() => expect(toggle()).toMatchObject({ checked: true, disabled: false }));
  toggle()!.click();
  await waitForSolid(() => expect(toggle()).toMatchObject({ checked: false, disabled: true }));
  expect(request.mock.calls.filter(([method]) => method === "users.prefs.set")).toHaveLength(1);
  saved.reject(new Error("Consent could not be saved"));
  await waitForSolid(() => {
    expect(toggle()).toMatchObject({ checked: true, disabled: false });
    expect(page.textContent).toContain("Consent could not be saved");
  });
});

it.each(["identity", "navigation"])(
  "releases a pending identity action on %s change",
  async (change) => {
    const saved = createDeferred();
    let profile = modelAccountProfile;
    const request = mockRpc({
      "users.self": () => ({ profile }),
      "users.listModelAccounts": () => ({ profileId: profile.id, accounts: [], links: [] }),
      "users.prefs.get": () => ({ status: "ok", entries: { [GIT_COAUTHOR_PREFERENCE_KEY]: true } }),
      "users.prefs.set": () => saved.promise,
    });
    const harness = createConnectedContext(request as GatewayBrowserClient["request"], {
      id: profile.id,
      name: "Ada",
    });
    harness.emitHello(gatewayHelloForMethods([], ["operator.write"]));
    let page = mountProfilePage(harness.context);
    const toggle = () =>
      page.querySelector<HTMLInputElement>('#settings-profile-identity [role="switch"]');
    await waitForSolid(() => expect(toggle()).toMatchObject({ checked: true, disabled: false }));
    toggle()!.click();
    await waitForSolid(() =>
      expect(request.mock.calls.filter(([method]) => method === "users.prefs.set")).toHaveLength(1),
    );
    if (change === "navigation") {
      harness.emitNavigation();
      page.unmount();
    }
    profile = { ...modelAccountProfile, id: "profile-2", displayName: "Grace" };
    harness.emitSnapshot({ selfUser: { id: profile.id, name: "Grace" } });
    if (change === "navigation") {
      page = mountProfilePage(harness.context);
    }
    await waitForSolid(() => {
      expect(page.querySelector<HTMLInputElement>(".identity-name-control input")?.value).toBe(
        "Grace",
      );
      expect(toggle()).toMatchObject({ checked: true, disabled: false });
    });
    saved.reject(new Error("Retired consent failure"));
    await saved.promise.catch(() => undefined);
    await waitForSolid(() => {
      expect(toggle()).toMatchObject({ checked: true, disabled: false });
      expect(page.textContent).not.toContain("Retired consent failure");
    });
  },
);
