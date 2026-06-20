import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getSessionEntry, updateSessionStore, upsertSessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { buildBuiltinChatCommands } from "../commands-registry.shared.js";
import { takeCommandSessionMetadataChanges } from "./command-session-metadata.js";
import { loadCommandHandlers } from "./commands-handlers.runtime.js";
import { handleNameCommand, parseNameCommand } from "./commands-name.js";
import type { HandleCommandsParams } from "./commands-types.js";

const sessionKey = "agent:main:web:main";
let tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => fs.rm(root, { recursive: true, force: true })));
  tempRoots = [];
});

async function createStorePath(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-name-command-"));
  tempRoots.push(root);
  return path.join(root, "sessions.json");
}

function buildNameParams(commandBodyNormalized: string, storePath: string): HandleCommandsParams {
  return {
    cfg: {} as OpenClawConfig,
    ctx: {
      Provider: "web",
      Surface: "web",
      CommandSource: "text",
    },
    command: {
      commandBodyNormalized,
      isAuthorizedSender: true,
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
    sessionKey,
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

type NamingFields = { title?: string; label?: string };

function namingFields(entry: unknown): NamingFields {
  return (entry ?? {}) as NamingFields;
}

describe("name command", () => {
  it("parses the captured title and ignores other commands", () => {
    expect(parseNameCommand("/name Quarterly planning")).toEqual({ title: "Quarterly planning" });
    expect(parseNameCommand("/name")).toEqual({ title: "" });
    expect(parseNameCommand("/goal status")).toBeNull();
  });

  it("registers and loads the command on text and native surfaces", () => {
    const command = buildBuiltinChatCommands().find((entry) => entry.key === "name");

    expect(command).toMatchObject({
      nativeName: "name",
      textAliases: ["/name"],
      acceptsArgs: true,
      scope: "both",
      category: "session",
    });
    expect(command?.args).toEqual([expect.objectContaining({ name: "title" })]);
    expect(loadCommandHandlers()).toContain(handleNameCommand);
  });

  it("renames the current session and mirrors title to legacy label", async () => {
    const storePath = await createStorePath();
    await upsertSessionEntry({
      storePath,
      sessionKey,
      entry: { sessionId: "sess-main", updatedAt: 1, totalTokens: 0, totalTokensFresh: true },
    });

    const params = buildNameParams("/name Billing rework", storePath);
    const result = await handleNameCommand(params, true);
    const stored = namingFields(getSessionEntry({ storePath, sessionKey }));

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("Billing rework");
    expect(stored.title).toBe("Billing rework");
    expect(stored.label).toBe("Billing rework");
    expect(namingFields(params.sessionEntry).title).toBe("Billing rework");
    expect(namingFields(params.sessionEntry).label).toBe("Billing rework");
    expect(takeCommandSessionMetadataChanges(params.ctx)).toEqual([
      { sessionKey, reason: "command-metadata" },
    ]);
  });

  it("clears title and legacy label together", async () => {
    const storePath = await createStorePath();
    await upsertSessionEntry({
      storePath,
      sessionKey,
      entry: {
        sessionId: "sess-main",
        updatedAt: 1,
        totalTokens: 0,
        totalTokensFresh: true,
        title: "Billing rework",
        label: "Billing rework",
      },
    });

    const params = buildNameParams("/name --clear", storePath);
    const result = await handleNameCommand(params, true);
    const stored = namingFields(getSessionEntry({ storePath, sessionKey }));

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("Session name cleared");
    expect(stored.title).toBeUndefined();
    expect(stored.label).toBeUndefined();
    expect(namingFields(params.sessionEntry).title).toBeUndefined();
    expect(namingFields(params.sessionEntry).label).toBeUndefined();
    expect(takeCommandSessionMetadataChanges(params.ctx)).toEqual([
      { sessionKey, reason: "command-metadata" },
    ]);
  });

  it("rejects a title already used by another session", async () => {
    const storePath = await createStorePath();
    const now = Date.now();
    await updateSessionStore(storePath, (store) => {
      store[sessionKey] = {
        sessionId: "sess-main",
        updatedAt: now,
        totalTokens: 0,
        totalTokensFresh: true,
      };
      store["agent:main:web:other"] = {
        sessionId: "sess-other",
        updatedAt: now,
        totalTokens: 0,
        totalTokensFresh: true,
        title: "Taken",
        label: "Taken",
      } as (typeof store)[typeof sessionKey] & NamingFields;
      return null;
    });

    const params = buildNameParams("/name Taken", storePath);
    const result = await handleNameCommand(params, true);

    expect(result?.reply?.text).toContain("title already in use");
    expect(namingFields(getSessionEntry({ storePath, sessionKey })).title).toBeUndefined();
    expect(namingFields(getSessionEntry({ storePath, sessionKey })).label).toBeUndefined();
    expect(takeCommandSessionMetadataChanges(params.ctx)).toBeUndefined();
  });

  it("suggests a name without mutating when no argument is given", async () => {
    const storePath = await createStorePath();
    await upsertSessionEntry({
      storePath,
      sessionKey,
      entry: { sessionId: "sess-main", updatedAt: 1, totalTokens: 0, totalTokensFresh: true },
    });

    const params = buildNameParams("/name", storePath);
    params.sessionEntry = getSessionEntry({ storePath, sessionKey });
    const result = await handleNameCommand(params, true);

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("Use /name <title>");
    expect(namingFields(getSessionEntry({ storePath, sessionKey })).title).toBeUndefined();
    expect(namingFields(getSessionEntry({ storePath, sessionKey })).label).toBeUndefined();
    expect(takeCommandSessionMetadataChanges(params.ctx)).toBeUndefined();
  });

  it("returns null when text commands are disabled", async () => {
    const storePath = await createStorePath();
    const params = buildNameParams("/name Anything", storePath);
    expect(await handleNameCommand(params, false)).toBeNull();
  });
});
