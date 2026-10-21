import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import type { ModelsAuthLoginFlowOptions } from "../../commands/models/auth.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  ProviderAuthConfigApplyError,
  ProviderCredentialsSavedError,
} from "../../shared/provider-auth-result.js";
import { buildBuiltinChatCommands } from "../commands-registry.shared.js";
import type { ReplyPayload } from "../types.js";
import {
  blockReplyOpts,
  buildLoginParams,
  dispatchLoginCommand,
  patchSessionEntryMock,
  runModelsAuthLoginFlowMock,
  setupLoginCommandTests,
} from "./commands-login.harness-test-support.js";

const refreshAuthRuntime = vi.hoisted(() => vi.fn<() => Promise<void>>());
vi.mock("../../gateway/model-auth-refresh.js", () => ({
  refreshModelAuthStateAfterMutation: refreshAuthRuntime,
}));

const { handleLoginCommand } = await import("./commands-login.js");
// Cold handler imports are setup work, not part of the login authorization deadline.
await import("./commands-core.js");
await import("./commands-handlers.runtime.js");

const privateChatRequired =
  "Provider login requires a private chat or Control UI session. Open a private chat with OpenClaw and send `/login` there.";
const ownerRequired =
  "Only an OpenClaw owner can sign in here. Ask the owner to connect this provider or grant you owner access.";
const refreshedMessage = "Sign-in status refreshed. Send /models to see available models.";

function stoppedReply(text: string) {
  return { shouldContinue: false, reply: { text } };
}

function loginResult(profileId = "openai:owner", authRefresh = "refreshed") {
  const provider = profileId.split(":")[0];
  return {
    providerId: provider,
    methodId: provider === "openrouter" ? "oauth" : "device-code",
    authRefresh,
    profiles: [{ profileId, provider, mode: provider === "openrouter" ? "api_key" : "oauth" }],
  };
}

function loginParams(overrides: Parameters<typeof buildLoginParams>[1] = {}) {
  return buildLoginParams("/login codex", { opts: blockReplyOpts(), ...overrides });
}

function runLogin(overrides: Parameters<typeof buildLoginParams>[1] = {}) {
  return handleLoginCommand(loginParams(overrides), true);
}

function pinnedSession(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    sessionId: "sess-owner",
    updatedAt: 1,
    authProfileOverride: "openai:prior",
    authProfileOverrideSource: "user",
    ...overrides,
  };
}

function persistedLoginParams(sessionEntry: SessionEntry) {
  return loginParams({ sessionEntry, storePath: "/tmp/openclaw-login-sessions.json" });
}

function mockSessionPatch(entry: SessionEntry) {
  patchSessionEntryMock.mockImplementationOnce(async (params) => {
    const patch = await params.update({ ...entry }, { existingEntry: { ...entry } });
    params.assertCommitAllowed?.();
    return patch ? { ...entry, ...patch } : entry;
  });
}

function mockSuccessfulLoginFlow(profileId = "openai:owner", authRefresh = "refreshed"): void {
  runModelsAuthLoginFlowMock.mockImplementation(async (opts: ModelsAuthLoginFlowOptions) => {
    await opts.prompter.note?.("Device code ABCD-EFGH.", "Codex login");
    return loginResult(profileId, authRefresh);
  });
}

setupLoginCommandTests();

it.each([
  ["denied owner", false, "direct", ownerRequired, 0],
  ["public chat", true, "group", privateChatRequired, 0],
  ["authorized private chat", true, "direct", refreshedMessage, 1],
] as const)(
  "handles registered /login refresh for %s without signing in again",
  async (_name, senderIsOwner, chatType, message, refreshCount) => {
    const params = buildLoginParams("/login refresh", {
      command: { senderIsOwner },
      ctx: { ChatType: chatType },
    });
    const result = await dispatchLoginCommand(params);

    expect(result).toMatchObject({ shouldContinue: false, reply: { text: message } });
    expect(refreshAuthRuntime).toHaveBeenCalledTimes(refreshCount);
    expect(runModelsAuthLoginFlowMock).not.toHaveBeenCalled();
  },
);

it("keeps registered login pending until saved credentials finish refreshing", async () => {
  const refreshing = createDeferredCore();
  const applied = createDeferredCore();
  refreshAuthRuntime.mockImplementationOnce(async () => {
    refreshing.resolve();
    await applied.promise;
  });
  runModelsAuthLoginFlowMock.mockImplementationOnce(async (opts: ModelsAuthLoginFlowOptions) => {
    await expectDefined(opts.refreshAfterLogin, "registered login refresh callback")("main");
    return loginResult();
  });
  const params = buildLoginParams("/login openai", { opts: blockReplyOpts() });
  const login = dispatchLoginCommand(params);
  try {
    expect(
      await Promise.race([
        refreshing.promise.then(() => "refreshing"),
        login.then(() => "completed"),
      ]),
    ).toBe("refreshing");
    expect(await Promise.race([login.then(() => "completed"), nextEventLoopTurn("pending")])).toBe(
      "pending",
    );
  } finally {
    applied.resolve();
    await login;
    refreshAuthRuntime.mockReset();
  }
  expect(await login).toMatchObject({
    shouldContinue: false,
    reply: { text: "OpenAI login complete. Try your request again now." },
  });
  expect(runModelsAuthLoginFlowMock).toHaveBeenCalledOnce();
});

it("rejects an owner revoked before flow entry using the host config reader", async () => {
  mockSuccessfulLoginFlow();
  const currentConfig: OpenClawConfig = { commands: { ownerAllowFrom: ["replacement"] } };
  const params = loginParams({
    opts: { ...blockReplyOpts(), getProviderLoginConfig: () => currentConfig },
  });
  setRuntimeConfigSnapshot(params.cfg);

  const result = await handleLoginCommand(params, true);

  expect(result?.reply?.text).toContain("login did not complete");
  expect(runModelsAuthLoginFlowMock).not.toHaveBeenCalled();
});

it.each([
  [
    new ProviderCredentialsSavedError("Credentials saved; sign-in incomplete."),
    "Some OpenAI sign-in details were saved, but setup is incomplete. Open Models to review the saved connection and finish setup.",
  ],
  [
    "gateway-unreachable",
    "OpenAI credentials are saved. Sign-in status could not be confirmed. Send /login refresh to update it; you do not need to sign in again.",
  ],
  [
    new ProviderAuthConfigApplyError(new Error("config write failed")),
    "OpenAI credentials are saved, but the connection settings could not be applied. Open Models to review the connection settings and try again.",
  ],
] as const)("reports saved credentials after %s", async (outcome, message) => {
  if (typeof outcome === "string") {
    mockSuccessfulLoginFlow("openai:owner", outcome);
  } else {
    runModelsAuthLoginFlowMock.mockRejectedValueOnce(outcome);
  }
  expect((await runLogin())?.reply?.text).toBe(message);
  expect(patchSessionEntryMock).not.toHaveBeenCalled();
});

it.each(["configured owner", "Gateway authority"])(
  "rejects revoked %s at credential persistence",
  async (source) => {
    let revoked = false;
    const params = loginParams();
    if (source === "configured owner") {
      params.ctx.OwnerAllowFrom = ["owner"];
      setRuntimeConfigSnapshot(params.cfg);
    } else {
      params.opts = {
        ...blockReplyOpts(),
        assertProviderLoginAuthority: () => {
          if (revoked) {
            throw new Error("Gateway authority was revoked.");
          }
        },
      };
    }
    const persist = vi.fn();
    runModelsAuthLoginFlowMock.mockImplementationOnce(async (opts: ModelsAuthLoginFlowOptions) => {
      await Promise.resolve();
      revoked = true;
      if (source === "configured owner") {
        setRuntimeConfigSnapshot({
          ...params.cfg,
          commands: { ownerAllowFrom: ["replacement"] },
        });
      }
      opts.assertCurrent?.();
      persist();
      return { ...loginResult(), profiles: [] };
    });
    const result = await handleLoginCommand(params, true);
    expect(runModelsAuthLoginFlowMock).toHaveBeenCalledOnce();
    expect(result?.reply?.text).toContain("login did not complete");
    expect(result?.shouldContinue).toBe(false);
    expect(persist).not.toHaveBeenCalled();
  },
);

it.each(["before", "after"])(
  "keeps the correct session pin when the owner is revoked %s commit",
  async (revokedAt) => {
    mockSuccessfulLoginFlow("openai:saved");
    const previous = pinnedSession();
    const params = persistedLoginParams(previous);
    setRuntimeConfigSnapshot(params.cfg);
    let persisted = previous;
    const revoke = () => {
      setRuntimeConfigSnapshot({ ...params.cfg, commands: { ownerAllowFrom: ["replacement"] } });
    };
    patchSessionEntryMock.mockImplementationOnce(async (write) => {
      const patch = await write.update({ ...previous }, { existingEntry: { ...previous } });
      if (revokedAt === "before") {
        revoke();
      }
      write.workerGuard?.source?.();
      write.assertCommitAllowed?.();
      persisted = patch ? { ...previous, ...patch } : previous;
      if (revokedAt === "after") {
        revoke();
      }
      return persisted;
    });
    const result = await handleLoginCommand(params, true);
    if (revokedAt === "before") {
      expect(result?.reply?.text).toContain("login complete. This chat kept its previous account");
      expect(persisted).toBe(previous);
      expect(params.sessionEntry).toBe(previous);
    } else {
      expect(result?.reply?.text).toBe("OpenAI login complete. Try your request again now.");
      expect(params.sessionEntry?.authProfileOverride).toBe("openai:saved");
    }
  },
);

it("keeps the current session profile when connecting another provider", async () => {
  mockSuccessfulLoginFlow();
  const params = loginParams({
    provider: "anthropic",
    sessionEntry: {
      sessionId: "other-provider",
      updatedAt: 1,
      authProfileOverride: "anthropic:owner",
    },
  });
  const result = await handleLoginCommand(params, true);
  expect(result?.reply?.text).toContain("login complete");
  expect(params.sessionEntry?.authProfileOverride).toBe("anthropic:owner");
  expect(patchSessionEntryMock).not.toHaveBeenCalled();
});

it("preserves a provider selected while login is pending", async () => {
  const params = loginParams({
    sessionEntry: { sessionId: "pending-login", updatedAt: 1, authProfileOverride: "openai:old" },
  });
  runModelsAuthLoginFlowMock.mockImplementationOnce(async () => {
    params.sessionStore![params.sessionKey] = {
      ...params.sessionEntry!,
      providerOverride: "anthropic",
      authProfileOverride: "anthropic:selected",
    };
    return loginResult("openai:new");
  });
  await handleLoginCommand(params, true);
  expect(params.sessionStore?.[params.sessionKey]?.authProfileOverride).toBe("anthropic:selected");
  expect(patchSessionEntryMock).not.toHaveBeenCalled();
});

it("registers /login as a built-in command handler", () => {
  expect(buildBuiltinChatCommands().find((entry) => entry.key === "login")).toMatchObject({
    nativeName: "login",
    nativeProviders: ["discord", "slack", "telegram"],
    textAliases: ["/login"],
    scope: "both",
  });
});

it("delivers the OpenRouter sign-in button before login completes", async () => {
  const url = "https://openrouter.ai/auth?code_challenge=test-challenge";
  const approval = createDeferredCore();
  const preview = createDeferredCore<ReplyPayload>();
  runModelsAuthLoginFlowMock.mockImplementationOnce(async (opts: ModelsAuthLoginFlowOptions) => {
    await opts.openUrl?.(url);
    await approval.promise;
    return loginResult("openrouter:default");
  });
  const login = handleLoginCommand(
    buildLoginParams("/login openrouter/openrouter-oauth", {
      opts: { onBlockReply: async (reply) => preview.resolve(reply) },
    }),
    true,
  );
  try {
    const first = await Promise.race([
      preview.promise.then((reply) => ({ state: "preview", reply })),
      login.then((result) => ({ state: "completed", reply: result?.reply })),
    ]);
    expect(first).toMatchObject({
      state: "preview",
      reply: {
        text: expect.stringContaining(url),
        presentationTextMode: "fallback",
        presentation: {
          blocks: expect.arrayContaining([
            {
              type: "buttons",
              buttons: [{ label: "Sign in with OpenRouter", action: { type: "url", url } }],
            },
          ]),
        },
      },
    });
  } finally {
    approval.resolve();
    await login;
  }
});

it("cancels pending provider login with the initiating chat turn", async () => {
  const controller = new AbortController();
  const options = { ...blockReplyOpts(), abortSignal: controller.signal };
  let providerSignal: AbortSignal | undefined;
  runModelsAuthLoginFlowMock.mockImplementationOnce(async (flow: ModelsAuthLoginFlowOptions) => {
    providerSignal = flow.signal;
    controller.abort(new Error("chat cancelled"));
    await flow.prompter.note("Do not deliver this stale sign-in link.");
    return { profiles: [], providerId: "openai", methodId: "device-code" };
  });
  await runLogin({ opts: options });
  expect(providerSignal?.aborted).toBe(true);
  expect(options.onBlockReply).not.toHaveBeenCalled();
});

it.each(["dispatcher-less", "public", "owner-less"] as const)(
  "rejects %s login before showing codes",
  async (scenario) => {
    const onBlockReply = vi.fn(async () => {});
    mockSuccessfulLoginFlow();
    const params = buildLoginParams(
      "/login codex",
      scenario === "public"
        ? {
            ctx: { OriginatingTo: "channel:C123", ChatType: "channel" },
            command: { to: "channel:C123" },
            opts: { onBlockReply },
          }
        : {},
    );
    params.isGroup = scenario === "public";
    if (scenario === "owner-less") {
      params.cfg = { ...params.cfg, commands: { text: true } };
    }
    const message = {
      "dispatcher-less":
        "OpenAI login needs a live private response path so the code can be shown before it expires. Use the Control UI or a private chat and send `/login openai/openai-device-code` again.",
      public: privateChatRequired,
      "owner-less":
        "No chat owner is configured. Ask the OpenClaw owner to add your chat account to `commands.ownerAllowFrom` in the OpenClaw configuration, then send `/login` again.",
    }[scenario];
    const result = await handleLoginCommand(params, true);
    if (scenario === "dispatcher-less") {
      expect(result?.reply?.text).toBe(message);
    } else {
      expect(result).toEqual(stoppedReply(message));
    }
    if (scenario === "public") {
      expect(onBlockReply).not.toHaveBeenCalled();
    }
    expect(runModelsAuthLoginFlowMock).not.toHaveBeenCalled();
  },
);

it.each(["canonical", "same", "concurrently changed"] as const)(
  "adopts the %s login profile safely",
  async (scenario) => {
    const nextProfile =
      scenario === "canonical" ? "openai:new-owner@example.com" : "openai:owner@example.com";
    mockSuccessfulLoginFlow(nextProfile);
    const previousEntry = pinnedSession({
      authProfileOverride: "openai:owner@example.com",
      authProfileOverrideSource:
        scenario === "canonical" ? undefined : scenario === "same" ? "auto" : "user",
      ...(scenario === "same" ? { authProfileOverrideCompactionCount: 3 } : {}),
    });
    const params =
      scenario === "same"
        ? loginParams({ sessionEntry: previousEntry })
        : persistedLoginParams(previousEntry);
    if (scenario !== "same") {
      mockSessionPatch(
        scenario === "canonical"
          ? previousEntry
          : {
              ...previousEntry,
              authProfileOverride: "openai:concurrent-owner@example.com",
              updatedAt: 2,
            },
      );
    }
    const result = await handleLoginCommand(params, true);
    if (scenario === "concurrently changed") {
      expect(result?.reply?.text).toBe(
        'OpenAI login complete. This chat kept its previous account. To use the new sign-in, send `/model "openai/test-model"@"openai:owner@example.com" -s`.',
      );
      expect(params.sessionEntry).toBe(previousEntry);
    } else {
      expect(params.sessionEntry).toMatchObject({
        authProfileOverride: nextProfile,
        authProfileOverrideSource: "user",
      });
      if (scenario === "same") {
        expect(params.sessionEntry?.authProfileOverrideCompactionCount).toBeUndefined();
      } else {
        expect(params.opts?.onBlockReply).toHaveBeenCalledWith(
          expect.objectContaining({ text: expect.stringContaining("ABCD-EFGH") }),
        );
        expect(runModelsAuthLoginFlowMock).toHaveBeenCalledWith(
          expect.not.objectContaining({ profileId: expect.any(String) }),
        );
        expect(patchSessionEntryMock).toHaveBeenCalledWith(
          expect.objectContaining({
            sessionKey: "agent:main:slack:channel:C123",
            storePath: "/tmp/openclaw-login-sessions.json",
            requireWriteSuccess: true,
          }),
        );
      }
    }
  },
);

it("names the pending provider and lets the owner cancel before another sign-in", async () => {
  const started = createDeferredCore();
  const finish = createDeferredCore();
  runModelsAuthLoginFlowMock.mockImplementationOnce(async (opts: ModelsAuthLoginFlowOptions) => {
    started.resolve();
    await finish.promise;
    opts.signal?.throwIfAborted();
    return loginResult();
  });
  const command = (body: string) =>
    handleLoginCommand(buildLoginParams(body, { opts: blockReplyOpts() }), true);
  const first = command("/login codex");
  await started.promise;
  try {
    const blocked = await command("/login openrouter/openrouter-oauth");
    expect(blocked?.reply?.text).toContain("OpenAI");
    expect(blocked?.reply?.text).toContain("/login cancel");
    expect(blocked?.reply?.text).not.toContain("OpenRouter");
    expect(runModelsAuthLoginFlowMock).toHaveBeenCalledOnce();
    const cancelled = await command("/login cancel");
    expect(cancelled?.reply?.text).toContain("cancelled");
  } finally {
    finish.resolve();
    await first;
  }
  runModelsAuthLoginFlowMock.mockResolvedValueOnce(loginResult("openrouter:default"));
  const restarted = await command("/login openrouter/openrouter-oauth");
  expect(restarted?.reply?.text).toContain("OpenRouter login complete");
});

it("cancels only the initiating Control UI session when chats have no delivery target", async () => {
  const pending = createDeferredCore();
  const signals: AbortSignal[] = [];
  runModelsAuthLoginFlowMock.mockImplementation(async (opts: ModelsAuthLoginFlowOptions) => {
    signals.push(expectDefined(opts.signal, "expected login signal"));
    await pending.promise;
    return { ...loginResult(), profiles: [] };
  });
  const params = (sessionKey: string, command = "/login codex") =>
    buildLoginParams(command, {
      sessionKey,
      ctx: {
        Provider: "internal",
        Surface: "internal",
        OriginatingChannel: "internal",
        OriginatingTo: undefined,
        To: undefined,
        AccountId: undefined,
        MessageThreadId: undefined,
      },
      command: {
        channel: "internal",
        channelId: "internal",
        accountId: undefined,
        to: undefined,
      },
      opts: { ...blockReplyOpts(), assertProviderLoginAuthority: vi.fn() },
    });
  const first = handleLoginCommand(params("agent:main:chat:first"), true);
  const other = handleLoginCommand(params("agent:main:chat:other"), true);
  try {
    await vi.waitFor(() => expect(signals).toHaveLength(2));
    const cancelled = await handleLoginCommand(
      params("agent:main:chat:first", "/login cancel"),
      true,
    );
    expect(cancelled?.reply?.text).toBe("Provider login cancelled for this chat.");
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
  } finally {
    pending.resolve();
    await Promise.all([first, other]);
  }
});

it("cancels an expired flow before replacing its reservation", async () => {
  const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
  let firstSignal: AbortSignal | undefined;
  runModelsAuthLoginFlowMock
    .mockImplementationOnce(async (opts: ModelsAuthLoginFlowOptions) => {
      const signal = expectDefined(opts.signal, "expected reservation signal");
      firstSignal = signal;
      return new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("Codex login cancelled")), {
          once: true,
        });
      });
    })
    .mockResolvedValueOnce({ ...loginResult(), profiles: [] });

  const first = runLogin();
  await vi.waitFor(() => expect(firstSignal).toBeDefined());
  now.mockReturnValue(15 * 60_000 + 1_001);

  const second = await runLogin();

  expect(firstSignal?.aborted).toBe(true);
  expect(await first).toEqual(
    stoppedReply(
      "OpenAI login did not complete. Send `/login openai/openai-device-code` to try again.",
    ),
  );
  expect(second?.reply?.text).toBe(
    "OpenAI login complete. This chat kept its previous account. Send /models to review the available models.",
  );
  now.mockRestore();
});
