// @vitest-environment node
import { createSessionProjection } from "@openclaw/gateway-client/browser";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayBrowserClient } from "../../api/gateway.ts";
import { i18n } from "../../i18n/index.ts";
import { invalidateChatMetadataStore } from "../../lib/chat/chat-metadata-cache.ts";
import { beginChatMetadataPublication } from "../../lib/chat/chat-metadata-store.ts";
import {
  SLASH_COMMANDS,
  getSlashCommandCategoryLabel,
  getSlashCommandDescription,
} from "../../lib/chat/commands.ts";
import { storageTargetForComposer } from "../../lib/chat/outbox-store.ts";
import {
  applyRemoteSlashCommandsResult,
  invalidateSessionSlashCommands,
  refreshSlashCommands,
} from "../../lib/chat/slash-command-catalog.ts";
import { createSessionsListResult } from "../../test-helpers/chat-model.ts";
import {
  gatewayHelloForMethods,
  sessionMutationGatewayHello,
} from "../../test-helpers/gateway-methods.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { dispatchChatSlashCommand } from "./chat-commands.ts";
import {
  admitChatHistoryPages,
  commitCurrentChatHistorySnapshot,
} from "./chat-history-snapshot.ts";
import { readChatHistoryStartCapability } from "./chat-history-state.ts";
import { loadChatHistory } from "./chat-history.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { applyChatPendingInputs } from "./chat-pending-inputs.ts";
import { handleSendChat } from "./chat-send-submit.ts";
import {
  getChatSessionProjection,
  publishChatSessionProjection,
  readChatSessionPublication,
  readChatSessionProjection,
  readChatSessionProjectionScope,
  reduceChatSessionProjection,
} from "./history-merge.ts";
import { useChatSendBrowserFixture } from "./outbox-browser.test-support.ts";
import { readChatSessionSnapshot, type ChatMessageCache } from "./session-message-cache.ts";

const commandByName = (name: string) => SLASH_COMMANDS.find((entry) => entry.name === name);
const commandResult = (name: string) => ({ commands: [remoteCommand(name, name)] });

function catalogFixture() {
  const client = new GatewayBrowserClient({ url: "ws://127.0.0.1:12345" });
  vi.spyOn(client, "hello", "get").mockReturnValue(gatewayHelloForMethods(["commands.list"]));
  const request = vi.spyOn(client, "request");
  onTestFinished(async () => {
    request.mockRestore();
    vi.useRealTimers();
    await refreshSlashCommands({ client: null });
  });
  const refresh = (sessionKey?: string) =>
    refreshSlashCommands({ client, agentId: "main", sessionKey });
  return { client, request, refresh };
}

function resetHost(confirm: () => Promise<boolean>) {
  const reset = vi.fn();
  const request = vi.fn();
  return {
    request,
    client: { request } as unknown as GatewayBrowserClient,
    connected: true,
    hello: sessionMutationGatewayHello(),
    connectionEpoch: 1,
    sessionKey: "agent:main:current",
    chatRunId: null as string | null,
    confirmConversationReset: vi.fn(confirm),
    sessions: { reset },
    lastError: null as string | null,
    chatError: null as string | null,
  };
}

function remoteCommand(name: string, description: string) {
  return {
    name,
    textAliases: [`/${name}`],
    description,
    source: "plugin" as const,
    scope: "text" as const,
    acceptsArgs: false,
  };
}

describe("refreshSlashCommands", () => {
  it("keeps managed command catalogs scoped to the session when the same viewer switches chats", async () => {
    const { request, refresh } = catalogFixture();
    request.mockResolvedValueOnce(commandResult("notes_alex"));
    request.mockResolvedValueOnce(commandResult("notes_sam"));
    await refresh("agent:main:alex");
    expect(commandByName("notes_alex")).toBeDefined();
    await refresh("agent:main:sam");
    expect(commandByName("notes_sam")).toBeDefined();
    expect(commandByName("notes_alex")).toBeUndefined();
    expect(request).toHaveBeenLastCalledWith("commands.list", {
      agentId: "main",
      sessionKey: "agent:main:sam",
      includeArgs: true,
      scope: "text",
    });
    await refresh("agent:main:alex");
    expect(request).toHaveBeenCalledTimes(2);
    expect(commandByName("notes_alex")).toBeDefined();
  });
  it("retires in-flight commands after an explicit selection invalidation", async () => {
    const { client, request, refresh } = catalogFixture();
    const scope = { agentId: "main", sessionKey: "agent:main:shared" };
    const { promise: pending, resolve: settle } =
      createDeferred<ReturnType<typeof commandResult>>();
    request.mockImplementationOnce(async () => pending).mockResolvedValue(commandResult("new_pin"));
    const stale = refresh(scope.sessionKey);
    invalidateSessionSlashCommands(client, scope);
    await refresh(scope.sessionKey);
    settle(commandResult("old_pin"));
    await stale;
    await refresh(scope.sessionKey);
    expect(request).toHaveBeenCalledTimes(2);
    expect(commandByName("new_pin")).toBeDefined();
    expect(commandByName("old_pin")).toBeUndefined();
  });

  it("keeps New session catalogs separate per selected project", async () => {
    const { client, request } = catalogFixture();
    request
      .mockResolvedValueOnce(commandResult("alpha_skill"))
      .mockResolvedValueOnce(commandResult("beta_skill"));
    // Agent-scoped startup metadata must not stand in for a project's catalog.
    beginChatMetadataPublication(client, { agentId: "main" }).publish(commandResult("agent_only"));
    const refreshProject = (projectId?: string) =>
      refreshSlashCommands({ client, agentId: "main", projectId });
    await refreshProject("project-alpha");
    expect(commandByName("alpha_skill")).toBeDefined();
    await refreshProject("project-beta");
    expect(commandByName("beta_skill")).toBeDefined();
    expect(commandByName("alpha_skill")).toBeUndefined();
    await refreshProject();
    expect(commandByName("agent_only")).toBeDefined();
    expect(commandByName("beta_skill")).toBeUndefined();
    await refreshProject("project-alpha");
    expect(commandByName("alpha_skill")).toBeDefined();
    const projectRequest = (projectId: string) => [
      "commands.list",
      { agentId: "main", projectId, includeArgs: true, scope: "text" },
    ];
    expect(request.mock.calls).toEqual([
      projectRequest("project-alpha"),
      projectRequest("project-beta"),
    ]);
  });

  it("reads a project session's own catalog instead of agent-scoped metadata", async () => {
    const { client, request } = catalogFixture();
    request
      .mockResolvedValueOnce(commandResult("alpha_session_skill"))
      .mockResolvedValueOnce(commandResult("rebound_session_skill"));
    const sessionKey = "agent:main:project-session";
    beginChatMetadataPublication(client, { agentId: "main", sessionKey }).publish(
      commandResult("agent_only"),
    );
    // An existing session owns its project, so a stray projectId never selects a catalog.
    const projectId = "project-alpha";
    // Sessions without an execution root keep the startup metadata catalog.
    await refreshSlashCommands({ client, agentId: "main", sessionKey, projectId });
    expect(commandByName("agent_only")).toBeDefined();
    expect(request).not.toHaveBeenCalled();
    const refreshScoped = (sessionSkillScope: string) =>
      refreshSlashCommands({ client, agentId: "main", sessionKey, projectId, sessionSkillScope });
    await refreshScoped('[null,"/alpha"]');
    expect(commandByName("alpha_session_skill")).toBeDefined();
    expect(commandByName("agent_only")).toBeUndefined();
    expect(request).toHaveBeenLastCalledWith("commands.list", {
      agentId: "main",
      sessionKey,
      includeArgs: true,
      scope: "text",
    });
    // A changed execution root is a different catalog, never the cached one.
    await refreshScoped('["wt",null]');
    expect(commandByName("rebound_session_skill")).toBeDefined();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("resolves localized UI command metadata", () => {
    expect(getSlashCommandDescription(commandByName("clear")!)).toBe("Clear this conversation");
    expect(getSlashCommandCategoryLabel("tools")).toBe("Tools");
  });

  it("requests the gateway default agent when no explicit agentId is available", async () => {
    const { client, request } = catalogFixture();
    request.mockResolvedValue(commandResult("pair"));
    await refreshSlashCommands({ client });
    expect(request).toHaveBeenCalledWith("commands.list", {
      includeArgs: true,
      scope: "text",
    });
    expect(commandByName("pair")).toMatchObject({
      description: "pair",
      executeLocal: false,
      tier: "standard",
    });
  });

  it("keeps local fallback commands after repeated gateway failures", async () => {
    const { request, refresh } = catalogFixture();
    request.mockRejectedValue(new Error("offline"));
    await refresh();
    await refresh();
    expect(request).toHaveBeenCalledTimes(2);
    expect(commandByName("help")).toMatchObject({ key: "help", executeLocal: true });
  });

  it("coalesces duplicate refreshes for the same agent", async () => {
    const { promise: first, resolve: resolveFirst } = createDeferred<unknown>();
    const { request, refresh } = catalogFixture();
    request.mockImplementationOnce(async () => await first);
    const pending = refresh();
    const duplicate = refresh();
    resolveFirst(commandResult("pair"));
    await Promise.all([pending, duplicate]);
    expect(request).toHaveBeenCalledTimes(1);
    expect(commandByName("pair")).toBeDefined();
  });

  it.each(["expired", "invalidated"])("uses the metadata owner with a %s catalog", async (mode) => {
    vi.useFakeTimers();
    const { client, request, refresh } = catalogFixture();
    request.mockResolvedValue(commandResult("requested-command"));
    if (mode === "expired") {
      await refresh();
      vi.advanceTimersByTime(60_001);
    }
    const metadata = commandResult("metadata-command");
    beginChatMetadataPublication(client, { agentId: "main" }).publish(metadata);
    if (mode === "invalidated") {
      applyRemoteSlashCommandsResult(metadata);
      invalidateChatMetadataStore(client);
    }
    await refresh();
    expect(request).toHaveBeenCalledOnce();
    expect(
      commandByName(mode === "expired" ? "metadata-command" : "requested-command"),
    ).toBeDefined();
  });
});

describe("local command loading", () => {
  it("keeps a real local command result in a segmented transcript", async () => {
    const host = makeChatHost({
      requestHandlers: {},
      renderLifecycle: { afterCommit: () => () => undefined },
    });
    const saved = {
      role: "user",
      content: "saved message",
      __openclaw: { id: "saved", seq: 1 },
    };
    admitChatHistoryPages(host, [{ messages: [saved] }], "around");
    await expect(dispatchChatSlashCommand(host, "help", "")).resolves.toBe("completed");
    expect(host.chatMessages).toEqual([
      saved,
      expect.objectContaining({ role: "system", content: expect.any(String) }),
    ]);
  });

  it("keeps command output ordered through paging and its own settings refresh without caching it", async () => {
    const saved = (seq: number) => ({
      role: "user",
      content: `saved-${seq}`,
      __openclaw: { id: `saved-${seq}`, seq },
    });
    const initial = saved(2);
    const newer = saved(3);
    const older = saved(1);
    const chatMessagesBySession: ChatMessageCache = new Map();
    const host = makeChatHost({
      chatMessagesBySession,
      currentSessionId: "session-1",
      renderLifecycle: { afterCommit: () => () => undefined },
      requestHandlers: {
        "sessions.patch": {
          ok: true,
          key: "agent:main",
          path: "",
          entry: { sessionId: "session-1" },
        },
      },
    });
    admitChatHistoryPages(host, [{ messages: [initial] }], "around");
    host.refreshCurrentChat = vi.fn(async () => {
      admitChatHistoryPages(host, [{ messages: [initial, newer] }], "around");
      reduceChatSessionProjection(host, { type: "snapshotLoaded", messages: [initial, newer] });
    });
    await expect(dispatchChatSlashCommand(host, "model", "example/model")).resolves.toBe(
      "completed",
    );
    expect(host.refreshCurrentChat).toHaveBeenCalledOnce();
    const output = host.chatMessages[1];
    expect(output).toMatchObject({
      role: "system",
      content: expect.stringContaining("example/model"),
    });
    expect(host.chatMessages).toEqual([initial, output, newer]);
    admitChatHistoryPages(host, [{ messages: [older, initial] }], "older");
    expect(host.chatMessages).toEqual([older, initial, output, newer]);
    admitChatHistoryPages(host, [{ messages: [newer] }], "around");
    expect(host.chatMessages).toContain(output);
    expect(host.chatHistoryPagination.segments?.flatMap((segment) => segment.sources)).toEqual([
      "id:saved-3",
    ]);
    commitCurrentChatHistorySnapshot(host);
    expect(
      readChatSessionSnapshot(chatMessagesBySession, host, { sessionKey: host.sessionKey })
        ?.messages,
    ).toEqual([newer]);
    reduceChatSessionProjection(host, { type: "sessionReset" });
    expect(host.chatMessages).toEqual([]);
    expect(getChatSessionProjection(host).entries).toEqual([]);
  });

  it("retires old command outcomes under the same resident entry budget", async () => {
    const host = makeChatHost({
      requestHandlers: {},
      renderLifecycle: { afterCommit: () => () => undefined },
    });
    await dispatchChatSlashCommand(host, "help", "");
    const first = host.chatMessages[0];
    for (let index = 0; index < 400; index += 1) {
      await dispatchChatSlashCommand(host, "help", "");
    }
    expect(host.chatMessages).toHaveLength(400);
    expect(host.chatMessages).not.toContain(first);
    expect(getChatSessionProjection(host).entries.some((entry) => entry.message === first)).toBe(
      false,
    );
    expect(host.chatHistoryPagination.segments?.flatMap((segment) => segment.sources)).toEqual([]);
    host.sessionKey = "agent:main:other";
    reduceChatSessionProjection(host, { type: "snapshotLoaded", messages: [] });
    expect(host.chatMessages).toEqual([]);
  });

  it("does not run a command after its Gateway changes while loading", async () => {
    const host = makeChatHost({ requestHandlers: {} });
    const pending = dispatchChatSlashCommand(host, "model", "example/model");
    host.connectionEpoch += 1;
    await expect(pending).resolves.toBe("cancelled");
    expect(host.request).not.toHaveBeenCalled();
    expect(host.chatMessages).toEqual([]);
  });
});

describe("conversation reset confirmation", () => {
  it.each(["owner", "viewer"] as const)(
    "authorizes /stop with narrow scope for a %s session",
    async (sharingRole) => {
      const sessionKey = "agent:main:current";
      const host = makeChatHost({
        sessionKey,
        chatRunId: "run-1",
        hello: sessionMutationGatewayHello(["operator.sessions.write"]),
        sessionsResult: {
          ...createSessionsListResult(),
          sessions: [{ key: sessionKey, kind: "direct", sessionId: "session-1", sharingRole }],
        },
        requestHandlers: { "sessions.abort": { status: "aborted" } },
      });
      const result = await dispatchChatSlashCommand(host, "stop", "");
      expect(result).toBe(sharingRole === "owner" ? "completed" : "failed");
      expect(host.request).toHaveBeenCalledTimes(sharingRole === "owner" ? 1 : 0);
      if (sharingRole === "owner") {
        expect(host.request).toHaveBeenCalledWith("sessions.abort", {
          userInitiated: true,
          key: sessionKey,
          clearQueued: true,
        });
      }
    },
  );

  it.each([
    ["stop", "sessions.abort"],
    ["clear", "sessions.reset"],
    ["compact", "sessions.compact"],
  ] as const)("rejects /%s without its exact operator scope", async (command, method) => {
    const host = resetHost(async () => true);
    host.hello = {
      ...host.hello,
      auth: { role: "operator", scopes: ["operator.read"] },
      features: { methods: [method] },
    };
    host.chatRunId = command === "stop" ? "run-1" : null;
    const result = await dispatchChatSlashCommand(host as never, command, "");
    expect(result).toBe("failed");
    expect(host.request).not.toHaveBeenCalled();
    expect(host.sessions.reset).not.toHaveBeenCalled();
    expect(host.lastError).toBeTruthy();
  });

  it("propagates cancelled /new session creation", async () => {
    const result = await dispatchChatSlashCommand(
      { createChatSession: vi.fn(async () => false) } as never,
      "new",
      "",
    );
    expect(result).toBe("cancelled");
  });

  it("cancels /clear before resetting a board-bearing session", async () => {
    const host = resetHost(async () => false);
    expect(await dispatchChatSlashCommand(host as never, "clear", "")).toBe("cancelled");
    expect(host.sessions.reset).not.toHaveBeenCalled();
  });

  it.each([
    ["run", "deferred", null],
    ["Gateway", "failed", "connection changed"],
    ["scope", "failed", "operator.admin"],
  ] as const)(
    "does not clear when %s changes during confirmation",
    async (change, result, error) => {
      const { promise, resolve } = createDeferred<boolean>();
      const host = resetHost(() => promise);
      host.hello = gatewayHelloForMethods(["sessions.reset"]);
      const pending = dispatchChatSlashCommand(host as never, "clear", "");
      await vi.waitFor(() => expect(host.confirmConversationReset).toHaveBeenCalledOnce());
      if (change === "run") {
        host.chatRunId = "new-run";
      } else {
        if (change === "Gateway") {
          host.client = { request: vi.fn() } as unknown as GatewayBrowserClient;
          host.connectionEpoch += 1;
        }
        host.hello = gatewayHelloForMethods(["sessions.reset"], ["operator.write"]);
      }
      resolve(true);
      await expect(pending).resolves.toBe(result);
      expect(host.sessions.reset).not.toHaveBeenCalled();
      if (error) {
        expect(host.lastError).toContain(error);
      }
    },
  );
});

it.each([
  ["new", "newUnavailable"],
  ["fork", "forkUnavailable"],
])("routes /%s unavailable errors through the catalog", async (command, key) => {
  const host = makeChatHost();
  const translate = vi.spyOn(i18n, "t");
  try {
    await dispatchChatSlashCommand(host, command, "");
    expect(translate).toHaveBeenCalledWith(`chat.commandResults.${key}`, undefined);
    expect(host.chatError).toBe(i18n.t(`chat.commandResults.${key}`));
  } finally {
    translate.mockRestore();
  }
});

describe("accepted empty history command ordering", () => {
  useChatSendBrowserFixture();

  const user = {
    role: "user",
    content: "later question",
    __openclaw: { id: "later-user", seq: 1 },
  };
  const assistant = {
    role: "assistant",
    content: "later answer",
    __openclaw: { id: "later-assistant", seq: 2 },
  };
  function fixture(
    initial: Record<string, unknown> = {
      messages: [],
      totalMessages: 0,
      sessionId: "empty-session",
    },
  ) {
    let history = initial;
    const host = makeChatHost({
      requestHandlers: { "chat.history": () => history },
      renderLifecycle: { afterCommit: () => () => undefined },
    });
    return {
      host,
      read: (next?: Record<string, unknown>) => {
        if (next) {
          history = next;
        }
        return loadChatHistory(host, { deferBranches: true });
      },
      later: async (messages: unknown[] = [user, assistant]) => {
        history = { messages, totalMessages: messages.length, sessionId: "empty-session" };
        await loadChatHistory(host, { deferBranches: true });
        expect(host.chatMessages.filter((message) => messages.includes(message))).toEqual(messages);
      },
    };
  }
  async function command(host: ReturnType<typeof makeChatHost>) {
    await expect(dispatchChatSlashCommand(host, "help", "")).resolves.toBe("completed");
    const output = host.chatMessages.at(-1);
    expect(output).toMatchObject({ role: "system" });
    return output;
  }
  function sourceThenRetirement(host: ReturnType<typeof makeChatHost>) {
    reduceChatSessionProjection(host, { type: "messagePersisted", message: user });
    reduceChatSessionProjection(host, { type: "residencyChanged", messages: [] });
    expect(host.chatMessages).toEqual([]);
  }

  it("keeps a command before the first turn following authoritative empty history", async () => {
    let messages: unknown[] = [];
    const host = makeChatHost({
      requestHandlers: {
        "chat.history": () => ({
          messages,
          totalMessages: messages.length,
          sessionId: "empty-session",
        }),
      },
      renderLifecycle: { afterCommit: () => () => undefined },
    });
    const accepted = await loadChatHistory(host, { deferBranches: true });
    expect(accepted).toMatchObject({ messages: [], totalMessages: 0 });
    expect(host.chatMessages).toEqual([]);
    await expect(dispatchChatSlashCommand(host, "help", "")).resolves.toBe("completed");
    const output = host.chatMessages[0];
    expect(output).toMatchObject({ role: "system", content: expect.any(String) });
    expect(output).not.toHaveProperty("__openclaw");
    const persistedUser = {
      role: "user",
      content: "later question",
      __openclaw: { id: "user-1", seq: 1 },
    };
    const persistedAssistant = {
      role: "assistant",
      content: "later answer",
      __openclaw: { id: "assistant-2", seq: 2 },
    };
    messages = [persistedUser, persistedAssistant];
    expect(await loadChatHistory(host, { deferBranches: true })).toMatchObject({
      totalMessages: 2,
    });
    expect(host.chatMessages).toContain(output);
    expect(host.chatMessages.filter((message) => message !== output)).toEqual([
      persistedUser,
      persistedAssistant,
    ]);
    expect(host.chatMessages).toEqual([output, persistedUser, persistedAssistant]);
  });

  it.each(["start", "consecutive", "unknown"] as const)(
    "keeps %s local outputs through resident-prefix retirement and older admission",
    async (mode) => {
      const f = fixture();
      const outputs: unknown[] = mode === "unknown" ? [await command(f.host)] : [];
      await f.read();
      outputs.push(await command(f.host));
      if (mode === "consecutive") {
        outputs.push(await command(f.host));
      }
      const rows = Array.from({ length: 400 }, (_, index) => ({
        role: "assistant",
        content: `projected sibling ${index}`,
        __openclaw: { id: `source-${Math.floor(index / 5) + 1}`, seq: Math.floor(index / 5) + 1 },
      }));
      await f.read({ messages: rows, totalMessages: 80, sessionId: "empty-session" });
      const held = f.host.chatMessages.filter((message) => !outputs.includes(message));
      expect(held).toHaveLength(395);
      expect(held.every((message, index) => message === rows[index + 5])).toBe(true);
      expect(f.host.chatHistoryPagination.segments?.flatMap((segment) => segment.sources)).toEqual(
        Array.from({ length: 79 }, (_, index) => `id:source-${index + 2}`),
      );
      f.host.readTranscriptReaderSnapshot = () => ({
        anchor: "id:source-2",
        visibleSources: ["id:source-2"],
      });
      expect(rows.slice(0, 5).some((row) => f.host.chatMessages.includes(row))).toBe(false);
      expect(f.host.chatMessages.filter((message) => outputs.includes(message))).toEqual(outputs);
      expect(
        getChatSessionProjection(f.host)
          .entries.filter((entry) => entry.localOutput)
          .map((entry) => Boolean(entry.atHistoryStart)),
      ).toEqual(outputs.map(() => mode !== "unknown"));
      expect(
        admitChatHistoryPages(
          f.host,
          [
            {
              messages: rows.slice(0, 5),
              totalMessages: 80,
              hasMore: false,
              newerCursor: "after-source-1",
            },
          ],
          "older",
        ),
      ).toBe("messages");
      const native = f.host.chatMessages.filter((message) => !outputs.includes(message));
      expect(native).toEqual(rows.slice(0, -5));
      expect(native.every((message, index) => message === rows[index])).toBe(true);
      expect(f.host.chatMessages.filter((message) => outputs.includes(message))).toEqual(outputs);
      expect(f.host.chatMessages).toEqual(
        mode === "unknown" ? [...native, ...outputs] : [...outputs, ...native],
      );
    },
  );

  it.each(["no-op scroll", "first session adoption", "consecutive outputs"] as const)(
    "retains accepted start placement through %s",
    async (mode) => {
      const f = fixture(
        mode === "first session adoption" ? { messages: [], totalMessages: 0 } : undefined,
      );
      await f.read();
      if (mode === "no-op scroll") {
        const projection = getChatSessionProjection(f.host);
        const publication = readChatSessionPublication(f.host);
        publishChatSessionProjection(f.host, projection);
        expect(readChatSessionPublication(f.host)).toBe(publication);
      }
      const first = await command(f.host);
      const outputs = mode === "consecutive outputs" ? [first, await command(f.host)] : [first];
      await f.later();
      expect(f.host.chatMessages).toEqual([...outputs, user, assistant]);
    },
  );

  it.each([false, true])(
    "uses canonical global-agent scope (selection changes=%s)",
    async (changes) => {
      const f = fixture();
      Object.assign(f.host, {
        sessionKey: "global",
        assistantAgentId: "main",
        agentsList: { defaultId: "main", mainKey: "workspace", scope: "global" },
      });
      await f.read();
      if (changes) {
        f.host.assistantAgentId = "work";
      }
      const output = await command(f.host);
      expect(
        Boolean(
          getChatSessionProjection(f.host).entries.find((entry) => entry.message === output)
            ?.atHistoryStart,
        ),
      ).toBe(!changes);
      if (!changes) {
        await f.later();
        expect(f.host.chatMessages).toEqual([output, user, assistant]);
      }
    },
  );

  it("does not move a newly authorized output ahead of an older unknown local output", async () => {
    const f = fixture();
    const first = await command(f.host);
    await f.read();
    const second = await command(f.host);
    expect(
      getChatSessionProjection(f.host)
        .entries.filter((entry) => entry.localOutput)
        .every((entry) => !entry.atHistoryStart),
    ).toBe(true);
    await f.later();
    expect(f.host.chatMessages).toEqual([user, assistant, first, second]);
  });

  it.each([
    "unloaded",
    "missing count",
    "hidden source",
    "live run",
    "source retirement",
    "reset",
    "gap",
    "connection",
    "new read",
  ] as const)("preserves unknown tail placement after %s", async (mode) => {
    const f = fixture(
      mode === "missing count"
        ? { messages: [], sessionId: "empty-session" }
        : mode === "hidden source"
          ? { messages: [], totalMessages: 1, sessionId: "empty-session" }
          : mode === "live run"
            ? {
                messages: [],
                totalMessages: 0,
                sessionId: "empty-session",
                inFlightRun: { runId: "active", text: "" },
              }
            : undefined,
    );
    if (mode !== "unloaded") {
      await f.read();
    }
    if (mode === "source retirement") {
      sourceThenRetirement(f.host);
    }
    if (mode === "reset") {
      reduceChatSessionProjection(f.host, { type: "sessionReset" });
    }
    if (mode === "gap") {
      reduceChatSessionProjection(f.host, { type: "transportGap" });
    }
    if (mode === "connection") {
      f.host.connectionEpoch++;
    }
    const pending = createDeferred<unknown>();
    let reading: Promise<unknown> | undefined;
    if (mode === "new read") {
      f.host.client!.request = () => pending.promise as never;
      reading = f.read();
    }
    const output = await command(f.host);
    expect(
      getChatSessionProjection(f.host).entries.find((entry) => entry.message === output)
        ?.atHistoryStart,
    ).toBeUndefined();
    if (reading) {
      pending.resolve({ messages: [], totalMessages: 1, sessionId: "empty-session" });
      await reading;
      f.host.client!.request = f.host.request as never;
    }
    // Fresh native adoption must not retroactively grant the earlier output authority.
    if (mode !== "new read") {
      f.host.chatRunId = null;
      await f.later();
      expect(f.host.chatMessages).toEqual([user, assistant, output]);
    }
  });

  it.each(["unknown scope", "unavailable storage", "read failure", "parse failure"] as const)(
    "does not treat %s as an empty outbox",
    async (mode) => {
      const f = fixture();
      await f.read();
      const storage = createStorageMock();
      vi.stubGlobal("sessionStorage", storage);
      if (mode === "unknown scope") {
        Object.defineProperty(f.host.client!, "recoveryScopeReady", {
          configurable: true,
          get: () => false,
        });
      }
      if (mode === "unavailable storage") {
        vi.stubGlobal("sessionStorage", undefined);
      }
      const readFailure = mode === "read failure" ? vi.spyOn(storage, "getItem") : undefined;
      if (readFailure) {
        readFailure.mockImplementation(() => {
          throw new Error("unavailable");
        });
      }
      if (mode === "parse failure") {
        storage.setItem(storageTargetForComposer(f.host).key, "invalid json");
      }
      const output = await command(f.host);
      expect(
        getChatSessionProjection(f.host).entries.find((entry) => entry.message === output)
          ?.atHistoryStart,
      ).toBeUndefined();
      if (mode === "read failure") {
        expect(readFailure).toHaveBeenCalled();
      }
    },
  );

  it("keeps a durable user send ahead of a command while its ACK is held", async () => {
    const f = fixture();
    await f.read();
    const ack = createDeferred<unknown>();
    const request = f.host.request.getMockImplementation()!;
    f.host.request.mockImplementation((method, ...args) =>
      method === "chat.send" ? ack.promise : request(method, ...args),
    );
    f.host.chatMessage = "queued question";
    const sending = handleSendChat(f.host);
    await vi.waitFor(() =>
      expect(f.host.request).toHaveBeenCalledWith(
        "chat.send",
        expect.anything(),
        expect.anything(),
      ),
    );
    const output = await command(f.host);
    expect(
      getChatSessionProjection(f.host).entries.find((entry) => entry.message === output)
        ?.atHistoryStart,
    ).toBeUndefined();
    const send = f.host.request.mock.calls.find(([method]) => method === "chat.send");
    const sendRunId = (expectDefined(send, "chat.send request")[1] as { idempotencyKey: string })
      .idempotencyKey;
    expect(sendRunId).toEqual(expect.any(String));
    ack.resolve({ status: "started", runId: sendRunId });
    await sending;
    const pendingUser = getChatSessionProjection(f.host).entries.find(
      (entry) => entry.pending && entry.identity?.role === "user",
    );
    expect(pendingUser).toBeDefined();
    const metadata = (pendingUser!.message as { __openclaw: Record<string, unknown> })[
      "__openclaw"
    ];
    const persisted = {
      role: "user",
      content: "queued question",
      __openclaw: { ...metadata, id: "persisted-user", seq: 1, runId: sendRunId },
    };
    await f.later([persisted, assistant]);
    expect(f.host.chatMessages).toEqual([persisted, assistant, output]);
  });

  it("records redirect ACK run custody before injecting its result", async () => {
    const f = fixture();
    await f.read();
    f.host.request.mockResolvedValue({ status: "started", runId: "redirect-run" });
    await expect(dispatchChatSlashCommand(f.host, "redirect", "next task")).resolves.toBe(
      "completed",
    );
    expect(f.host.chatRunId).toBe("redirect-run");
    const output = f.host.chatMessages.at(-1);
    expect(output).toMatchObject({ role: "system" });
    expect(
      getChatSessionProjection(f.host).entries.find((entry) => entry.message === output)
        ?.atHistoryStart,
    ).toBeUndefined();
  });

  it.each(["request await", "settlement microtask"] as const)(
    "does not bless zero after native publication and retirement during %s",
    async (mode) => {
      const f = fixture();
      let loading: Promise<unknown>;
      if (mode === "request await") {
        const response = createDeferred<unknown>();
        f.host.request.mockImplementation((method) =>
          method === "chat.history" ? response.promise : Promise.resolve({}),
        );
        loading = f.read();
        await vi.waitFor(() =>
          expect(f.host.request).toHaveBeenCalledWith(
            "chat.history",
            expect.anything(),
            expect.anything(),
          ),
        );
        sourceThenRetirement(f.host);
        response.resolve({ messages: [], totalMessages: 0, sessionId: "empty-session" });
      } else {
        let fired = false;
        Object.defineProperty(f.host, "chatVerboseLevel", {
          configurable: true,
          set: () => {
            if (!fired) {
              fired = true;
              queueMicrotask(() => sourceThenRetirement(f.host));
            }
          },
        });
        loading = f.read();
      }
      await loading;
      const output = await command(f.host);
      expect(
        getChatSessionProjection(f.host).entries.find((entry) => entry.message === output)
          ?.atHistoryStart,
      ).toBeUndefined();
    },
  );

  it.each([false, true])(
    "preserves nested publication token before outer completion (existing=%s)",
    (existing) => {
      const f = fixture();
      if (existing) {
        getChatSessionProjection(f.host);
      }
      let messages = f.host.chatMessages;
      let fired = false;
      Object.defineProperty(f.host, "chatMessages", {
        configurable: true,
        get: () => messages,
        set: (next) => {
          messages = next;
          if (!fired) {
            fired = true;
            sourceThenRetirement(f.host);
          }
        },
      });
      const incoming = createSessionProjection(readChatSessionProjectionScope(f.host), [user]);
      const publication = publishChatSessionProjection(f.host, incoming);
      expect(fired).toBe(true);
      expect(readChatSessionPublication(f.host)).not.toBe(publication);
    },
  );

  it("does not mint start custody across reentrant initial session binding", async () => {
    const f = fixture();
    getChatSessionProjection(f.host, readChatSessionProjectionScope(f.host, { agentId: "main" }));
    expect(readChatSessionProjection(f.host)?.scope.sessionId).toBeUndefined();
    const beforeBinding = readChatSessionPublication(f.host);
    let fired = false;
    f.host.readTranscriptReaderSnapshot = () => {
      if (
        !fired &&
        readChatSessionPublication(f.host) !== beforeBinding &&
        readChatSessionProjection(f.host)?.scope.sessionId === undefined
      ) {
        fired = true;
        sourceThenRetirement(f.host);
      }
      return { anchor: null, visibleSources: [] };
    };
    await f.read();
    expect(fired).toBe(true);
    const output = await command(f.host);
    expect(
      getChatSessionProjection(f.host).entries.find((entry) => entry.message === output)
        ?.atHistoryStart,
    ).toBeUndefined();
  });

  it("does not mint a usable zero-source receipt across reentrant retirement publication", async () => {
    const f = fixture();
    f.host.currentSessionId = "previous-session";
    f.host.chatMessages = [user];
    let fired = false;
    f.host.transcriptMessagesRetired = () => {
      if (!fired) {
        fired = true;
        sourceThenRetirement(f.host);
      }
    };
    await f.read();
    expect(fired).toBe(true);
    const output = await command(f.host);
    expect(
      getChatSessionProjection(f.host).entries.find((entry) => entry.message === output)
        ?.atHistoryStart,
    ).toBeUndefined();
  });

  it.each([true, false])(
    "withholds start placement when a zero-source read has Gateway input custody (queued=%s)",
    async (queued) => {
      const f = fixture({
        messages: [],
        totalMessages: 0,
        sessionId: "empty-session",
        pendingInputs: {
          total: 1,
          queuedCount: queued ? 1 : 0,
          items: [
            {
              id: "remote-input",
              runId: "remote-run",
              acceptedAt: 1,
              state: "queued",
              ...(queued ? { queued: true } : {}),
              message: { role: "user", content: "remote queued question" },
            },
          ],
        },
      });
      await f.read();
      expect(f.host.chatPendingInputs?.page.total).toBe(1);
      expect(f.host.chatPendingInputs?.queuedInputs).toHaveLength(queued ? 1 : 0);
      expect(readChatHistoryStartCapability(f.host)).toBeUndefined();
      const output = await command(f.host);
      expect(
        getChatSessionProjection(f.host).entries.find((entry) => entry.message === output)
          ?.atHistoryStart,
      ).toBeUndefined();
      await f.later();
      expect(f.host.chatMessages).toEqual([user, assistant, output]);
    },
  );

  it.each(["queued", "accepted", "omitted correlation", "filtered page"] as const)(
    "revokes earlier start custody when Gateway input arrives then retires (%s)",
    async (mode) => {
      const f = fixture();
      await f.read();
      const publication = readChatSessionPublication(f.host);
      applyChatPendingInputs(f.host, {
        total: 1,
        queuedCount: mode === "queued" ? 1 : 0,
        items:
          mode === "filtered page"
            ? []
            : [
                {
                  id: "remote-input",
                  acceptedAt: 1,
                  state: "queued",
                  ...(mode !== "omitted correlation" ? { runId: "remote-run" } : {}),
                  ...(mode === "queued" ? { queued: true } : {}),
                  message: { role: "user", content: "accepted elsewhere" },
                },
              ],
      });
      expect(f.host.chatMessages).toEqual([]);
      expect(readChatSessionPublication(f.host)).not.toBe(publication);
      applyChatPendingInputs(f.host, { total: 0, queuedCount: 0, items: [] });
      expect(f.host.chatPendingInputs?.page.total).toBe(0);
      const output = await command(f.host);
      expect(
        getChatSessionProjection(f.host).entries.find((entry) => entry.message === output)
          ?.atHistoryStart,
      ).toBeUndefined();
      await f.later();
      expect(f.host.chatMessages).toEqual([user, assistant, output]);
    },
  );

  it.each(["current custody", "browsing", "noncurrent scope"] as const)(
    "withholds an earlier start capability with %s pending-input facts",
    async (mode) => {
      const f = fixture();
      await f.read();
      expect(readChatHistoryStartCapability(f.host)).toBeDefined();
      if (mode === "current custody") {
        applyChatPendingInputs(f.host, {
          total: 1,
          queuedCount: 0,
          items: [
            {
              id: "accepted-input",
              runId: "accepted-run",
              acceptedAt: 1,
              state: "queued",
              message: { role: "user", content: "accepted elsewhere" },
            },
          ],
        });
      } else {
        const view = f.host.chatPendingInputs!;
        if (mode === "browsing") {
          view.before = 1;
        } else {
          view.sessionId = "other-session";
        }
      }
      const output = await command(f.host);
      expect(
        getChatSessionProjection(f.host).entries.find((entry) => entry.message === output)
          ?.atHistoryStart,
      ).toBeUndefined();
    },
  );
});
