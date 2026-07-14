import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadSessionEntry, upsertSessionEntry } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { MARK_SEPARATOR } from "../commands-mark.shared.js";
import { buildBuiltinChatCommands } from "../commands-registry.shared.js";
import { loadCommandHandlers } from "./commands-handlers.runtime.js";
import { handleMarkCommand } from "./commands-mark.js";
import type { HandleCommandsParams } from "./commands-types.js";

const sessionKey = "agent:main:web:mark";
const pinnedAt = 1_700_000_000_000;
let tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => fs.rm(root, { recursive: true, force: true })));
  tempRoots = [];
});

async function createStorePath(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mark-command-"));
  tempRoots.push(root);
  return path.join(root, "sessions.json");
}

async function seedSession(storePath: string, language?: "english" | "中文"): Promise<void> {
  await upsertSessionEntry(
    { storePath, sessionKey },
    {
      sessionId: "sess-mark",
      updatedAt: 1,
      label: "测试会话",
      pinnedAt,
      ...(language ? { markLanguage: language } : {}),
    },
  );
}

function buildMarkParams(commandBodyNormalized: string, storePath: string): HandleCommandsParams {
  return {
    cfg: {} as OpenClawConfig,
    ctx: { Provider: "web", Surface: "web", CommandSource: "text" },
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

async function runMark(storePath: string, command: string) {
  const params = buildMarkParams(command, storePath);
  params.sessionEntry = loadSessionEntry({ storePath, sessionKey });
  return await handleMarkCommand(params, true);
}

describe("mark command", () => {
  it("registers the command with frontend choices and loads its handler", () => {
    const command = buildBuiltinChatCommands().find((entry) => entry.key === "mark");
    expect(command).toMatchObject({
      nativeName: "mark",
      textAliases: ["/mark"],
      acceptsArgs: true,
      argsMenu: "auto",
      category: "session",
    });
    expect(command?.args?.[0]?.choices).toHaveLength(9);
    expect(loadCommandHandlers()).toContain(handleMarkCommand);
  });

  it("lists built-in presets without changing the session", async () => {
    const storePath = await createStorePath();
    await seedSession(storePath);
    const result = await runMark(storePath, "/mark");
    expect(result?.reply?.text).toContain("🚧");
    expect(result?.reply?.text).toContain("/mark clear");
    expect(loadSessionEntry({ storePath, sessionKey })).toMatchObject({
      label: "测试会话",
      pinnedAt,
    });
  });

  it("adds, replaces, and clears a mark while preserving pinnedAt", async () => {
    const storePath = await createStorePath();
    await seedSession(storePath);

    await runMark(storePath, "/mark wip");
    expect(loadSessionEntry({ storePath, sessionKey })).toMatchObject({
      label: `🚧${MARK_SEPARATOR}测试会话`,
      pinnedAt,
      sessionMark: { symbol: "🚧", baseLabel: "测试会话" },
    });

    await runMark(storePath, "/mark 3");
    expect(loadSessionEntry({ storePath, sessionKey })).toMatchObject({
      label: `🔥${MARK_SEPARATOR}测试会话`,
      pinnedAt,
      sessionMark: { symbol: "🔥", baseLabel: "测试会话" },
    });

    await runMark(storePath, "/mark clear");
    const cleared = loadSessionEntry({ storePath, sessionKey });
    expect(cleared).toMatchObject({
      label: "测试会话",
      pinnedAt,
    });
    expect(cleared?.sessionMark).toBeUndefined();
  });

  it("switches reply language without changing the label or pinnedAt", async () => {
    const storePath = await createStorePath();
    await seedSession(storePath);

    const english = await runMark(storePath, "/mark english");
    expect(english?.reply?.text).toContain("switched to English");
    expect(loadSessionEntry({ storePath, sessionKey })).toMatchObject({
      label: "测试会话",
      pinnedAt,
      markLanguage: "english",
    });

    const englishError = await runMark(storePath, "/mark nonexistent");
    expect(englishError?.reply?.text).toContain("No mark matches");

    const chinese = await runMark(storePath, "/mark 中文");
    expect(chinese?.reply?.text).toContain("切换为中文");
    expect(loadSessionEntry({ storePath, sessionKey })).toMatchObject({
      label: "测试会话",
      pinnedAt,
      markLanguage: "中文",
    });
  });

  it("preserves arbitrary separator labels when clearing or applying a mark", async () => {
    const storePath = await createStorePath();
    await upsertSessionEntry(
      { storePath, sessionKey },
      {
        sessionId: "sess-mark",
        updatedAt: 1,
        label: `custom${MARK_SEPARATOR}name`,
        pinnedAt,
      },
    );
    await runMark(storePath, "/mark clear");
    expect(loadSessionEntry({ storePath, sessionKey })?.label).toBe(`custom${MARK_SEPARATOR}name`);

    await runMark(storePath, "/mark done");
    expect(loadSessionEntry({ storePath, sessionKey })).toMatchObject({
      label: `✅${MARK_SEPARATOR}custom${MARK_SEPARATOR}name`,
      sessionMark: { symbol: "✅", baseLabel: `custom${MARK_SEPARATOR}name` },
    });

    await runMark(storePath, "/mark clear");
    expect(loadSessionEntry({ storePath, sessionKey })?.label).toBe(`custom${MARK_SEPARATOR}name`);
  });
});
