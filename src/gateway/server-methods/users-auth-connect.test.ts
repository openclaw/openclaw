import { describe, expect, it, vi } from "vitest";
import type { AuthProfileCredential } from "../../agents/auth-profiles/types.js";
import type { GatewayOperatorRoleDefinition } from "../../config/types.gateway.js";
import type { ProviderAuthResult } from "../../plugins/types.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  setupModelAccountConnectTest,
  resolveUserProfileId,
  prepareUserProfileSelectionAuthority,
  connectUserModelAccount,
  listUserProfileAuthLinks,
  readSelectedUserModelAccount,
  setUserProfileAuthLink,
  clearUserProfileAuthLink,
  ensureAuthProfileStoreWithoutExternalProfiles,
  registerSecretValueForRedaction,
  resolvePersonalAccountAuthMethod,
  exchange,
  credential,
  authorized,
  runAuth,
  broadcast,
  warn,
  service,
  config,
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
  restartService,
} from "./users-auth-connect.test-support.js";

setupModelAccountConnectTest();

describe("users model-account connection lifecycle", () => {
  it.each(["direct", "shared-secret"] as const)(
    "uses the catalog and exact sensitive step for a %s caller without consuming a rejected answer",
    async (caller) => {
      if (caller === "shared-secret") {
        self.internal = { operatorRoleActor: { kind: "system" } };
      }
      expect(
        await rpc("users.authConnect.catalog", { profileId: "profile-1" }),
      ).toHaveBeenCalledWith(true, {
        providers: [
          { id: "openai", label: "OpenAI", methods: [{ id: "oauth", label: "Browser sign-in" }] },
        ],
      });
      const flow = await startFlow();
      const pending = await status(flow);
      const invalid = await flowRpc("answer", flow, {
        stepId: pending.step.id,
        value: "secret-invalid",
      });
      expect(invalid).toHaveBeenCalledWith(true, {
        status: "pending",
        step: pending.step,
        error: expect.any(String),
      });
      expect(JSON.stringify(invalid.mock.calls)).not.toContain("secret-invalid");
      expect(registerSecretValueForRedaction).toHaveBeenCalledWith("secret-invalid");
      expect(exchange).not.toHaveBeenCalled();
      expect(
        await flowRpc("answer", flow, { stepId: "stale", value: "synthetic-code" }),
      ).toHaveBeenCalledWith(true, {
        status: "pending",
        step: pending.step,
        error: expect.any(String),
      });
      await complete(flow);
      const result = await terminal(flow, "connected");
      expect(result).toEqual({
        status: "connected",
        authProfileId: "personal:profile-1:account-1",
        links: [
          { provider: "openai", authProfileId: "personal:profile-1:account-1", updatedAt: 1 },
        ],
      });
      expect(await complete(flow)).toHaveBeenCalledWith(true, result);
      expect(writes).toEqual([credential]);
      expect(exchange).toHaveBeenCalledOnce();
      expect(registerSecretValueForRedaction).toHaveBeenCalledWith("synthetic-code");
      expect(broadcast).toHaveBeenCalledExactlyOnceWith(
        "chat.metadata.changed",
        {},
        { dropIfSlow: true },
      );
    },
  );

  it("keeps server credentials and model defaults outside personal provider execution", async () => {
    setConfig({
      models: {
        providers: {
          openai: { apiKey: "server-only-key", baseUrl: "https://api.example.test", models: [] },
        },
      },
    });
    const flow = await startFlow();
    const ctx = runAuth.mock.calls[0]![0];
    expect(ctx).toMatchObject({
      config: {},
      env: {},
      existingProfiles: [],
      secretInputMode: "plaintext",
      allowSecretRefPrompt: false,
    });
    expect(ctx.agentDir).toBeUndefined();
    expect(ctx.opts).toBeUndefined();
    exchange.mockResolvedValueOnce({
      ...authorized,
      configPatch: { agents: { defaults: { model: "ignored/model" } } },
      defaultModel: "ignored/model",
    });
    await complete(flow);
    await terminal(flow, "connected");
    expect(config.agents).toBeUndefined();
    expect(writes).toEqual([credential]);
  });

  it("offers the privately prepared selected profile without loading shared credentials", async () => {
    const authProfileId = "personal:profile-1:saved";
    readSelectedUserModelAccount.mockResolvedValue({ id: authProfileId, credential });

    await startFlow();

    expect(runAuth.mock.calls[0]?.[0].existingProfiles).toEqual([
      { profileId: authProfileId, credential },
    ]);
    expect(ensureAuthProfileStoreWithoutExternalProfiles).not.toHaveBeenCalled();
  });

  it("retains an unknown write outcome without replaying it on status or answer", async () => {
    connectUserModelAccount.mockRejectedValueOnce(new Error("Worker outcome unknown"));
    const flow = await startFlow();
    await complete(flow);
    expect(await terminal(flow, "failed")).toEqual({ status: "failed", reason: "unavailable" });
    await complete(flow);
    await status(flow);
    expect(connectUserModelAccount).toHaveBeenCalledOnce();
  });

  it("records provider completion while a prompt is open without requiring an answer", async () => {
    const callback = createDeferredCore<ProviderAuthResult>();
    runAuth.mockImplementationOnce(async (ctx) => {
      const input = ctx.prompter.text({ message: "Paste callback", sensitive: true });
      return Promise.race([input.then(() => authorized), callback.promise]);
    });
    const flow = await startFlow();
    callback.resolve(authorized);
    expect(await terminal(flow, "connected")).not.toHaveProperty("step");
    expect(writes).toEqual([credential]);
  });

  it("observes the next provider step after a manual prompt is retired", async () => {
    const manual = new AbortController();
    runAuth.mockImplementationOnce(async (ctx) => {
      await ctx.prompter
        .text({ message: "Manual input", sensitive: true, signal: manual.signal })
        .catch(() => undefined);
      await ctx.prompter.note("Browser authorization received", "Continue sign-in");
      return authorized;
    });
    const flow = await startFlow();
    const first = await status(flow);
    manual.abort(new Error("Browser callback won"));
    await vi.waitFor(async () =>
      expect(await status(flow)).toMatchObject({ status: "pending", step: { type: "note" } }),
    );
    const next = await status(flow);
    expect(next.step.id).not.toBe(first.step.id);
    expect(
      await flowRpc("answer", flow, { stepId: first.step.id, value: "stale" }),
    ).toHaveBeenCalledWith(true, {
      status: "pending",
      step: next.step,
      error: expect.any(String),
    });
    expect(writes).toEqual([]);
    expect(await status(flow)).toEqual(next);
    await flowRpc("answer", flow, { stepId: next.step.id });
    await terminal(flow, "connected");
    expect(writes).toEqual([credential]);
  });

  it("does not replay a rejected step retired during answer validation", async () => {
    const manual = new AbortController();
    runAuth.mockImplementationOnce(async (ctx) => {
      await ctx.prompter
        .text({
          message: "Manual input",
          sensitive: true,
          signal: manual.signal,
          validate: () => {
            // Browser completion retires the prompt before the service resumes
            // from the Promise returned by the synchronous validator's answer.
            queueMicrotask(() => manual.abort(new Error("Browser callback won")));
            return "Rejected answer";
          },
        })
        .catch(() => undefined);
      await ctx.prompter.note("Browser authorization received", "Continue sign-in");
      return authorized;
    });
    const flow = await startFlow();
    const first = await status(flow);
    const response = await flowRpc("answer", flow, {
      stepId: first.step.id,
      value: "rejected-secret",
    });
    expect(response).toHaveBeenCalledWith(true, expect.objectContaining({ status: "pending" }));
    expect(response.mock.calls[0]?.[1]).not.toHaveProperty("error");
    expect(response.mock.calls[0]?.[1]).not.toHaveProperty("step.id", first.step.id);
    await vi.waitFor(async () =>
      expect(await status(flow)).toMatchObject({ status: "pending", step: { type: "note" } }),
    );
    const next = await status(flow);
    await flowRpc("answer", flow, { stepId: next.step.id });
    await terminal(flow, "connected");
    expect(writes).toEqual([credential]);
  });

  it.each(["status", "answer", "cancel"] as const)(
    "replays %s with current links, not the original default",
    async (action) => {
      const flow = await startFlow();
      await complete(flow);
      await terminal(flow, "connected");
      linksByOwner.set("profile-1", []);
      service.supersede("profile-1", "openai");
      expect(
        await flowRpc(action, flow, action === "answer" ? { stepId: "retired" } : {}),
      ).toHaveBeenCalledWith(true, {
        status: "connected",
        authProfileId: "personal:profile-1:account-1",
        links: [],
      });
      expect(writes).toEqual([credential]);
    },
  );

  it.each(["exchange", "identity", "unavailable"] as const)(
    "records a redacted %s failure",
    async (reason) => {
      if (reason === "exchange") {
        exchange.mockRejectedValueOnce(new Error("secret provider detail"));
      }
      if (reason === "identity") {
        exchange.mockResolvedValueOnce({ profiles: [] });
      }
      if (reason === "unavailable") {
        connectUserModelAccount.mockImplementationOnce(() => {
          throw new Error("secret database detail");
        });
      }
      const flow = await startFlow();
      await complete(flow);
      expect(await terminal(flow, "failed")).toEqual({ status: "failed", reason });
      expect(writes).toEqual([]);
    },
  );

  it.each(
    (["before", "during"] as const).flatMap((phase) =>
      (["disconnect", "invalidation", "role", "merge", "answerer disconnect"] as const).map(
        (change) => ({ phase, change }),
      ),
    ),
  )("fences $change $phase provider I/O", async ({ phase, change }) => {
    const writer: GatewayOperatorRoleDefinition = {
      agents: "*",
      scopes: ["operator.write"],
      sessions: { others: "none" },
    };
    setConfig({ gateway: { roles: { default: "writer", definitions: { writer } } } });
    const deferred = createDeferredCore<ProviderAuthResult>();
    if (phase === "during") {
      exchange.mockReturnValueOnce(deferred.promise);
    }
    const ready = createDeferredCore();
    const beforeIo = createDeferredCore();
    if (phase === "before") {
      runAuth.mockImplementationOnce(async (ctx) => {
        const value = await ctx.prompter.text({ message: "Provider credential", sensitive: true });
        ready.resolve();
        await beforeIo.promise;
        ctx.assertCurrent?.();
        return exchange(value, ctx.signal);
      });
    }
    const flow = await startFlow();
    const answerer = change === "answerer disconnect" ? createClient() : self;
    await complete(flow, "profile-1", answerer);
    if (phase === "before") {
      await ready.promise;
    } else {
      await vi.waitFor(() => expect(exchange).toHaveBeenCalledOnce());
    }
    if (change === "disconnect") {
      clients.delete(self);
    }
    if (change === "invalidation") {
      self.invalidated = true;
    }
    if (change === "role") {
      writer.scopes = ["operator.read"];
    }
    if (change === "merge") {
      resolveUserProfileId.mockImplementation((id) => (id === "profile-1" ? "profile-merged" : id));
    }
    if (change === "answerer disconnect") {
      clients.delete(answerer);
    }
    beforeIo.resolve();
    deferred.resolve(authorized);
    await Promise.allSettled([runAuth.mock.results[0]!.value]);
    if (phase === "before") {
      expect(exchange).not.toHaveBeenCalled();
    } else {
      expect(exchange).toHaveResolved();
    }
    // A merged-away owner cannot authorize even an observation of its old operation.
    const observer = createClient("profile-admin", ["operator.admin"]);
    if (change === "merge") {
      expect(await flowRpc("status", flow, {}, "profile-1", observer)).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "FORBIDDEN" }),
      );
      expect(writes).toEqual([]);
      return;
    }
    setConfig({});
    expect(await terminal(flow, "failed", "profile-1", observer)).toEqual({
      status: "failed",
      reason: "authority",
    });
    expect(writes).toEqual([]);
  });

  it.each(["cancel", "supersede", "expiry", "stop"] as const)(
    "fences late credentials after %s",
    async (change) => {
      const deferred = createDeferredCore<ProviderAuthResult>();
      exchange.mockReturnValueOnce(deferred.promise);
      const flow = await startFlow();
      await complete(flow);
      await vi.waitFor(() => expect(exchange).toHaveBeenCalledOnce());
      const signal: AbortSignal = exchange.mock.calls[0]![1];
      if (change === "cancel") {
        await flowRpc("cancel", flow);
      }
      if (change === "supersede") {
        service.supersede("profile-1", "openai");
      }
      if (change === "expiry") {
        vi.spyOn(Date, "now").mockReturnValue(flow.expiresAtMs + 1);
      }
      if (change === "stop") {
        await service.stop();
      }
      deferred.resolve(authorized);
      await vi.waitFor(() => expect(exchange).toHaveResolved());
      if (change === "stop") {
        restartService();
      }
      expect(
        await terminal(flow, change === "expiry" || change === "stop" ? "expired" : "cancelled"),
      ).not.toHaveProperty("step");
      expect(signal.aborted).toBe(true);
      expect(writes).toEqual([]);
    },
  );

  it("retires replaced operations without letting an old cancel affect the new one", async () => {
    const first = await startFlow();
    const replacement = await startFlow();
    expect(await flowRpc("cancel", first)).toHaveBeenCalledWith(true, { status: "cancelled" });
    await complete(replacement);
    await terminal(replacement, "connected");
    expect(writes).toEqual([credential]);
  });

  it("bounds concurrent sign-ins and recovers capacity after cancellation", async () => {
    const admin = createClient("profile-admin", ["operator.admin"]);
    const flows = [];
    for (let index = 0; index < 8; index++) {
      flows.push(await startFlow(`profile-${index}`, admin));
    }
    expect(
      await rpc(
        "users.authConnect.start",
        { profileId: "profile-9", provider: "openai", method: "oauth" },
        admin,
      ),
    ).toHaveBeenCalledWith(false, undefined, expect.objectContaining({ code: "UNAVAILABLE" }));
    await flowRpc("cancel", flows[0]!, {}, "profile-0", admin);
    expect((await startFlow("profile-9", admin)).connectId).toBeTruthy();
  });

  it("uses the same credential boundary for a catalog-provided API key", async () => {
    const keyCredential: AuthProfileCredential = {
      type: "api_key",
      provider: "example-ai",
      key: "synthetic-key",
    };
    resolvePersonalAccountAuthMethod.mockReturnValue({
      id: "api-key",
      label: "API key",
      kind: "api_key",
      run: runAuth,
    });
    exchange.mockResolvedValueOnce({
      profiles: [{ profileId: "ignored-id", credential: keyCredential }],
    });
    const flow = await startFlow("profile-1", self, "example-ai", "api-key");
    await complete(flow);
    await terminal(flow, "connected");
    expect(writes).toEqual([keyCredential]);
    const match = connectUserModelAccount.mock.calls[0]![0].matchesCredential;
    expect(match(keyCredential)).toBe(true);
    expect(match({ ...keyCredential, key: "different" })).toBe(false);
  });

  it("keeps a committed account connected when notification fails", async () => {
    broadcast.mockImplementation(() => {
      throw new Error("socket notification failed");
    });
    const flow = await startFlow();
    await complete(flow);
    await terminal(flow, "connected");
    expect(writes).toEqual([credential]);
    expect(warn).toHaveBeenCalledWith("chat metadata change notification failed");
  });

  it("rejects unavailable methods and unauthorized owners before provider execution", async () => {
    expect(
      await rpc("users.authConnect.start", {
        profileId: "profile-other",
        provider: "openai",
        method: "oauth",
      }),
    ).toHaveBeenCalledWith(false, undefined, expect.objectContaining({ code: "FORBIDDEN" }));
    expect(resolvePersonalAccountAuthMethod).not.toHaveBeenCalled();
    resolvePersonalAccountAuthMethod.mockReturnValueOnce(undefined);
    expect(
      await rpc("users.authConnect.start", {
        profileId: "profile-1",
        provider: "other",
        method: "import-native-login",
      }),
    ).toHaveBeenCalledWith(false, undefined, expect.objectContaining({ code: "INVALID_REQUEST" }));
    expect(runAuth).not.toHaveBeenCalled();
  });

  it.each([
    ["users.authConnect.start", { provider: "openai", method: "oauth" }],
    ["users.listAuthLinks", {}],
    ["users.linkAuthProfile", { authProfileId: "openai:shared" }],
    ["users.unlinkAuthProfile", { provider: "openai" }],
  ] as const)(
    "validates %s before consulting identity, state, or provider code",
    async (method, params) => {
      expect(
        await rpc(method, {
          ...params,
          profileId: "profile-1",
          unexpected: true,
        }),
      ).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "INVALID_REQUEST" }),
      );
      expect(prepareUserProfileSelectionAuthority).not.toHaveBeenCalled();
      expect(resolvePersonalAccountAuthMethod).not.toHaveBeenCalled();
      expect(listUserProfileAuthLinks).not.toHaveBeenCalled();
      expect(setUserProfileAuthLink).not.toHaveBeenCalled();
      expect(clearUserProfileAuthLink).not.toHaveBeenCalled();
    },
  );
});
