import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions/types.js";

const hoisted = vi.hoisted(() => ({
  loadConfigMock: vi.fn(),
  loadSessionStoreMock: vi.fn(),
  updateSessionStoreMock: vi.fn(),
  archiveSessionTranscriptsMock: vi.fn(),
  getGlobalHookRunnerMock: vi.fn(),
  readFileMock: vi.fn(),
}));

vi.mock("../../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/config.js")>();
  return { ...actual, loadConfig: hoisted.loadConfigMock };
});

vi.mock("../../config/sessions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/sessions.js")>();
  return {
    ...actual,
    loadSessionStore: hoisted.loadSessionStoreMock,
    updateSessionStore: hoisted.updateSessionStoreMock,
  };
});

vi.mock("../../gateway/session-utils.fs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../gateway/session-utils.fs.js")>();
  return { ...actual, archiveSessionTranscripts: hoisted.archiveSessionTranscriptsMock };
});

vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: hoisted.getGlobalHookRunnerMock,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, default: { ...actual, readFile: hoisted.readFileMock } };
});

const { buildCommandTestParams } = await import("./commands.test-harness.js");
const { handlePowernapHereCommand } = await import("./commands-powernaphere.js");

const baseCfg = {
  commands: { text: true, restart: true },
  channels: { whatsapp: { allowFrom: ["*"] } },
} as unknown as OpenClawConfig;

function makeSessionEntry(overrides?: Partial<SessionEntry>): SessionEntry {
  return {
    sessionId: "old-session-id",
    updatedAt: Date.now() - 60_000,
    thinkingLevel: "medium",
    model: "claude-opus-4-6",
    label: "my-label",
    ...overrides,
  } as SessionEntry;
}

function setupDefaults() {
  hoisted.loadConfigMock.mockReturnValue(baseCfg);
  hoisted.loadSessionStoreMock.mockReturnValue({});
  hoisted.updateSessionStoreMock.mockImplementation(
    async (_path: string, mutator: (store: Record<string, SessionEntry>) => void) => {
      mutator({});
    },
  );
  hoisted.archiveSessionTranscriptsMock.mockReturnValue([]);
  hoisted.getGlobalHookRunnerMock.mockReturnValue(null);
  hoisted.readFileMock.mockRejectedValue(new Error("no file"));
}

describe("/powernaphere command", () => {
  beforeEach(() => {
    for (const mock of Object.values(hoisted)) {
      mock.mockClear();
    }
    setupDefaults();
  });

  it("returns null for non-matching commands", async () => {
    const params = buildCommandTestParams("/powernap", baseCfg);
    const result = await handlePowernapHereCommand(params, true);
    expect(result).toBeNull();
  });

  it("returns null when text commands are disabled", async () => {
    const params = buildCommandTestParams("/powernaphere", baseCfg);
    const result = await handlePowernapHereCommand(params, false);
    expect(result).toBeNull();
  });

  it("rejects unauthorized sender silently", async () => {
    const params = buildCommandTestParams("/powernaphere", baseCfg);
    params.command = { ...params.command, isAuthorizedSender: false };
    const result = await handlePowernapHereCommand(params, true);
    expect(result).not.toBeNull();
    expect(result!.shouldContinue).toBe(false);
    expect(result!.reply).toBeUndefined();
  });

  it("rejects cron sessions", async () => {
    const params = buildCommandTestParams("/powernaphere", baseCfg);
    (params as Record<string, unknown>).sessionKey = "agent:main:cron:daily:run:abc";
    const result = await handlePowernapHereCommand(params, true);
    expect(result!.reply?.text).toContain("Can't powernap a cron session");
  });

  it("returns no session message when no session entry", async () => {
    const params = buildCommandTestParams("/powernaphere", baseCfg);
    // sessionEntry is undefined by default from harness
    const result = await handlePowernapHereCommand(params, true);
    expect(result!.reply?.text).toContain("No active session to reset");
  });

  it("resets just the current session and preserves preferences", async () => {
    const entry = makeSessionEntry({
      sessionId: "my-sess-id",
      thinkingLevel: "high",
      model: "claude-opus-4-6",
      label: "important-chat",
    });

    let mutatedStore: Record<string, SessionEntry> = {};
    hoisted.updateSessionStoreMock.mockImplementation(
      async (_path: string, mutator: (store: Record<string, SessionEntry>) => void) => {
        mutatedStore = { "agent:main:main": { ...entry } };
        mutator(mutatedStore);
      },
    );

    const params = buildCommandTestParams("/powernaphere", baseCfg);
    params.sessionEntry = entry;
    const result = await handlePowernapHereCommand(params, true);

    expect(result!.reply?.text).toContain("Session reset");
    expect(result!.reply?.text).toContain("Everything else untouched");

    const resetEntry = mutatedStore["agent:main:main"];
    expect(resetEntry).toBeDefined();
    expect(resetEntry.sessionId).not.toBe("my-sess-id");
    expect(resetEntry.thinkingLevel).toBe("high");
    expect(resetEntry.model).toBe("claude-opus-4-6");
    expect(resetEntry.label).toBe("important-chat");
    expect(resetEntry.inputTokens).toBe(0);
    expect(resetEntry.outputTokens).toBe(0);
  });

  it("archives the old transcript", async () => {
    const entry = makeSessionEntry({
      sessionId: "archive-me",
      sessionFile: "/tmp/archive-me.jsonl",
    });

    const params = buildCommandTestParams("/powernaphere", baseCfg);
    params.sessionEntry = entry;
    await handlePowernapHereCommand(params, true);

    expect(hoisted.archiveSessionTranscriptsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "archive-me",
        reason: "reset",
      }),
    );
  });

  it("fires before_reset hook for the session", async () => {
    const runBeforeResetMock = vi.fn().mockResolvedValue(undefined);
    hoisted.getGlobalHookRunnerMock.mockReturnValue({
      hasHooks: (name: string) => name === "before_reset",
      runBeforeReset: runBeforeResetMock,
    });
    hoisted.readFileMock.mockResolvedValue(
      '{"type":"message","message":{"role":"user","content":"hi"}}\n',
    );

    const entry = makeSessionEntry({
      sessionId: "hook-sess",
      sessionFile: "/tmp/hook-sess.jsonl",
    });
    const params = buildCommandTestParams("/powernaphere", baseCfg);
    params.sessionEntry = entry;
    await handlePowernapHereCommand(params, true);

    expect(runBeforeResetMock).toHaveBeenCalledOnce();
    expect(runBeforeResetMock).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "powernap" }),
      expect.objectContaining({ sessionId: "hook-sess" }),
    );
  });
});
