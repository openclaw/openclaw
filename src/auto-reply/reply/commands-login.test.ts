import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
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
  patchSessionEntryMock,
  runModelsAuthLoginFlowMock,
  setupLoginCommandTests,
} from "./commands-login.harness-test-support.js";

const refreshAuthRuntime = vi.hoisted(() => vi.fn<() => Promise<void>>());
vi.mock("../../gateway/model-auth-refresh.js", () => ({
  refreshModelAuthStateAfterMutation: refreshAuthRuntime,
}));

const { handleLoginCommand } = await import("./commands-login.js");
const { handleCommands } = await import("./commands-core.js");

function mockSuccessfulLoginFlow(profileId = "openai:owner", authRefresh = "refreshed"): void {
  runModelsAuthLoginFlowMock.mockImplementation(async (opts: ModelsAuthLoginFlowOptions) => {
    await opts.prompter.note?.(
      "Open https://auth.openai.com/device and enter code ABCD-EFGH. Never share this code.",
      "Codex login",
    );
    return {
      providerId: "openai",
      methodId: "device-code",
      authRefresh,
      profiles: [{ profileId, provider: "openai", mode: "oauth" }],
    };
  });
}

describe("handleLoginCommand", () => {
  setupLoginCommandTests();

  it.each([
    {
      name: "denied owner",
      senderIsOwner: false,
      chatType: "direct",
      message:
        "Only an OpenClaw owner can sign in here. Ask the owner to connect this provider or grant you owner access.",
      refreshCount: 0,
    },
    {
      name: "public chat",
      senderIsOwner: true,
      chatType: "group",
      message:
        "Provider login requires a private chat or Control UI session. Open a private chat with OpenClaw and send `/login` there.",
      refreshCount: 0,
    },
    {
      name: "authorized private chat",
      senderIsOwner: true,
      chatType: "direct",
      message: "Sign-in status refreshed. Send /models to see available models.",
      refreshCount: 1,
    },
  ])("handles registered /login refresh for $name without signing in again", async (scenario) => {
    const params = buildLoginParams("/login refresh", {
      command: { senderIsOwner: scenario.senderIsOwner },
      ctx: { ChatType: scenario.chatType },
    });
    const result = await handleCommands({
      ...params,
      resolveModelLevels: async () => ({
        resolvedThinkLevel: params.resolvedThinkLevel,
        resolvedReasoningLevel: params.resolvedReasoningLevel,
      }),
    });

    expect(result).toMatchObject({ shouldContinue: false, reply: { text: scenario.message } });
    expect(refreshAuthRuntime).toHaveBeenCalledTimes(scenario.refreshCount);
    expect(runModelsAuthLoginFlowMock).not.toHaveBeenCalled();
  });

  it("keeps registered login pending until saved credentials finish refreshing", async () => {
    const refreshing = createDeferredCore();
    const applied = createDeferredCore();
    refreshAuthRuntime.mockImplementationOnce(async () => {
      refreshing.resolve();
      await applied.promise;
    });
    runModelsAuthLoginFlowMock.mockImplementationOnce(async (opts: ModelsAuthLoginFlowOptions) => {
      await expectDefined(opts.refreshAfterLogin, "registered login refresh callback")("main");
      return {
        providerId: "openai",
        methodId: "device-code",
        authRefresh: "refreshed",
        profiles: [{ profileId: "openai:owner", provider: "openai", mode: "oauth" }],
      };
    });
    const params = buildLoginParams("/login openai", { opts: blockReplyOpts() });
    const login = handleCommands({
      ...params,
      resolveModelLevels: async () => ({
        resolvedThinkLevel: params.resolvedThinkLevel,
        resolvedReasoningLevel: params.resolvedReasoningLevel,
      }),
    });
    try {
      expect(
        await Promise.race([
          refreshing.promise.then(() => "refreshing"),
          login.then(() => "completed"),
        ]),
      ).toBe("refreshing");
      expect(
        await Promise.race([login.then(() => "completed"), nextEventLoopTurn("pending")]),
      ).toBe("pending");
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

  it.each(["host"])(
    "rejects an owner revoked before flow entry using the %s config reader",
    async (source) => {
      mockSuccessfulLoginFlow();
      const currentConfig: OpenClawConfig = { commands: { ownerAllowFrom: ["replacement"] } };
      const params = buildLoginParams("/login codex", {
        opts: {
          ...blockReplyOpts(),
          ...(source === "host" ? { getProviderLoginConfig: () => currentConfig } : {}),
        },
      });
      setRuntimeConfigSnapshot(source === "host" ? params.cfg : currentConfig);

      const result = await handleLoginCommand(params, true);

      expect(result?.reply?.text).toContain("login did not complete");
      expect(runModelsAuthLoginFlowMock).not.toHaveBeenCalled();
    },
  );

  it("reports saved credentials when a later sign-in step fails", async () => {
    runModelsAuthLoginFlowMock.mockRejectedValueOnce(
      new ProviderCredentialsSavedError(
        "Provider credentials were saved, but sign-in did not finish.",
        {
          cause: new Error("Owner revoked after save"),
        },
      ),
    );
    const result = await handleLoginCommand(
      buildLoginParams("/login codex", { opts: blockReplyOpts() }),
      true,
    );
    expect(result?.reply?.text).toBe(
      "Some OpenAI sign-in details were saved, but setup is incomplete. Open Models to review the saved connection and finish setup.",
    );
    expect(patchSessionEntryMock).not.toHaveBeenCalled();
  });

  it("rejects a removed owner despite the command's retained owner context", async () => {
    const params = buildLoginParams("/login codex", {
      opts: blockReplyOpts(),
      ctx: { OwnerAllowFrom: ["owner"] },
    });
    setRuntimeConfigSnapshot(params.cfg);
    const persist = vi.fn();
    runModelsAuthLoginFlowMock.mockImplementationOnce(async (opts: ModelsAuthLoginFlowOptions) => {
      await Promise.resolve();
      setRuntimeConfigSnapshot({ ...params.cfg, commands: { ownerAllowFrom: ["replacement"] } });
      opts.assertCurrent?.();
      persist();
      return {
        providerId: "openai",
        methodId: "device-code",
        authRefresh: "refreshed",
        profiles: [],
      };
    });
    const result = await handleLoginCommand(params, true);
    expect(runModelsAuthLoginFlowMock).toHaveBeenCalledOnce();
    expect(result?.reply?.text).toContain("login did not complete");
    expect(result?.shouldContinue).toBe(false);
    expect(persist).not.toHaveBeenCalled();
  });

  it("rejects revoked Gateway authority at credential persistence", async () => {
    let revoked = false;
    const persist = vi.fn();
    runModelsAuthLoginFlowMock.mockImplementationOnce(async (opts: ModelsAuthLoginFlowOptions) => {
      await Promise.resolve();
      revoked = true;
      opts.assertCurrent?.();
      persist();
      return {
        providerId: "openai",
        methodId: "device-code",
        authRefresh: "refreshed",
        profiles: [],
      };
    });
    const result = await handleLoginCommand(
      buildLoginParams("/login codex", {
        opts: {
          ...blockReplyOpts(),
          assertProviderLoginAuthority: () => {
            if (revoked) {
              throw new Error("Gateway authority was revoked.");
            }
          },
        },
      }),
      true,
    );
    expect(runModelsAuthLoginFlowMock).toHaveBeenCalledOnce();
    expect(result?.reply?.text).toContain("login did not complete");
    expect(persist).not.toHaveBeenCalled();
  });

  it("keeps the prior session pin when the owner is revoked after patch preparation", async () => {
    mockSuccessfulLoginFlow("openai:saved");
    const previous: SessionEntry = {
      sessionId: "revoked-owner-session",
      updatedAt: 1,
      authProfileOverride: "openai:prior",
      authProfileOverrideSource: "user",
    };
    const params = buildLoginParams("/login codex", {
      opts: blockReplyOpts(),
      sessionEntry: previous,
      storePath: "/tmp/openclaw-login-sessions.json",
    });
    setRuntimeConfigSnapshot(params.cfg);
    let persisted = previous;
    patchSessionEntryMock.mockImplementationOnce(async (write) => {
      const patch = await write.update({ ...previous }, { existingEntry: { ...previous } });
      setRuntimeConfigSnapshot({ ...params.cfg, commands: { ownerAllowFrom: ["replacement"] } });
      write.workerGuard?.source?.();
      write.assertCommitAllowed?.();
      persisted = patch ? { ...previous, ...patch } : previous;
      return persisted;
    });

    const result = await handleLoginCommand(params, true);

    expect(result?.reply?.text).toContain("login complete. This chat kept its previous account");
    expect(persisted).toBe(previous);
    expect(params.sessionEntry).toBe(previous);
  });

  it("keeps the committed pin result when ownership changes after commit", async () => {
    mockSuccessfulLoginFlow("openai:saved");
    const previous: SessionEntry = {
      sessionId: "committed-owner-session",
      updatedAt: 1,
      authProfileOverride: "openai:prior",
      authProfileOverrideSource: "user",
    };
    const params = buildLoginParams("/login codex", {
      opts: blockReplyOpts(),
      sessionEntry: previous,
      storePath: "/tmp/openclaw-login-sessions.json",
    });
    setRuntimeConfigSnapshot(params.cfg);
    patchSessionEntryMock.mockImplementationOnce(async (write) => {
      const patch = await write.update({ ...previous }, { existingEntry: { ...previous } });
      write.workerGuard?.source?.();
      write.assertCommitAllowed?.();
      const persisted = patch ? { ...previous, ...patch } : previous;
      setRuntimeConfigSnapshot({ ...params.cfg, commands: { ownerAllowFrom: ["replacement"] } });
      return persisted;
    });

    const result = await handleLoginCommand(params, true);

    expect(result?.reply?.text).toBe("OpenAI login complete. Try your request again now.");
    expect(params.sessionEntry?.authProfileOverride).toBe("openai:saved");
  });

  it("keeps the current session profile when connecting another provider", async () => {
    mockSuccessfulLoginFlow();
    const params = buildLoginParams("/login codex", {
      provider: "anthropic",
      opts: blockReplyOpts(),
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
    const params = buildLoginParams("/login codex", {
      opts: blockReplyOpts(),
      sessionEntry: { sessionId: "pending-login", updatedAt: 1, authProfileOverride: "openai:old" },
    });
    runModelsAuthLoginFlowMock.mockImplementationOnce(async () => {
      params.sessionStore![params.sessionKey] = {
        ...params.sessionEntry!,
        providerOverride: "anthropic",
        authProfileOverride: "anthropic:selected",
      };
      return {
        providerId: "openai",
        methodId: "device-code",
        authRefresh: "refreshed",
        profiles: [{ profileId: "openai:new", provider: "openai", mode: "oauth" }],
      };
    });
    await handleLoginCommand(params, true);
    expect(params.sessionStore?.[params.sessionKey]?.authProfileOverride).toBe(
      "anthropic:selected",
    );
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
    let finishLogin!: () => void;
    const approval = new Promise<void>((resolve) => {
      finishLogin = resolve;
    });
    let receiveReply!: (reply: ReplyPayload) => void;
    const preview = new Promise<ReplyPayload>((resolve) => {
      receiveReply = resolve;
    });
    runModelsAuthLoginFlowMock.mockImplementationOnce(async (opts: ModelsAuthLoginFlowOptions) => {
      await opts.openUrl?.(url);
      await approval;
      return {
        providerId: "openrouter",
        methodId: "oauth",
        authRefresh: "refreshed",
        profiles: [{ profileId: "openrouter:default", provider: "openrouter", mode: "api_key" }],
      };
    });
    const login = handleLoginCommand(
      buildLoginParams("/login openrouter/openrouter-oauth", {
        opts: { onBlockReply: async (reply) => receiveReply(reply) },
      }),
      true,
    );
    try {
      const first = await Promise.race([
        preview.then((reply) => ({ state: "preview", reply })),
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
      finishLogin();
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
    await handleLoginCommand(buildLoginParams("/login codex", { opts: options }), true);
    expect(providerSignal?.aborted).toBe(true);
    expect(options.onBlockReply).not.toHaveBeenCalled();
  });

  it.each([
    [
      "gateway-unreachable",
      "OpenAI credentials are saved. Sign-in status could not be confirmed. Send /login refresh to update it; you do not need to sign in again.",
    ],
  ])("reports saved credentials when auth refresh is %s", async (outcome, message) => {
    mockSuccessfulLoginFlow("openai:owner", outcome);
    const result = await handleLoginCommand(
      buildLoginParams("/login codex", { opts: blockReplyOpts() }),
      true,
    );
    expect(result?.reply?.text).toBe(message);
  });

  it("distinguishes saved credentials from failed provider settings", async () => {
    runModelsAuthLoginFlowMock.mockRejectedValue(
      new ProviderAuthConfigApplyError(new Error("config write failed")),
    );
    const result = await handleLoginCommand(
      buildLoginParams("/login codex", { opts: blockReplyOpts() }),
      true,
    );
    expect(result?.reply?.text).toBe(
      "OpenAI credentials are saved, but the connection settings could not be applied. Open Models to review the connection settings and try again.",
    );
  });

  it("rejects dispatcher-less contexts before starting device-code polling", async () => {
    mockSuccessfulLoginFlow();

    const result = await handleLoginCommand(buildLoginParams("/login codex"), true);

    expect(result?.reply?.text).toBe(
      "OpenAI login needs a live private response path so the code can be shown before it expires. Use the Control UI or a private chat and send `/login openai/openai-device-code` again.",
    );
    expect(runModelsAuthLoginFlowMock).not.toHaveBeenCalled();
  });

  it.each(["/login codex"])(
    "rejects public %s before showing choices or codes",
    async (command) => {
      const onBlockReply = vi.fn(async () => {});
      mockSuccessfulLoginFlow();
      const params = buildLoginParams(command, {
        ctx: {
          Provider: "slack",
          Surface: "slack",
          OriginatingChannel: "slack",
          OriginatingTo: "channel:C123",
          ChatType: "channel",
        },
        command: {
          channel: "slack",
          to: "channel:C123",
        },
        opts: { onBlockReply },
      });
      params.isGroup = true;

      const result = await handleLoginCommand(params, true);

      expect(result).toEqual({
        shouldContinue: false,
        reply: {
          text: "Provider login requires a private chat or Control UI session. Open a private chat with OpenClaw and send `/login` there.",
        },
      });
      expect(onBlockReply).not.toHaveBeenCalled();
      expect(runModelsAuthLoginFlowMock).not.toHaveBeenCalled();
    },
  );

  it("moves a pinned session to the canonical profile returned by login", async () => {
    mockSuccessfulLoginFlow("openai:new-owner@example.com");
    const previousEntry = {
      authProfileOverride: "openai:owner@example.com",
      sessionId: "sess-owner",
      updatedAt: 1,
    };
    patchSessionEntryMock.mockImplementationOnce(async (params) => {
      const patch = await params.update(
        { ...previousEntry },
        { existingEntry: { ...previousEntry } },
      );
      params.assertCommitAllowed?.();
      return patch ? { ...previousEntry, ...patch } : previousEntry;
    });
    const params = buildLoginParams("/login codex", {
      opts: blockReplyOpts(),
      sessionEntry: previousEntry,
      storePath: "/tmp/openclaw-login-sessions.json",
    });

    await handleLoginCommand(params, true);

    expect(params.opts?.onBlockReply).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining("ABCD-EFGH") }),
    );
    expect(runModelsAuthLoginFlowMock).toHaveBeenCalledWith(
      expect.not.objectContaining({ profileId: expect.any(String) }),
    );
    expect(params.sessionEntry).toMatchObject({
      authProfileOverride: "openai:new-owner@example.com",
      authProfileOverrideSource: "user",
    });
    expect(patchSessionEntryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:slack:channel:C123",
        storePath: "/tmp/openclaw-login-sessions.json",
        requireWriteSuccess: true,
      }),
    );
  });

  it("marks a same-profile explicit login as user-selected", async () => {
    mockSuccessfulLoginFlow("openai:owner@example.com");
    const params = buildLoginParams("/login codex", {
      opts: blockReplyOpts(),
      sessionEntry: {
        authProfileOverride: "openai:owner@example.com",
        authProfileOverrideSource: "auto",
        authProfileOverrideCompactionCount: 3,
        sessionId: "sess-owner",
        updatedAt: 1,
      },
    });

    await handleLoginCommand(params, true);

    expect(params.sessionEntry).toMatchObject({
      authProfileOverride: "openai:owner@example.com",
      authProfileOverrideSource: "user",
    });
    expect(params.sessionEntry?.authProfileOverrideCompactionCount).toBeUndefined();
  });

  it("revalidates an unchanged profile after device login", async () => {
    mockSuccessfulLoginFlow("openai:owner@example.com");
    const previousEntry = {
      authProfileOverride: "openai:owner@example.com",
      authProfileOverrideSource: "user" as const,
      sessionId: "sess-owner",
      updatedAt: 1,
    };
    const concurrentlySelectedEntry = {
      ...previousEntry,
      authProfileOverride: "openai:concurrent-owner@example.com",
      updatedAt: 2,
    };
    patchSessionEntryMock.mockImplementationOnce(async (params) => {
      const patch = await params.update(
        { ...concurrentlySelectedEntry },
        { existingEntry: { ...concurrentlySelectedEntry } },
      );
      params.assertCommitAllowed?.();
      return patch ? { ...concurrentlySelectedEntry, ...patch } : concurrentlySelectedEntry;
    });
    const params = buildLoginParams("/login codex", {
      opts: blockReplyOpts(),
      sessionEntry: previousEntry,
      storePath: "/tmp/openclaw-login-sessions.json",
    });

    const result = await handleLoginCommand(params, true);

    expect(result?.reply?.text).toBe(
      'OpenAI login complete. This chat kept its previous account. To use the new sign-in, send `/model "openai/test-model"@"openai:owner@example.com" -s`.',
    );
    expect(params.sessionEntry).toBe(previousEntry);
  });

  it("names the pending provider and lets the owner cancel before another sign-in", async () => {
    const started = createDeferredCore();
    const finish = createDeferredCore();
    runModelsAuthLoginFlowMock.mockImplementationOnce(async (opts: ModelsAuthLoginFlowOptions) => {
      started.resolve();
      await finish.promise;
      opts.signal?.throwIfAborted();
      return {
        providerId: "openai",
        methodId: "device-code",
        authRefresh: "refreshed",
        profiles: [{ profileId: "openai:owner", provider: "openai", mode: "oauth" }],
      };
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
    runModelsAuthLoginFlowMock.mockResolvedValueOnce({
      providerId: "openrouter",
      methodId: "oauth",
      authRefresh: "refreshed",
      profiles: [{ profileId: "openrouter:default", provider: "openrouter", mode: "api_key" }],
    });
    const restarted = await command("/login openrouter/openrouter-oauth");
    expect(restarted?.reply?.text).toContain("OpenRouter login complete");
  });

  it("cancels only the initiating Control UI session when chats have no delivery target", async () => {
    let finishLogin!: () => void;
    const pending = new Promise<void>((resolve) => {
      finishLogin = resolve;
    });
    const signals: AbortSignal[] = [];
    runModelsAuthLoginFlowMock.mockImplementation(async (opts: ModelsAuthLoginFlowOptions) => {
      if (!opts.signal) {
        throw new Error("expected login signal");
      }
      signals.push(opts.signal);
      await pending;
      return {
        providerId: "openai",
        methodId: "device-code",
        authRefresh: "refreshed",
        profiles: [],
      };
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
      finishLogin();
      await Promise.all([first, other]);
    }
  });

  it("cancels an expired flow before replacing its reservation", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    let firstSignal: AbortSignal | undefined;
    runModelsAuthLoginFlowMock
      .mockImplementationOnce(async (opts: ModelsAuthLoginFlowOptions) => {
        firstSignal = opts.signal;
        if (!firstSignal) {
          throw new Error("expected reservation signal");
        }
        const signal = firstSignal;
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () =>
              reject(
                signal.reason instanceof Error ? signal.reason : new Error("Codex login cancelled"),
              ),
            { once: true },
          );
        });
        throw new Error("unreachable");
      })
      .mockResolvedValueOnce({
        providerId: "openai",
        methodId: "device-code",
        authRefresh: "refreshed",
        profiles: [],
      });

    const first = handleLoginCommand(
      buildLoginParams("/login codex", { opts: blockReplyOpts() }),
      true,
    );
    await vi.waitFor(() => expect(firstSignal).toBeDefined());
    now.mockReturnValue(15 * 60_000 + 1_001);

    const second = await handleLoginCommand(
      buildLoginParams("/login codex", { opts: blockReplyOpts() }),
      true,
    );

    expect(firstSignal?.aborted).toBe(true);
    await expect(first).resolves.toEqual({
      shouldContinue: false,
      reply: {
        text: "OpenAI login did not complete. Send `/login openai/openai-device-code` to try again.",
      },
    });
    expect(second?.reply?.text).toBe(
      "OpenAI login complete. This chat kept its previous account. Send /models to review the available models.",
    );
    now.mockRestore();
  });

  it("rejects allowlisted senders when no command owner is configured", async () => {
    const params = buildLoginParams("/login codex", {
      command: {
        senderIsOwner: true,
        isAuthorizedSender: true,
      },
    });
    params.cfg = {
      ...params.cfg,
      commands: { text: true },
    } as OpenClawConfig;

    const result = await handleLoginCommand(params, true);

    expect(result).toEqual({
      shouldContinue: false,
      reply: {
        text: "No chat owner is configured. Ask the OpenClaw owner to add your chat account to `commands.ownerAllowFrom` in the OpenClaw configuration, then send `/login` again.",
      },
    });
    expect(runModelsAuthLoginFlowMock).not.toHaveBeenCalled();
  });
});
