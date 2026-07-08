import { afterEach, describe, expect, it, vi } from "vitest";
import { SLASH_COMMANDS } from "../../lib/chat/commands.ts";
import {
  applyRemoteSlashCommandsResult,
  resetChatSlashCommandMetadataForTest,
} from "./chat-commands.ts";
import { refreshChatMetadata, resolveChatAvatarUrl, type ChatPageHost } from "./chat-state.ts";

vi.mock("../../app/assistant-identity.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../app/assistant-identity.ts")>()),
  loadLocalAssistantIdentity: () => ({ avatar: "data:image/png;base64,bG9jYWw=" }),
}));

afterEach(() => {
  resetChatSlashCommandMetadataForTest();
});

describe("resolveChatAvatarUrl", () => {
  it("prefers the authenticated avatar blob over persisted and protected URLs", () => {
    const state = {
      sessionKey: "agent:main:main",
      chatAvatarUrl: "blob:authenticated-avatar",
      assistantAvatar: "/avatar/main",
      assistantAgentId: "main",
    } as unknown as ChatPageHost;

    expect(resolveChatAvatarUrl(state)).toBe("blob:authenticated-avatar");
  });
});

describe("refreshChatMetadata", () => {
  it("applies agent-scoped metadata after a same-agent session switch", async () => {
    let resolveMetadata:
      | ((value: {
          commands: never[];
          models: Array<{
            id: string;
            name: string;
            provider: string;
            available: boolean;
          }>;
        }) => void)
      | undefined;
    const metadata = new Promise<{
      commands: never[];
      models: Array<{ id: string; name: string; provider: string; available: boolean }>;
    }>((resolve) => {
      resolveMetadata = resolve;
    });
    const request = vi.fn(async (method: string, params?: unknown) => {
      expect(method).toBe("chat.metadata");
      expect(params).toEqual({ agentId: "work" });
      return await metadata;
    });
    const state = {
      agentsList: null,
      assistantAgentId: "main",
      chatModelCatalog: [],
      chatMetadataRequestVersion: 0,
      chatModelsLoading: false,
      client: { request },
      connected: true,
      hello: { features: { methods: ["chat.metadata"] } },
      sessionKey: "agent:work:main",
    } as unknown as ChatPageHost;

    const refresh = refreshChatMetadata(state);
    state.sessionKey = "agent:work:another";
    resolveMetadata?.({
      commands: [],
      models: [{ id: "work-model", name: "Work Model", provider: "openai", available: true }],
    });
    await refresh;

    expect(state.chatModelCatalog).toEqual([
      { id: "work-model", name: "Work Model", provider: "openai", available: true },
    ]);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("ignores metadata after switching to a different agent", async () => {
    let resolveMetadata:
      | ((value: {
          commands: never[];
          models: Array<{ id: string; name: string; provider: string }>;
        }) => void)
      | undefined;
    const metadata = new Promise<{
      commands: never[];
      models: Array<{ id: string; name: string; provider: string }>;
    }>((resolve) => {
      resolveMetadata = resolve;
    });
    const request = vi.fn(async () => await metadata);
    const existingCatalog = [
      { id: "work-model", name: "Work Model", provider: "openai", available: true },
    ];
    const state = {
      agentsList: null,
      assistantAgentId: "main",
      chatModelCatalog: existingCatalog,
      chatMetadataRequestVersion: 0,
      chatModelsLoading: false,
      client: { request },
      connected: true,
      hello: { features: { methods: ["chat.metadata"] } },
      sessionKey: "agent:work:main",
    } as unknown as ChatPageHost;

    const refresh = refreshChatMetadata(state);
    state.sessionKey = "agent:other:main";
    resolveMetadata?.({
      commands: [],
      models: [{ id: "other-model", name: "Other Model", provider: "openai" }],
    });
    await refresh;

    expect(state.chatModelCatalog).toBe(existingCatalog);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("keeps loading owned by the newest agent metadata request", async () => {
    let resolveWork: (value: {
      commands: never[];
      models: Array<{ id: string; name: string; provider: string }>;
    }) => void = () => {};
    let resolveOther: (value: {
      commands: never[];
      models: Array<{ id: string; name: string; provider: string }>;
    }) => void = () => {};
    const workMetadata = new Promise<{
      commands: never[];
      models: Array<{ id: string; name: string; provider: string }>;
    }>((resolve) => {
      resolveWork = resolve;
    });
    const otherMetadata = new Promise<{
      commands: never[];
      models: Array<{ id: string; name: string; provider: string }>;
    }>((resolve) => {
      resolveOther = resolve;
    });
    const request = vi.fn(
      async (_method: string, params?: { agentId?: string }) =>
        await (params?.agentId === "work" ? workMetadata : otherMetadata),
    );
    const state = {
      agentsList: null,
      assistantAgentId: "main",
      chatMetadataRequestVersion: 0,
      chatModelCatalog: [],
      chatModelsLoading: false,
      client: { request },
      connected: true,
      hello: { features: { methods: ["chat.metadata"] } },
      sessionKey: "agent:work:main",
    } as unknown as ChatPageHost;

    const workRefresh = refreshChatMetadata(state);
    state.sessionKey = "agent:other:main";
    const otherRefresh = refreshChatMetadata(state);
    resolveWork({
      commands: [],
      models: [{ id: "work-model", name: "Work Model", provider: "openai" }],
    });
    await workRefresh;

    expect(state.chatModelsLoading).toBe(true);
    resolveOther({
      commands: [],
      models: [{ id: "other-model", name: "Other Model", provider: "openai" }],
    });
    await otherRefresh;

    expect(state.chatModelsLoading).toBe(false);
    expect(state.chatModelCatalog).toEqual([
      { id: "other-model", name: "Other Model", provider: "openai" },
    ]);
  });

  it("does not let an older same-agent response overwrite the newest catalog", async () => {
    let resolveFirst: (value: {
      commands: never[];
      models: Array<{ id: string; name: string; provider: string }>;
    }) => void = () => {};
    let resolveSecond: (value: {
      commands: never[];
      models: Array<{ id: string; name: string; provider: string }>;
    }) => void = () => {};
    const firstMetadata = new Promise<{
      commands: never[];
      models: Array<{ id: string; name: string; provider: string }>;
    }>((resolve) => {
      resolveFirst = resolve;
    });
    const secondMetadata = new Promise<{
      commands: never[];
      models: Array<{ id: string; name: string; provider: string }>;
    }>((resolve) => {
      resolveSecond = resolve;
    });
    let requestCount = 0;
    const request = vi.fn(async () => {
      requestCount += 1;
      return await (requestCount === 1 ? firstMetadata : secondMetadata);
    });
    const state = {
      agentsList: null,
      assistantAgentId: "main",
      chatMetadataRequestVersion: 0,
      chatModelCatalog: [],
      chatModelsLoading: false,
      client: { request },
      connected: true,
      hello: { features: { methods: ["chat.metadata"] } },
      sessionKey: "agent:work:main",
    } as unknown as ChatPageHost;

    const firstRefresh = refreshChatMetadata(state);
    const secondRefresh = refreshChatMetadata(state);
    resolveSecond({
      commands: [],
      models: [{ id: "new-model", name: "New Model", provider: "openai" }],
    });
    await secondRefresh;
    resolveFirst({
      commands: [],
      models: [{ id: "old-model", name: "Old Model", provider: "openai" }],
    });
    await firstRefresh;

    expect(state.chatModelCatalog).toEqual([
      { id: "new-model", name: "New Model", provider: "openai" },
    ]);
  });

  it("loads compatibility models when the gateway does not advertise chat metadata", async () => {
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "models.list") {
        expect(params).toEqual({ view: "configured" });
        return {
          models: [{ id: "compat-model", name: "Compat Model", provider: "openai" }],
        };
      }
      expect(method).toBe("commands.list");
      return { commands: [] };
    });
    const state = {
      agentsList: null,
      assistantAgentId: "main",
      chatMetadataRequestVersion: 2,
      chatModelCatalog: [{ id: "stale-model", name: "Stale Model", provider: "openai" }],
      chatModelsLoading: true,
      client: { request },
      connected: true,
      hello: { features: { methods: [] } },
      sessionKey: "agent:main:main",
    } as unknown as ChatPageHost;

    await refreshChatMetadata(state);

    expect(state.chatMetadataRequestVersion).toBe(3);
    expect(state.chatModelCatalog).toEqual([
      { id: "compat-model", name: "Compat Model", provider: "openai" },
    ]);
    expect(state.chatModelsLoading).toBe(false);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("preserves startup models when the gateway does not advertise chat metadata", async () => {
    const request = vi.fn(async (method: string) => {
      expect(method).toBe("commands.list");
      return { commands: [] };
    });
    const startupCatalog = [
      { id: "startup-model", name: "Startup Model", provider: "openai", available: true },
    ];
    const state = {
      agentsList: null,
      assistantAgentId: "main",
      chatMetadataRequestVersion: 4,
      chatModelCatalog: startupCatalog,
      chatModelsLoading: true,
      client: { request },
      connected: true,
      hello: { features: { methods: ["chat.startup"] } },
      sessionKey: "agent:work:main",
    } as unknown as ChatPageHost;

    await refreshChatMetadata(state, { preserveModelCatalogOnFallback: true });

    expect(state.chatMetadataRequestVersion).toBe(5);
    expect(state.chatModelCatalog).toBe(startupCatalog);
    expect(state.chatModelsLoading).toBe(false);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("does not load unscoped compatibility models for a non-default agent", async () => {
    const request = vi.fn(async (method: string) => {
      expect(method).toBe("commands.list");
      return { commands: [] };
    });
    const state = {
      agentsList: { defaultId: "main" },
      assistantAgentId: "main",
      chatMetadataRequestVersion: 0,
      chatModelCatalog: [{ id: "stale-model", name: "Stale Model", provider: "openai" }],
      chatModelsLoading: false,
      client: { request },
      connected: true,
      hello: { features: { methods: [] } },
      sessionKey: "agent:work:main",
    } as unknown as ChatPageHost;

    await refreshChatMetadata(state);

    expect(state.chatModelCatalog).toEqual([]);
    expect(state.chatModelsLoading).toBe(false);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("does not apply compatibility commands after switching agents", async () => {
    let resolveCommands: (value: {
      commands: Array<{
        name: string;
        textAliases: string[];
        description: string;
        source: string;
        scope: string;
        acceptsArgs: boolean;
      }>;
    }) => void = () => {};
    const commands = new Promise<{
      commands: Array<{
        name: string;
        textAliases: string[];
        description: string;
        source: string;
        scope: string;
        acceptsArgs: boolean;
      }>;
    }>((resolve) => {
      resolveCommands = resolve;
    });
    const request = vi.fn(async (method: string) => {
      expect(method).toBe("commands.list");
      return await commands;
    });
    applyRemoteSlashCommandsResult({
      client: null,
      agentId: "other",
      result: {
        commands: [
          {
            name: "other-command",
            textAliases: ["/other-command"],
            description: "Command for the newly selected agent.",
            source: "plugin",
            scope: "text",
            acceptsArgs: false,
          },
        ],
      },
    });
    const state = {
      agentsList: { defaultId: "main" },
      assistantAgentId: "main",
      chatMetadataRequestVersion: 0,
      chatModelCatalog: [],
      chatModelsLoading: false,
      client: { request },
      connected: true,
      hello: { features: { methods: [] } },
      sessionKey: "agent:work:main",
    } as unknown as ChatPageHost;

    const refresh = refreshChatMetadata(state);
    state.sessionKey = "agent:other:main";
    resolveCommands({
      commands: [
        {
          name: "work-command",
          textAliases: ["/work-command"],
          description: "Stale command for the previous agent.",
          source: "plugin",
          scope: "text",
          acceptsArgs: false,
        },
      ],
    });
    await refresh;

    expect(SLASH_COMMANDS.some((command) => command.name === "other-command")).toBe(true);
    expect(SLASH_COMMANDS.some((command) => command.name === "work-command")).toBe(false);
  });
});
