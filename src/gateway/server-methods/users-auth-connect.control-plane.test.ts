import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../../test/helpers/promise.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type { UserProfileAuthLink } from "../../state/user-model-accounts.js";
import {
  setupModelAccountConnectTest,
  prepareUserProfileSelectionAuthority,
  listUserProfileAuthLinks,
  listUserModelAccounts,
  readUserModelAccountSummary,
  setUserProfileAuthLink,
  clearUserProfileAuthLink,
  ensureAuthProfileStoreWithoutExternalProfiles,
  modelAccountLinksCurrent,
  credential,
  runAuth,
  broadcast,
  service,
  clients,
  self,
  writes,
  linksByOwner,
  createClient,
  rpc,
  flowRpc,
  startFlow,
  complete,
  terminal,
  status,
  setConfig,
} from "./users-auth-connect.test-support.js";

setupModelAccountConnectTest();

describe("users model-account control plane", () => {
  it("lists account pages for their owner or an identified administrator", async () => {
    const accounts = [
      {
        authProfileId: "personal:profile-1:saved",
        provider: "openai",
        label: "Saved account",
        authType: "oauth",
        selected: false,
      },
    ];
    listUserModelAccounts.mockReturnValue({ accounts, nextCursor: "personal:profile-1:saved" });
    expect(
      await rpc("users.listModelAccounts", { cursor: "personal:profile-1:before" }),
    ).toHaveBeenCalledWith(true, {
      profileId: "profile-1",
      accounts,
      nextCursor: "personal:profile-1:saved",
      links: [],
    });
    expect(listUserModelAccounts).toHaveBeenCalledWith(
      {
        profileId: "profile-1",
        cursor: "personal:profile-1:before",
      },
      { context: expect.anything() },
    );
    expect(await rpc("users.listAuthLinks", { profileId: "profile-1" })).toHaveBeenCalledWith(
      true,
      { links: [] },
    );
    listUserModelAccounts.mockClear();
    listUserProfileAuthLinks.mockClear();
    expect(
      await rpc("users.listModelAccounts", { profileId: "profile-other" }),
    ).toHaveBeenCalledWith(false, undefined, expect.objectContaining({ code: "FORBIDDEN" }));
    expect(listUserModelAccounts).not.toHaveBeenCalled();
    expect(await rpc("users.listAuthLinks", { profileId: "profile-other" })).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "FORBIDDEN" }),
    );
    expect(listUserProfileAuthLinks).not.toHaveBeenCalled();

    const admin = createClient("profile-admin", ["operator.admin"]);
    listUserModelAccounts.mockReturnValue({ accounts: [] });
    expect(
      await rpc("users.listModelAccounts", { profileId: "profile-other" }, admin),
    ).toHaveBeenCalledWith(true, {
      profileId: "profile-other",
      accounts: [],
      links: [],
    });
    expect(listUserModelAccounts).toHaveBeenCalledWith(
      {
        profileId: "profile-other",
        cursor: undefined,
      },
      { context: expect.anything() },
    );
  });

  it.each([
    ["users.listModelAccounts", {}],
    ["users.authConnect.catalog", {}],
    ["users.authConnect.start", { provider: "openai", method: "oauth" }],
    ["users.selectModelAccount", { authProfileId: "personal:profile-other:saved" }],
    ["users.listAuthLinks", {}],
    ["users.linkAuthProfile", { authProfileId: "openai:shared" }],
    ["users.unlinkAuthProfile", { provider: "openai" }],
  ] as const)(
    "requires an identified administrator for %s with an explicit owner",
    async (method, params) => {
      delete self.authenticatedUserProfile;
      self.connect.scopes = ["operator.admin"];
      readUserModelAccountSummary.mockReturnValue({
        provider: "openai",
        authProfileId: "personal:profile-other:saved",
      });

      expect(await rpc(method, { ...params, profileId: "profile-other" })).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "FORBIDDEN" }),
      );
      expect(prepareUserProfileSelectionAuthority).not.toHaveBeenCalled();
      expect(runAuth).not.toHaveBeenCalled();
      expect(writes).toEqual([]);
      expect(linksByOwner.size).toBe(0);
    },
  );

  it("selects a retained owned account and cancels an older sign-in without rewriting credentials", async () => {
    const flow = await startFlow();
    expect(
      await rpc("users.selectModelAccount", { authProfileId: "personal:profile-other:missing" }),
    ).toHaveBeenCalledWith(false, undefined, expect.objectContaining({ code: "INVALID_REQUEST" }));
    expect(await status(flow)).toMatchObject({ status: "pending" });
    readUserModelAccountSummary.mockReturnValue({
      provider: "openai",
      authProfileId: "personal:profile-1:saved",
    });
    expect(
      await rpc("users.selectModelAccount", { authProfileId: "personal:profile-1:saved" }),
    ).toHaveBeenCalledWith(true, {
      links: [{ provider: "openai", authProfileId: "personal:profile-1:saved", updatedAt: 2 }],
    });
    expect(readUserModelAccountSummary).toHaveBeenCalledWith(
      {
        profileId: "profile-1",
        authProfileId: "personal:profile-1:saved",
      },
      { context: expect.anything() },
    );
    expect(await status(flow)).toEqual({ status: "cancelled" });
    expect(await complete(flow)).toHaveBeenCalledWith(true, { status: "cancelled" });
    expect(writes).toEqual([]);
    expect(broadcast).toHaveBeenCalledExactlyOnceWith(
      "chat.metadata.changed",
      {},
      { dropIfSlow: true },
    );
    expect(
      await rpc("users.unlinkAuthProfile", { profileId: "profile-1", provider: "openai" }),
    ).toHaveBeenCalledWith(true, { links: [] });
    expect(linksByOwner.get("profile-1")).toEqual([]);
    expect(broadcast).toHaveBeenCalledTimes(2);
  });

  it("orders pending selection before disconnect without cancelling a newer sign-in", async ({
    signal,
  }) => {
    const lookupEntered = createDeferredCore();
    const releaseLookup = createDeferredCore<{ provider: string; authProfileId: string }>();
    const unlinkEntered = createDeferredCore();
    const authProfileId = "personal:profile-1:saved";
    readUserModelAccountSummary.mockImplementationOnce(() => {
      lookupEntered.resolve();
      return releaseLookup.promise;
    });
    const unlink = service.unlinkAsync.bind(service);
    vi.spyOn(service, "unlinkAsync").mockImplementation((...args) => {
      const result = unlink(...args);
      unlinkEntered.resolve();
      return result;
    });
    const selecting = rpc("users.selectModelAccount", { authProfileId });
    try {
      await withinTest(
        awaitGateBeforeSettlement(
          lookupEntered.promise,
          selecting,
          "Selection completed before its account lookup",
        ),
        signal,
      );
      const disconnecting = rpc("users.unlinkAuthProfile", {
        profileId: "profile-1",
        provider: "openai",
      });
      await withinTest(
        awaitGateBeforeSettlement(
          unlinkEntered.promise,
          disconnecting,
          "Disconnect completed before reaching the service",
        ),
        signal,
      );
      const newerFlow = await startFlow();
      releaseLookup.resolve({ provider: "openai", authProfileId });
      await Promise.all([selecting, disconnecting]);
      expect(setUserProfileAuthLink.mock.invocationCallOrder[0]).toBeLessThan(
        clearUserProfileAuthLink.mock.invocationCallOrder[0]!,
      );
      expect(linksByOwner.get("profile-1")).toEqual([]);
      expect(await status(newerFlow)).toMatchObject({ status: "pending" });
      await complete(newerFlow);
      await terminal(newerFlow, "connected");
      expect(writes).toEqual([credential]);
    } finally {
      releaseLookup.resolve({ provider: "openai", authProfileId });
    }
  });

  it.each([
    "disconnected",
    "agent caller",
    "synthetic system actor",
    "delegated operator actor",
    "system actor without a profile",
    "copied client",
    "agent tool caller",
  ] as const)(
    "refuses account links and selection for %s without changing the default",
    async (reason) => {
      const flow = await startFlow();
      const links = [{ provider: "openai", authProfileId: "openai:saved", updatedAt: 1 }];
      linksByOwner.set("profile-1", links);
      const admin = createClient("profile-admin", ["operator.admin"]);
      let caller = admin;
      if (reason === "disconnected") {
        clients.delete(admin);
      } else if (reason === "agent caller") {
        admin.internal = { syntheticClient: true };
      } else if (reason === "synthetic system actor") {
        admin.internal = { syntheticClient: true, operatorRoleActor: { kind: "system" } };
      } else if (reason === "delegated operator actor") {
        admin.internal = { operatorRoleActor: { kind: "operator", profileId: "profile-admin" } };
      } else if (reason === "system actor without a profile") {
        delete admin.authenticatedUserProfile;
        admin.internal = { operatorRoleActor: { kind: "system" } };
      } else if (reason === "copied client") {
        caller = { ...admin };
      } else if (reason === "agent tool caller") {
        admin.internal = { agentToolCaller: { agentId: "main", sessionKey: "agent:main:test" } };
      }
      const results = [];
      for (const [method, params] of [
        ["users.selectModelAccount", { authProfileId: "personal:profile-1:saved" }],
        ["users.listAuthLinks", {}],
        ["users.linkAuthProfile", { authProfileId: "openai:shared" }],
        ["users.unlinkAuthProfile", { provider: "openai" }],
      ] as const) {
        results.push((await rpc(method, { ...params, profileId: "profile-1" }, caller)).mock.calls);
      }
      expect(results).toEqual(
        Array.from({ length: 4 }, () => [
          [false, undefined, expect.objectContaining({ code: "FORBIDDEN" })],
        ]),
      );
      expect(linksByOwner.get("profile-1")).toEqual(links);
      expect(await status(flow)).toMatchObject({ status: "pending" });
      expect(setUserProfileAuthLink).not.toHaveBeenCalled();
      expect(clearUserProfileAuthLink).not.toHaveBeenCalled();
      expect(broadcast).not.toHaveBeenCalled();
      expect(writes).toEqual([]);
    },
  );

  it.each(["shared", "personal", "config-declared"] as const)(
    "lets an identified administrator attach a %s credential and retire the old sign-in",
    async (source) => {
      const owner = randomUUID();
      const admin = createClient("profile-admin", ["operator.admin"]);
      const provider = source === "config-declared" ? "amazon-bedrock" : "openai";
      const authProfileId =
        source === "personal" ? `personal:${owner}:${randomUUID()}` : `${provider}:shared`;
      if (source === "config-declared") {
        ensureAuthProfileStoreWithoutExternalProfiles.mockReturnValue({ version: 1, profiles: {} });
        setConfig({ auth: { profiles: { [authProfileId]: { provider, mode: "aws-sdk" } } } });
      }
      const flow = await startFlow(owner, admin, provider);
      readUserModelAccountSummary.mockReturnValue({ provider, authProfileId });
      expect(
        await rpc("users.linkAuthProfile", { profileId: owner, authProfileId }, admin),
      ).toHaveBeenCalledWith(true, {
        links: [{ provider, authProfileId, updatedAt: 2 }],
      });
      expect(await status(flow, owner, admin)).toEqual({ status: "cancelled" });
      expect(await rpc("users.listAuthLinks", { profileId: owner }, admin)).toHaveBeenCalledWith(
        true,
        { links: linksByOwner.get(owner) },
      );
      expect(
        await rpc("users.unlinkAuthProfile", { profileId: owner, provider }, admin),
      ).toHaveBeenCalledWith(true, { links: [] });
      expect(linksByOwner.get(owner)).toEqual([]);
      expect(broadcast).toHaveBeenCalledTimes(2);
      expect(writes).toEqual([]);
      if (source === "personal") {
        expect(readUserModelAccountSummary).toHaveBeenCalledWith(
          {
            profileId: owner,
            authProfileId,
          },
          { context: expect.anything() },
        );
        expect(ensureAuthProfileStoreWithoutExternalProfiles).not.toHaveBeenCalled();
      }
    },
  );

  it("keeps failed manual attachments from changing a default or cancelling its sign-in", async () => {
    const flow = await startFlow();
    const params = { profileId: "profile-1", authProfileId: "openai:shared" };
    expect(await rpc("users.linkAuthProfile", params)).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "FORBIDDEN" }),
    );
    const admin = createClient("profile-admin", ["operator.admin"]);
    expect(
      await rpc("users.linkAuthProfile", { ...params, authProfileId: "missing" }, admin),
    ).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: expect.stringContaining("openclaw models auth login"),
      }),
    );
    expect(
      await rpc(
        "users.linkAuthProfile",
        {
          ...params,
          authProfileId: `personal:${randomUUID()}:${randomUUID()}`,
        },
        admin,
      ),
    ).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: expect.stringContaining("your personal account list"),
      }),
    );
    expect(setUserProfileAuthLink).not.toHaveBeenCalled();
    expect(await status(flow)).toMatchObject({ status: "pending" });
    expect(broadcast).not.toHaveBeenCalled();
  });

  it.each(["list", "status", "changed links"] as const)(
    "revalidates disclosure after the %s read settles",
    async (kind) => {
      const flow = kind === "status" ? await startFlow() : undefined;
      if (flow) {
        await complete(flow);
        await terminal(flow, "connected");
      }
      const entered = createDeferredCore();
      const release = createDeferredCore<UserProfileAuthLink[]>();
      listUserProfileAuthLinks.mockImplementationOnce(() => {
        entered.resolve();
        return release.promise;
      });
      const reading = flow ? flowRpc("status", flow) : rpc("users.listModelAccounts", {});
      await entered.promise;
      if (kind === "changed links") {
        modelAccountLinksCurrent.mockReturnValue(false);
      } else {
        self.invalidated = true;
      }
      release.resolve([]);
      expect(await reading).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: kind === "changed links" ? "UNAVAILABLE" : "FORBIDDEN" }),
      );
    },
  );
});
