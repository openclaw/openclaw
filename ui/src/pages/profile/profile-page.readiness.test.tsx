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

it("shows the returned identity while preferences are pending, then enables its controls", async () => {
  const preferences = createDeferred<{
    status: "ok";
    entries: Record<string, boolean>;
  }>();
  const request = mockRpc({
    "users.self": () => ({ profile: modelAccountProfile }),
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
  const page = mountProfilePage(harness.context);
  const input = () => page.querySelector<HTMLInputElement>(".identity-name-control input");
  try {
    await waitForSolid(() => {
      expect(request).toHaveBeenCalledWith("users.prefs.get", {
        keys: [GIT_COAUTHOR_PREFERENCE_KEY],
      });
      expect(page.textContent).toContain("ada@example.test");
      expect(input()).toMatchObject({ value: "Ada", disabled: true });
    });
    preferences.resolve({ status: "ok", entries: { [GIT_COAUTHOR_PREFERENCE_KEY]: false } });
    await waitForSolid(() => expect(input()).toMatchObject({ value: "Ada", disabled: false }));
  } finally {
    page.unmount();
  }
});
