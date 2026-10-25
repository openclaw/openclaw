// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayBrowserClient } from "../../api/gateway.ts";
import { invalidateChatMetadataStore } from "../../lib/chat/chat-metadata-cache.ts";
import { beginChatMetadataPublication } from "../../lib/chat/chat-metadata-store.ts";
import {
  SLASH_COMMANDS,
  getSlashCommandCategoryLabel,
  getSlashCommandDescription,
  type SlashCommandDef,
} from "../../lib/chat/commands.ts";
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
import { dispatchChatSlashCommand } from "./chat-commands.ts";
import { makeChatHost } from "./chat-host.test-support.ts";

function requireCommandByName(name: string) {
  const command = SLASH_COMMANDS.find((entry) => entry.name === name);
  if (!command) {
    throw new Error(`expected slash command ${name}`);
  }
  return command;
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

function skillCommand(name: string, person: string) {
  return {
    ...remoteCommand(name, `${person}'s selected notes`),
    source: "skill",
    skillDisplayName: `Notes · ${person}`,
    skillModelVisible: true,
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

const pairCommand = {
  name: "pair",
  textAliases: ["/pair"],
  description: "Generate setup codes.",
  source: "plugin",
  scope: "both",
  acceptsArgs: true,
};

describe("refreshSlashCommands", () => {
  it("keeps managed command catalogs scoped to the session when the same viewer switches chats", async () => {
    const client = new GatewayBrowserClient({ url: "ws://127.0.0.1:12345" });
    const request = vi
      .spyOn(client, "request")
      .mockResolvedValueOnce({
        commands: [skillCommand("notes_alex", "Alex")],
      })
      .mockResolvedValueOnce({
        commands: [skillCommand("notes_sam", "Sam")],
      });
    try {
      await refreshSlashCommands({ client, agentId: "main", sessionKey: "agent:main:alex" });
      expect(SLASH_COMMANDS.some((command) => command.name === "notes_alex")).toBe(true);
      await refreshSlashCommands({ client, agentId: "main", sessionKey: "agent:main:sam" });
      expect(SLASH_COMMANDS.some((command) => command.name === "notes_sam")).toBe(true);
      expect(SLASH_COMMANDS.some((command) => command.name === "notes_alex")).toBe(false);
      expect(request).toHaveBeenLastCalledWith("commands.list", {
        agentId: "main",
        sessionKey: "agent:main:sam",
        includeArgs: true,
        scope: "text",
      });
      await refreshSlashCommands({ client, agentId: "main", sessionKey: "agent:main:alex" });
      expect(request).toHaveBeenCalledTimes(2);
      expect(SLASH_COMMANDS.some((command) => command.name === "notes_alex")).toBe(true);
    } finally {
      request.mockRestore();
      await refreshSlashCommands({ client: null });
    }
  });
  it("retires in-flight commands after an explicit selection invalidation", async () => {
    const client = new GatewayBrowserClient({ url: "ws://127.0.0.1:12345" });
    const scope = { agentId: "main", sessionKey: "agent:main:shared" };
    const { promise: pending, resolve: settle } = createDeferred<{
      commands: ReturnType<typeof remoteCommand>[];
    }>();
    const request = vi
      .spyOn(client, "request")
      .mockImplementationOnce(async () => pending)
      .mockResolvedValue({ commands: [remoteCommand("new_pin", "Updated selection")] });
    try {
      const stale = refreshSlashCommands({ client, ...scope });
      invalidateSessionSlashCommands(client, scope);
      await refreshSlashCommands({ client, ...scope });
      settle({ commands: [remoteCommand("old_pin", "Previous selection")] });
      await stale;
      await refreshSlashCommands({ client, ...scope });
      expect(request).toHaveBeenCalledTimes(2);
      expect(SLASH_COMMANDS.some((command) => command.name === "new_pin")).toBe(true);
      expect(SLASH_COMMANDS.some((command) => command.name === "old_pin")).toBe(false);
    } finally {
      request.mockRestore();
      await refreshSlashCommands({ client: null });
    }
  });

  it("resolves localized UI command metadata", () => {
    const clear = SLASH_COMMANDS.find((entry) => entry.name === "clear");
    const redirect = SLASH_COMMANDS.find((entry) => entry.name === "redirect");
    expect(getSlashCommandDescription(clear as SlashCommandDef)).toBe("Clear chat history");
    expect(getSlashCommandDescription(redirect as SlashCommandDef)).toBe(
      "Abort and restart with a new message",
    );
    expect(getSlashCommandCategoryLabel("tools")).toBe("Tools");
  });

  it("requests the gateway default agent when no explicit agentId is available", async () => {
    const request = vi.fn().mockResolvedValue({
      commands: [pairCommand],
    });
    await refreshSlashCommands({
      client: { request } as never,
      agentId: undefined,
    });
    expect(request).toHaveBeenCalledWith("commands.list", {
      includeArgs: true,
      scope: "text",
    });
    expect(requireCommandByName("pair")).toMatchObject({
      name: "pair",
      description: "Generate setup codes.",
      executeLocal: false,
      tier: "standard",
    });
  });

  it("keeps local fallback commands after repeated gateway failures", async () => {
    const request = vi.fn().mockRejectedValue(new Error("offline"));
    const client = { request } as never;
    await refreshSlashCommands({ client, agentId: "main" });
    expect(requireCommandByName("help")).toMatchObject({
      key: "help",
      executeLocal: true,
    });
    await refreshSlashCommands({ client, agentId: "main" });
    expect(request).toHaveBeenCalledTimes(2);
    expect(requireCommandByName("help")).toMatchObject({
      key: "help",
      executeLocal: true,
    });
  });

  it("coalesces duplicate refreshes for the same agent", async () => {
    const { promise: first, resolve: resolveFirst } = createDeferred<unknown>();
    const request = vi.fn().mockImplementationOnce(async () => await first);
    const client = { request } as never;
    const pending = refreshSlashCommands({ client, agentId: "main" });
    const duplicate = refreshSlashCommands({ client, agentId: "main" });
    resolveFirst({ commands: [pairCommand] });
    await pending;
    await duplicate;
    expect(request).toHaveBeenCalledTimes(1);
    expect(requireCommandByName("pair")).toMatchObject({
      name: "pair",
      description: "Generate setup codes.",
      executeLocal: false,
      tier: "standard",
    });
  });

  it("prefers stored metadata after the commands.list cache expires", async () => {
    vi.useFakeTimers();
    try {
      const request = vi.fn().mockResolvedValue({
        commands: [remoteCommand("cached-command", "Loaded from commands.list.")],
      });
      const client = { request } as never;

      await refreshSlashCommands({ client, agentId: "main" });
      vi.advanceTimersByTime(60_001);
      beginChatMetadataPublication(client, { agentId: "main" }).publish({
        commands: [remoteCommand("metadata-command", "Loaded from chat metadata.")],
      });

      await refreshSlashCommands({ client, agentId: "main" });

      expect(request).toHaveBeenCalledOnce();
      expect(requireCommandByName("metadata-command")).toMatchObject({
        description: "Loaded from chat metadata.",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retain applied metadata commands in the commands.list cache", async () => {
    const request = vi.fn().mockResolvedValue({
      commands: [remoteCommand("requested-command", "Loaded after metadata invalidation.")],
    });
    const client = { request } as never;
    const metadata = {
      commands: [remoteCommand("metadata-command", "Loaded from chat metadata.")],
    };
    beginChatMetadataPublication(client, { agentId: "main" }).publish(metadata);
    applyRemoteSlashCommandsResult(metadata);

    invalidateChatMetadataStore(client);
    await refreshSlashCommands({ client, agentId: "main" });
    expect(request).toHaveBeenCalledOnce();
    expect(requireCommandByName("requested-command")).toMatchObject({
      description: "Loaded after metadata invalidation.",
    });
  });
});

describe("local command loading", () => {
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
