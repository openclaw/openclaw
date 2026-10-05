// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { setAvatarGatewayOrigin } from "../lib/identity-avatar-context.ts";
import { gatewayPresentationScope } from "./gateway-presentation-scope.ts";
import {
  createGatewayEvent,
  createGatewayStoreTestStore as createStore,
  GATEWAY_STORE_TEST_HELLO as BASE_HELLO,
  stubGatewayStoreTestGlobals,
} from "./gateway-store.test-support.ts";

const HELLO = { ...BASE_HELLO, auth: { ...BASE_HELLO.auth!, scopes: ["operator.read"] } };
function profile(id: string, displayName: string) {
  return {
    id,
    displayName,
    emails: [],
    createdAt: 1,
    updatedAt: 1,
    avatarMime: null,
    mergedInto: null,
    githubIdentity: null,
    hasAvatar: false,
  };
}

describe("verified Factory profile presentation", () => {
  beforeEach(stubGatewayStoreTestGlobals);
  afterEach(() => {
    setAvatarGatewayOrigin(null);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("shows the verified Factory profile name in shared sidebar presentation", async () => {
    const { gateway, current } = createStore();
    gateway.start();
    const active = current();
    const principal = "github:microsoft.ghe.com:1358766";
    active.request.mockResolvedValue({
      profile: profile("factory-profile", "Galin-Iliev"),
      authenticatedGitHubIdentity: {
        host: "microsoft.ghe.com",
        accountId: 1358766,
        login: "Galin-Iliev",
      },
    });
    active.opts.onHello?.({
      ...HELLO,
      snapshot: {
        presence: [
          {
            instanceId: active.instanceId,
            user: {
              id: "factory-profile",
              name: principal,
              email: principal,
              avatarUrl: "/api/users/factory-profile/avatar?v=1",
            },
          },
        ],
      },
    });

    await gateway.loadSelfProfile();
    expect(gatewayPresentationScope(gateway).displayUser).toMatchObject({
      id: "factory-profile",
      name: "Galin-Iliev",
      avatarUrl: "/api/users/factory-profile/avatar?v=1",
    });
    expect(gateway.snapshot.selfUser?.email).toBeUndefined();
    expect(active.request).toHaveBeenCalledWith("users.self", {});

    active.opts.onEvent?.(
      createGatewayEvent("presence", {
        presence: [
          {
            instanceId: active.instanceId,
            user: {
              id: "factory-profile",
              name: principal,
              email: principal,
              avatarUrl: "/api/users/factory-profile/avatar?v=2",
            },
          },
        ],
      }),
    );
    expect(gatewayPresentationScope(gateway).displayUser).toMatchObject({
      name: "Galin-Iliev",
      avatarUrl: "/api/users/factory-profile/avatar?v=2",
    });
    expect(gateway.snapshot.selfUser?.email).toBeUndefined();

    gateway.updateSelfUser?.({ name: "Preferred name" });
    active.opts.onEvent?.(
      createGatewayEvent(
        "presence",
        {
          presence: [
            { instanceId: active.instanceId, user: { id: "factory-profile", name: principal } },
          ],
        },
        2,
      ),
    );
    expect(gatewayPresentationScope(gateway).displayUser?.name).toBe("Preferred name");
  });

  it("ignores a prior Factory profile result after a connection replacement", async () => {
    const { gateway, current } = createStore();
    gateway.start();
    const oldClient = current();
    const oldResult = createDeferred<unknown>();
    oldClient.request.mockReturnValue(oldResult.promise);
    oldClient.opts.onHello?.({
      ...HELLO,
      snapshot: {
        presence: [
          {
            instanceId: oldClient.instanceId,
            user: { id: "old-profile", name: "github:microsoft.ghe.com:1358766" },
          },
        ],
      },
    });

    gateway.connect({ gatewayUrl: "wss://replacement.example.test" });
    const newClient = current();
    const newResult = createDeferred<unknown>();
    newClient.request.mockReturnValue(newResult.promise);
    newClient.opts.onHello?.({
      ...HELLO,
      snapshot: {
        presence: [
          {
            instanceId: newClient.instanceId,
            user: { id: "new-profile", name: "github:microsoft.ghe.com:246810" },
          },
        ],
      },
    });
    oldResult.resolve({
      profile: profile("old-profile", "Old name"),
      authenticatedGitHubIdentity: { host: "microsoft.ghe.com", accountId: 1358766, login: "Old" },
    });
    await oldResult.promise;
    expect(gateway.snapshot.selfUser?.name).toBe("github:microsoft.ghe.com:246810");

    newResult.resolve({
      profile: profile("new-profile", "New name"),
      authenticatedGitHubIdentity: { host: "microsoft.ghe.com", accountId: 246810, login: "New" },
    });
    await gateway.loadSelfProfile();
    expect(gateway.snapshot.selfUser?.name).toBe("New name");
  });
});
