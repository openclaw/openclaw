// @vitest-environment node
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayBrowserClient } from "../../api/gateway.ts";
import { invalidateChatMetadataStore } from "../../lib/chat/chat-metadata-cache.ts";
import { beginChatMetadataPublication } from "../../lib/chat/chat-metadata-store.ts";
import {
  SLASH_COMMANDS,
  getSlashCommandCategoryLabel,
  getSlashCommandDescription,
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

const commandByName = (name: string) => SLASH_COMMANDS.find((entry) => entry.name === name);
const commandResult = (name: string) => ({ commands: [remoteCommand(name, name)] });

function catalogFixture() {
  const client = new GatewayBrowserClient({ url: "ws://127.0.0.1:12345" });
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

  it("resolves localized UI command metadata", () => {
    expect(getSlashCommandDescription(commandByName("clear")!)).toBe("Clear chat history");
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
