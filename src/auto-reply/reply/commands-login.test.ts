import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelsAuthLoginFlowOptions } from "../../commands/models/auth.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { patchSessionEntryCore } from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  ProviderAuthConfigApplyError,
  ProviderCredentialsSavedError,
} from "../../shared/provider-auth-result.js";
import { buildBuiltinChatCommands } from "../commands-registry.shared.js";
import type { ReplyPayload } from "../types.js";
import type { HandleCommandsParams } from "./commands-types.js";
import { buildCommandTestParams } from "./commands.test-harness.js";

type SessionPatchArguments = Parameters<typeof patchSessionEntryCore>;
type SessionPatchInvocation = SessionPatchArguments[0] &
  NonNullable<SessionPatchArguments[2]> & { update: SessionPatchArguments[1] };

const runModelsAuthLoginFlowMock = vi.hoisted(() => vi.fn());
const patchSessionEntryMock = vi.hoisted(() =>
  vi.fn<(params: SessionPatchInvocation) => ReturnType<typeof patchSessionEntryCore>>(),
);

vi.mock("../../commands/models/auth.js", () => ({
  runModelsAuthLoginFlowCore: (opts: unknown) => runModelsAuthLoginFlowMock(opts),
}));
vi.mock("../../config/sessions/session-accessor.js", async () => {
  const actual = await vi.importActual<typeof import("../../config/sessions/session-accessor.js")>(
    "../../config/sessions/session-accessor.js",
  );
  return {
    ...actual,
    patchSessionEntryCore: (...[scope, update, options]: SessionPatchArguments) =>
      patchSessionEntryMock({ ...scope, update, ...options }),
  };
});

const { handleLoginCommand } = await import("./commands-login.js");
const { testing } = await import("./commands-login.test-support.js");

function buildLoginParams(
  commandBody: string,
  overrides: {
    command?: Partial<HandleCommandsParams["command"]>;
    ctx?: Partial<HandleCommandsParams["ctx"]>;
    opts?: HandleCommandsParams["opts"];
    sessionKey?: string;
    sessionEntry?: HandleCommandsParams["sessionEntry"];
    sessionStore?: HandleCommandsParams["sessionStore"];
    storePath?: string;
    agentId?: string;
    provider?: string;
  } = {},
): HandleCommandsParams {
  const params = buildCommandTestParams(
    commandBody,
    {
      commands: { text: true, ownerAllowFrom: ["owner"] },
      channels: { slack: { allowFrom: ["owner"] } },
      session: { mainKey: "main" },
    } as OpenClawConfig,
    {
      Provider: "slack",
      Surface: "slack",
      OriginatingChannel: "slack",
      OriginatingTo: "direct:owner",
      AccountId: "workspace-a",
      ChatType: "direct",
      MessageThreadId: "thread-1",
      ...overrides.ctx,
    },
    { workspaceDir: "/tmp/openclaw-login-test" },
  );
  params.sessionKey = overrides.sessionKey ?? "agent:main:slack:channel:C123";
  params.agentId = overrides.agentId ?? params.agentId;
  params.provider = overrides.provider ?? "openai";
  params.command = {
    ...params.command,
    channel: "slack",
    channelId: "slack",
    accountId: "workspace-a",
    senderId: "owner",
    senderIsOwner: true,
    isAuthorizedSender: true,
    from: "slack:owner",
    to: "direct:owner",
    ...overrides.command,
  };
  params.opts = overrides.opts;
  if (overrides.sessionEntry !== undefined) {
    params.sessionEntry = overrides.sessionEntry;
    params.sessionStore = overrides.sessionStore ?? {
      [params.sessionKey]: overrides.sessionEntry,
    };
  }
  params.storePath = overrides.storePath;
  return params;
}

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

function blockReplyOpts(): NonNullable<HandleCommandsParams["opts"]> {
  return { onBlockReply: vi.fn(async () => {}) };
}

describe("handleLoginCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testing.clearActiveFlows();
  });

  afterEach(() => clearRuntimeConfigSnapshot());

  it.each(["host", "runtime"])(
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
      "OpenAI credentials were saved, but sign-in did not finish. Send `/login openai/openai-device-code` to retry.",
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
      write.assertCommitAllowed?.();
      persisted = patch ? { ...previous, ...patch } : previous;
      return persisted;
    });

    const result = await handleLoginCommand(params, true);

    expect(result?.reply?.text).toContain("login completed, but this session could not switch");
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
      write.assertCommitAllowed?.();
      const persisted = patch ? { ...previous, ...patch } : previous;
      setRuntimeConfigSnapshot({ ...params.cfg, commands: { ownerAllowFrom: ["replacement"] } });
      return persisted;
    });

    const result = await handleLoginCommand(params, true);

    expect(result?.reply?.text).toBe("OpenAI login complete. Try your request again now.");
    expect(params.sessionEntry?.authProfileOverride).toBe("openai:saved");
  });

  it.each(["web", "telegram", "discord", "slack"])(
    "shows a provider menu without starting sign-in for bare /login on %s",
    async (surface) => {
      mockSuccessfulLoginFlow();
      const params = buildLoginParams("/login", {
        command: { channel: surface },
        ctx: { Provider: surface, Surface: surface, ChatType: "direct" },
        opts: blockReplyOpts(),
      });
      const result = await handleLoginCommand(params, true);
      expect(result?.reply?.text).toContain("Choose a provider");
      expect(runModelsAuthLoginFlowMock).not.toHaveBeenCalled();
    },
  );

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

  it("shows the provider methods before starting a selected provider", async () => {
    const result = await handleLoginCommand(buildLoginParams("/login oauth/openai/openai"), true);
    expect(result?.reply?.text).toContain("Choose how to connect");
    expect(result?.reply?.text).toContain("/login openai/openai-device-code");
    expect(runModelsAuthLoginFlowMock).not.toHaveBeenCalled();
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

  it("hands setup-only secret input to Configure Models", async () => {
    const result = await handleLoginCommand(buildLoginParams("/login openai/openai-api-key"), true);
    expect(result?.reply?.text).toContain("Models → Configure Models");
    expect(runModelsAuthLoginFlowMock).not.toHaveBeenCalled();
  });

  it("registers /login as a built-in command handler", () => {
    expect(buildBuiltinChatCommands().find((entry) => entry.key === "login")).toMatchObject({
      nativeName: "login",
      nativeProviders: ["discord", "slack", "telegram"],
      textAliases: ["/login"],
      scope: "both",
    });
  });

  it("starts Codex device-code login and emits the pairing code through block delivery", async () => {
    const onBlockReply = vi.fn(async () => {});
    mockSuccessfulLoginFlow();

    const result = await handleLoginCommand(
      buildLoginParams("/login codex", { opts: { onBlockReply } }),
      true,
    );

    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "OpenAI login complete. Try your request again now." },
    });
    expect(onBlockReply).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("ABCD-EFGH"),
      }),
    );
    expect(runModelsAuthLoginFlowMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        method: "device-code",
        agent: "main",
        isRemote: true,
      }),
    );
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
      buildLoginParams("/login openrouter", {
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

  it.each(["web", "discord", "slack"] as const)(
    "supports /login codex on the %s command surface",
    async (surface) => {
      const onBlockReply = vi.fn(async () => {});
      mockSuccessfulLoginFlow();
      const targetSessionKey = `agent:main:${surface}:direct:owner`;
      const targetSessionEntry = {
        authProfileOverride: "openai:old-owner",
        sessionId: `sess-${surface}`,
        updatedAt: 1,
      };
      const otherSessionEntry = {
        authProfileOverride: "openai:other-owner",
        sessionId: "sess-other",
        updatedAt: 2,
      };
      const sessionStore = {
        [targetSessionKey]: targetSessionEntry,
        "agent:main:other-session": otherSessionEntry,
      };

      const params = buildLoginParams("/login codex", {
        ctx: {
          Provider: surface,
          Surface: surface,
          OriginatingChannel: surface,
          OriginatingTo: "direct:conversation-1",
          ChatType: "direct",
        },
        command: {
          channel: surface,
          channelId: surface,
          to: "direct:conversation-1",
        },
        opts: { onBlockReply },
        sessionKey: targetSessionKey,
        sessionEntry: targetSessionEntry,
        sessionStore,
      });
      const result = await handleLoginCommand(params, true);

      expect(result?.reply?.text).toBe("OpenAI login complete. Try your request again now.");
      expect(onBlockReply).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("https://auth.openai.com/device"),
        }),
      );
      expect(runModelsAuthLoginFlowMock).toHaveBeenCalledWith(
        expect.not.objectContaining({ profileId: expect.any(String) }),
      );
      expect(params.sessionEntry).toMatchObject({
        authProfileOverride: "openai:owner",
        authProfileOverrideSource: "user",
      });
      expect(sessionStore["agent:main:other-session"]).toEqual(otherSessionEntry);
    },
  );

  it.each([
    [
      "gateway-rejected",
      "OpenAI credentials saved, but the Gateway could not apply the auth update. Check the Gateway logs, restart the Gateway, then use /models.",
    ],
    [
      "gateway-unreachable",
      "OpenAI credentials saved, but the Gateway could not be reached to apply them. Restart the Gateway, then use /models.",
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
      "OpenAI credentials saved, but provider settings could not be applied. Review the provider settings and check the Gateway logs before trying again.",
    );
  });

  it.each([undefined, "unknown"])("rejects an invalid refresh outcome %s", async (authRefresh) => {
    runModelsAuthLoginFlowMock.mockResolvedValue({
      providerId: "openai",
      methodId: "device-code",
      authRefresh,
      profiles: [{ profileId: "openai:owner", provider: "openai", mode: "oauth" }],
    });
    const result = await handleLoginCommand(
      buildLoginParams("/login codex", { opts: blockReplyOpts() }),
      true,
    );
    expect(result?.reply?.text).toBe(
      "OpenAI login did not complete. Send `/login openai/openai-device-code` to try again.",
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

  it.each(["/login", "/login codex"])(
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

  it("reports partial success when login returns no requested-provider profile", async () => {
    runModelsAuthLoginFlowMock.mockResolvedValue({
      providerId: "openai",
      methodId: "device-code",
      authRefresh: "refreshed",
      profiles: [],
    });

    const result = await handleLoginCommand(
      buildLoginParams("/login codex", { opts: blockReplyOpts() }),
      true,
    );

    expect(result?.reply?.text).toBe(
      "OpenAI login completed, but this session could not switch to the newly authenticated profile. Retry `/login openai/openai-device-code`, or select the profile manually.",
    );
  });

  it("rejects empty profile identifiers returned by login", async () => {
    runModelsAuthLoginFlowMock.mockResolvedValue({
      providerId: "openai",
      methodId: "device-code",
      authRefresh: "refreshed",
      profiles: [{ profileId: " ", provider: "openai", mode: "oauth" }],
    });

    const result = await handleLoginCommand(
      buildLoginParams("/login codex", { opts: blockReplyOpts() }),
      true,
    );

    expect(result?.reply?.text).toBe(
      "OpenAI login did not complete. Send `/login openai/openai-device-code` to try again.",
    );
  });

  it("normalizes returned login identifiers before switching profiles", async () => {
    runModelsAuthLoginFlowMock.mockResolvedValue({
      providerId: " openai ",
      methodId: " device-code ",
      authRefresh: "refreshed",
      defaultModel: " openai/gpt-5.4 ",
      profiles: [{ profileId: " openai:owner@example.com ", provider: " openai ", mode: "oauth" }],
    });
    const params = buildLoginParams("/login codex", {
      opts: blockReplyOpts(),
      sessionEntry: {
        authProfileOverride: "openai:old-owner@example.com",
        sessionId: "sess-owner",
        updatedAt: 1,
      },
    });

    const result = await handleLoginCommand(params, true);

    expect(result?.reply?.text).toBe("OpenAI login complete. Try your request again now.");
    expect(params.sessionEntry?.authProfileOverride).toBe("openai:owner@example.com");
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

  it("does not pass unrelated pinned profiles into OpenAI login", async () => {
    mockSuccessfulLoginFlow();

    await handleLoginCommand(
      buildLoginParams("/login codex", {
        opts: blockReplyOpts(),
        sessionEntry: {
          authProfileOverride: "anthropic:owner@example.com",
          sessionId: "sess-owner",
          updatedAt: 1,
        },
      }),
      true,
    );

    expect(runModelsAuthLoginFlowMock).toHaveBeenCalledWith(
      expect.not.objectContaining({
        profileId: expect.any(String),
      }),
    );
  });

  it("reports partial success and restores the session when profile persistence fails", async () => {
    mockSuccessfulLoginFlow("openai:new-owner@example.com");
    patchSessionEntryMock.mockRejectedValueOnce(new Error("write failed"));
    const previousEntry = {
      authProfileOverride: "openai:old-owner@example.com",
      authProfileOverrideSource: "user" as const,
      sessionId: "sess-owner",
      updatedAt: 1,
    };
    const sessionStore = {
      "agent:main:slack:channel:C123": previousEntry,
      "agent:main:other-session": {
        authProfileOverride: "openai:other-owner@example.com",
        sessionId: "sess-other",
        updatedAt: 2,
      },
    };
    const params = buildLoginParams("/login codex", {
      opts: blockReplyOpts(),
      sessionEntry: previousEntry,
      sessionStore,
      storePath: "/tmp/openclaw-login-sessions.json",
    });

    const result = await handleLoginCommand(params, true);

    expect(result?.reply?.text).toBe(
      "OpenAI login completed, but this session could not switch to the newly authenticated profile. Retry `/login openai/openai-device-code`, or select the profile manually.",
    );
    expect(params.sessionEntry).toBe(previousEntry);
    expect(sessionStore["agent:main:slack:channel:C123"]).toBe(previousEntry);
    expect(sessionStore["agent:main:other-session"]?.authProfileOverride).toBe(
      "openai:other-owner@example.com",
    );
  });

  it("does not overwrite a profile selected while device login is in progress", async () => {
    mockSuccessfulLoginFlow("openai:new-owner@example.com");
    const previousEntry = {
      authProfileOverride: "openai:old-owner@example.com",
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
    const sessionStore = {
      "agent:main:slack:channel:C123": previousEntry,
    };
    const params = buildLoginParams("/login codex", {
      opts: blockReplyOpts(),
      sessionEntry: previousEntry,
      sessionStore,
      storePath: "/tmp/openclaw-login-sessions.json",
    });

    const result = await handleLoginCommand(params, true);

    expect(result?.reply?.text).toBe(
      "OpenAI login completed, but this session could not switch to the newly authenticated profile. Retry `/login openai/openai-device-code`, or select the profile manually.",
    );
    expect(params.sessionEntry).toBe(previousEntry);
    expect(sessionStore["agent:main:slack:channel:C123"]).toBe(previousEntry);
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
      "OpenAI login completed, but this session could not switch to the newly authenticated profile. Retry `/login openai/openai-device-code`, or select the profile manually.",
    );
    expect(params.sessionEntry).toBe(previousEntry);
  });

  it("dedupes an active flow for the same channel thread and provider", async () => {
    let resolveLogin!: () => void;
    runModelsAuthLoginFlowMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveLogin = () =>
            resolve({
              providerId: "openai",
              methodId: "device-code",
              authRefresh: "refreshed",
              profiles: [],
            });
        }),
    );

    const first = handleLoginCommand(
      buildLoginParams("/login codex", { opts: blockReplyOpts() }),
      true,
    );
    const second = await handleLoginCommand(
      buildLoginParams("/login codex", { opts: blockReplyOpts() }),
      true,
    );

    expect(second).toEqual({
      shouldContinue: false,
      reply: {
        text: "A provider login is already active for this chat. Complete it, or send `/login cancel` before requesting a new one.",
      },
    });
    resolveLogin();
    await first;
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
    expect(second?.reply?.text).toContain("could not switch");
    now.mockRestore();
  });

  it("rejects non-owner senders before starting login", async () => {
    const result = await handleLoginCommand(
      buildLoginParams("/login codex", {
        command: { senderIsOwner: false },
      }),
      true,
    );

    expect(result).toEqual({
      shouldContinue: false,
      reply: {
        text: "Only a configured OpenClaw owner/admin can start provider login from this channel.",
      },
    });
    expect(runModelsAuthLoginFlowMock).not.toHaveBeenCalled();
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
        text: "Only a configured OpenClaw owner/admin can start provider login from this channel.",
      },
    });
    expect(runModelsAuthLoginFlowMock).not.toHaveBeenCalled();
  });

  it("returns a friendly error for unsupported providers", async () => {
    const result = await handleLoginCommand(buildLoginParams("/login unavailable-provider"), true);

    expect(result?.reply?.text).toContain("Unsupported login provider");
    expect(result?.shouldContinue).toBe(false);
    expect(runModelsAuthLoginFlowMock).not.toHaveBeenCalled();
  });
});
