import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearSessionStoreCacheForTest,
  getSessionEntry,
  upsertSessionEntry,
} from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { buildBuiltinChatCommands } from "../commands-registry.shared.js";
import { takeCommandSessionMetadataChanges } from "./command-session-metadata.js";
import {
  handleDeleteSessionCommand,
  parseDeleteSessionCommand,
} from "./commands-delete-session.js";
import type { HandleCommandsParams } from "./commands-types.js";

const callGatewayMock = vi.hoisted(() => vi.fn());

vi.mock("../../gateway/call.js", () => ({
  callGateway: (params: unknown) => callGatewayMock(params),
}));

const sessionKey = "agent:main:web:delete-me";
let tempRoots: string[] = [];

beforeEach(() => {
  callGatewayMock.mockReset();
  callGatewayMock.mockResolvedValue({ deleted: true });
});

afterEach(async () => {
  clearSessionStoreCacheForTest();
  await Promise.all(tempRoots.map((root) => fs.rm(root, { recursive: true, force: true })));
  tempRoots = [];
});

async function createStorePath(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-delete-command-"));
  tempRoots.push(root);
  return path.join(root, "sessions.json");
}

function buildDeleteParams(
  commandBodyNormalized: string,
  storePath: string,
  overrides: {
    gatewayClientScopes?: string[];
    isAuthorizedSender?: boolean;
    sessionKey?: string;
  } = {},
): HandleCommandsParams {
  const activeSessionKey = overrides.sessionKey ?? sessionKey;
  return {
    cfg: {} as OpenClawConfig,
    ctx: {
      Provider: "web",
      Surface: "web",
      CommandSource: "text",
      GatewayClientScopes: overrides.gatewayClientScopes,
    },
    command: {
      commandBodyNormalized,
      isAuthorizedSender: overrides.isAuthorizedSender ?? true,
      senderIsOwner: true,
      senderId: "tester",
      channel: "web",
      channelId: "web",
      surface: "web",
      ownerList: [],
      rawBodyNormalized: commandBodyNormalized,
    },
    directives: {},
    sessionStore: {},
    elevated: { enabled: true, allowed: true, failures: [] },
    sessionKey: activeSessionKey,
    storePath,
    workspaceDir: "/tmp",
    provider: "openai",
    model: "gpt-5.5",
    contextTokens: 0,
    defaultGroupActivation: () => "mention",
    resolvedVerboseLevel: "off",
    resolvedReasoningLevel: "off",
    resolveDefaultThinkingLevel: async () => undefined,
    isGroup: false,
  } as unknown as HandleCommandsParams;
}

describe("delete session command", () => {
  it("parses supported aliases and ignores other commands", () => {
    expect(parseDeleteSessionCommand("/close")).toEqual({ command: "/close" });
    expect(parseDeleteSessionCommand("/DELETE now")).toEqual({ command: "/delete" });
    expect(parseDeleteSessionCommand("/name Demo")).toBeNull();
  });

  it("registers close/delete session commands", () => {
    const commands = buildBuiltinChatCommands();
    expect(commands.find((entry) => entry.key === "close")).toMatchObject({
      nativeName: "close",
      textAliases: ["/close"],
      category: "session",
    });
    expect(commands.find((entry) => entry.key === "delete-session")).toMatchObject({
      nativeName: "delete",
      textAliases: ["/delete"],
      category: "session",
    });
  });

  it("routes deletion through the gateway session lifecycle", async () => {
    const storePath = await createStorePath();
    await upsertSessionEntry({
      storePath,
      sessionKey,
      entry: {
        sessionId: "delete-me",
        updatedAt: 1,
        totalTokens: 0,
        totalTokensFresh: true,
      },
    });
    const params = buildDeleteParams("/close", storePath);

    const result = await handleDeleteSessionCommand(params, true);

    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "✅ Session closed and archived." },
    });
    expect(callGatewayMock).toHaveBeenCalledWith({
      method: "sessions.delete",
      params: { key: sessionKey, deleteTranscript: true },
    });
    expect(takeCommandSessionMetadataChanges(params.ctx)).toEqual([
      { sessionKey, reason: "command-metadata" },
    ]);
  });

  it("does not delete the main session", async () => {
    const storePath = await createStorePath();
    await upsertSessionEntry({
      storePath,
      sessionKey: "agent:main:main",
      entry: { sessionId: "main-session", updatedAt: 1, totalTokens: 0, totalTokensFresh: true },
    });
    const params = buildDeleteParams("/delete", storePath, { sessionKey: "agent:main:main" });

    const result = await handleDeleteSessionCommand(params, true);

    expect(result?.reply?.text).toContain("main session cannot be deleted");
    expect(callGatewayMock).not.toHaveBeenCalled();
    expect(getSessionEntry({ storePath, sessionKey: "agent:main:main" })?.sessionId).toBe(
      "main-session",
    );
  });

  it("does not delete another agent main session", async () => {
    const storePath = await createStorePath();
    await upsertSessionEntry({
      storePath,
      sessionKey: "agent:work:main",
      entry: {
        sessionId: "work-main-session",
        updatedAt: 1,
        totalTokens: 0,
        totalTokensFresh: true,
      },
    });
    const params = buildDeleteParams("/delete", storePath, { sessionKey: "agent:work:main" });

    const result = await handleDeleteSessionCommand(params, true);

    expect(result?.reply?.text).toContain("main session cannot be deleted");
    expect(callGatewayMock).not.toHaveBeenCalled();
    expect(getSessionEntry({ storePath, sessionKey: "agent:work:main" })?.sessionId).toBe(
      "work-main-session",
    );
  });

  it("does not delete another agent configured main session", async () => {
    const storePath = await createStorePath();
    await upsertSessionEntry({
      storePath,
      sessionKey: "agent:work:home",
      entry: {
        sessionId: "work-home-session",
        updatedAt: 1,
        totalTokens: 0,
        totalTokensFresh: true,
      },
    });
    const params = buildDeleteParams("/delete", storePath, { sessionKey: "agent:work:home" });
    params.cfg = { session: { mainKey: "home" } } as OpenClawConfig;

    const result = await handleDeleteSessionCommand(params, true);

    expect(result?.reply?.text).toContain("main session cannot be deleted");
    expect(callGatewayMock).not.toHaveBeenCalled();
    expect(getSessionEntry({ storePath, sessionKey: "agent:work:home" })?.sessionId).toBe(
      "work-home-session",
    );
  });

  it("does not delete for an unauthorized sender", async () => {
    const storePath = await createStorePath();
    await upsertSessionEntry({
      storePath,
      sessionKey,
      entry: { sessionId: "delete-me", updatedAt: 1, totalTokens: 0, totalTokensFresh: true },
    });
    const params = buildDeleteParams("/close", storePath, { isAuthorizedSender: false });

    const result = await handleDeleteSessionCommand(params, true);

    expect(result?.shouldContinue).toBe(false);
    expect(callGatewayMock).not.toHaveBeenCalled();
    expect(getSessionEntry({ storePath, sessionKey })?.sessionId).toBe("delete-me");
  });

  it("requires operator.admin for internal gateway clients", async () => {
    const storePath = await createStorePath();
    await upsertSessionEntry({
      storePath,
      sessionKey,
      entry: { sessionId: "delete-me", updatedAt: 1, totalTokens: 0, totalTokensFresh: true },
    });
    const params = buildDeleteParams("/close", storePath, {
      gatewayClientScopes: ["operator.write"],
    });

    const result = await handleDeleteSessionCommand(params, true);

    expect(result?.reply?.text).toContain("operator.admin");
    expect(callGatewayMock).not.toHaveBeenCalled();
    expect(getSessionEntry({ storePath, sessionKey })?.sessionId).toBe("delete-me");
  });
});
