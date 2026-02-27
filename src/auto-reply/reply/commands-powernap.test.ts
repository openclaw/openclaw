import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions/types.js";

const hoisted = vi.hoisted(() => ({
  loadConfigMock: vi.fn(),
  readConfigFileSnapshotMock: vi.fn(),
  loadSessionStoreMock: vi.fn(),
  updateSessionStoreMock: vi.fn(),
  loadSubagentRegistryFromDiskMock: vi.fn(),
  archiveSessionTranscriptsMock: vi.fn(),
  scheduleGatewaySigusr1RestartMock: vi.fn(),
  writeRestartSentinelMock: vi.fn(),
  resolveStateDirMock: vi.fn().mockReturnValue("/tmp/openclaw-test"),
  mkdirSyncMock: vi.fn(),
  writeFileSyncMock: vi.fn(),
  getGlobalHookRunnerMock: vi.fn(),
  setPowernapDrainingMock: vi.fn(),
  readFileMock: vi.fn(),
}));

vi.mock("../../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/config.js")>();
  return {
    ...actual,
    loadConfig: hoisted.loadConfigMock,
    readConfigFileSnapshot: hoisted.readConfigFileSnapshotMock,
  };
});

vi.mock("../../config/sessions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/sessions.js")>();
  return {
    ...actual,
    loadSessionStore: hoisted.loadSessionStoreMock,
    updateSessionStore: hoisted.updateSessionStoreMock,
  };
});

vi.mock("../../agents/subagent-registry.store.js", () => ({
  loadSubagentRegistryFromDisk: hoisted.loadSubagentRegistryFromDiskMock,
}));

vi.mock("../../gateway/session-utils.fs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../gateway/session-utils.fs.js")>();
  return { ...actual, archiveSessionTranscripts: hoisted.archiveSessionTranscriptsMock };
});

vi.mock("../../infra/restart.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/restart.js")>();
  return {
    ...actual,
    scheduleGatewaySigusr1Restart: hoisted.scheduleGatewaySigusr1RestartMock,
  };
});

vi.mock("../../infra/restart-sentinel.js", () => ({
  writeRestartSentinel: hoisted.writeRestartSentinelMock,
}));

vi.mock("../../config/paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/paths.js")>();
  return { ...actual, resolveStateDir: hoisted.resolveStateDirMock };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    mkdirSync: hoisted.mkdirSyncMock,
    writeFileSync: hoisted.writeFileSyncMock,
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, default: { ...actual, readFile: hoisted.readFileMock } };
});

vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: hoisted.getGlobalHookRunnerMock,
}));

vi.mock("./powernap-drain.js", () => ({
  setPowernapDraining: hoisted.setPowernapDrainingMock,
  isPowernapDraining: vi.fn(() => false),
}));

const { buildCommandTestParams } = await import("./commands.test-harness.js");
const { handlePowernapCommand } = await import("./commands-powernap.js");

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

function setupDefaultMocks(sessionStore?: Record<string, SessionEntry>) {
  hoisted.loadConfigMock.mockReturnValue(baseCfg);
  hoisted.readConfigFileSnapshotMock.mockResolvedValue({ valid: true, issues: [] });
  hoisted.loadSessionStoreMock.mockReturnValue(sessionStore ?? {});
  hoisted.updateSessionStoreMock.mockImplementation(
    async (_path: string, mutator: (store: Record<string, SessionEntry>) => void) => {
      const store = { ...sessionStore };
      mutator(store);
      return store;
    },
  );
  hoisted.loadSubagentRegistryFromDiskMock.mockReturnValue(new Map());
  hoisted.archiveSessionTranscriptsMock.mockReturnValue([]);
  hoisted.scheduleGatewaySigusr1RestartMock.mockReturnValue({ ok: true });
  hoisted.writeRestartSentinelMock.mockResolvedValue("/tmp/sentinel.json");
  hoisted.resolveStateDirMock.mockReturnValue("/tmp/openclaw-test");
  hoisted.getGlobalHookRunnerMock.mockReturnValue(null);
  hoisted.readFileMock.mockRejectedValue(new Error("no file"));
}

describe("/powernap command", () => {
  beforeEach(() => {
    for (const mock of Object.values(hoisted)) {
      mock.mockClear();
    }
    setupDefaultMocks();
  });

  it("returns null for non-matching commands", async () => {
    const params = buildCommandTestParams("/status", baseCfg);
    const result = await handlePowernapCommand(params, true);
    expect(result).toBeNull();
  });

  it("returns null when text commands are disabled", async () => {
    const params = buildCommandTestParams("/powernap", baseCfg);
    const result = await handlePowernapCommand(params, false);
    expect(result).toBeNull();
  });

  it("rejects unauthorized sender silently", async () => {
    const params = buildCommandTestParams("/powernap", baseCfg);
    params.command = { ...params.command, isAuthorizedSender: false };
    const result = await handlePowernapCommand(params, true);
    expect(result).not.toBeNull();
    expect(result!.shouldContinue).toBe(false);
    expect(result!.reply).toBeUndefined();
  });

  it("resets all sessions in the store", async () => {
    const store: Record<string, SessionEntry> = {
      "agent:main:whatsapp:group:123": makeSessionEntry({ sessionId: "aaa" }),
      "agent:main:whatsapp:group:456": makeSessionEntry({ sessionId: "bbb" }),
      "agent:main:main": makeSessionEntry({ sessionId: "ccc" }),
    };
    setupDefaultMocks(store);

    const params = buildCommandTestParams("/powernap", baseCfg);
    const result = await handlePowernapCommand(params, true);

    expect(result!.shouldContinue).toBe(false);
    expect(result!.reply?.text).toContain("Sessions reset: 3");

    // Verify updateSessionStore was called
    expect(hoisted.updateSessionStoreMock).toHaveBeenCalled();

    // Verify archive was called for each session
    expect(hoisted.archiveSessionTranscriptsMock).toHaveBeenCalledTimes(3);
  });

  it("preserves session user preferences during reset", async () => {
    const entry = makeSessionEntry({
      sessionId: "preserve-me",
      thinkingLevel: "high",
      model: "claude-opus-4-6",
      label: "important-chat",
      verboseLevel: "full",
      sendPolicy: "allow",
    });
    const store: Record<string, SessionEntry> = { "agent:main:main": entry };

    let mutatedStore: Record<string, SessionEntry> = {};
    setupDefaultMocks(store);
    hoisted.updateSessionStoreMock.mockImplementation(
      async (_path: string, mutator: (store: Record<string, SessionEntry>) => void) => {
        mutatedStore = { "agent:main:main": { ...entry } };
        mutator(mutatedStore);
      },
    );

    const params = buildCommandTestParams("/powernap", baseCfg);
    await handlePowernapCommand(params, true);

    const resetEntry = mutatedStore["agent:main:main"];
    expect(resetEntry).toBeDefined();
    expect(resetEntry.sessionId).not.toBe("preserve-me");
    expect(resetEntry.thinkingLevel).toBe("high");
    expect(resetEntry.model).toBe("claude-opus-4-6");
    expect(resetEntry.label).toBe("important-chat");
    expect(resetEntry.systemSent).toBe(false);
    expect(resetEntry.inputTokens).toBe(0);
    expect(resetEntry.outputTokens).toBe(0);
    expect(resetEntry.totalTokens).toBe(0);
  });

  it("skips cron sessions", async () => {
    const store: Record<string, SessionEntry> = {
      "agent:main:main": makeSessionEntry({ sessionId: "keep" }),
      "agent:main:cron:daily-job:run:abc": makeSessionEntry({ sessionId: "cron-run" }),
    };

    let resetKeys: string[] = [];
    setupDefaultMocks(store);
    hoisted.updateSessionStoreMock.mockImplementation(
      async (_path: string, mutator: (store: Record<string, SessionEntry>) => void) => {
        const mutable: Record<string, SessionEntry> = {};
        for (const [k, v] of Object.entries(store)) {
          mutable[k] = { ...v };
        }
        mutator(mutable);
        resetKeys = [];
        for (const key of Object.keys(mutable)) {
          if (mutable[key].sessionId !== store[key]?.sessionId) {
            resetKeys.push(key);
          }
        }
      },
    );

    const params = buildCommandTestParams("/powernap", baseCfg);
    const result = await handlePowernapCommand(params, true);

    expect(result!.reply?.text).toContain("Sessions reset: 1");
    // Cron session should NOT be in the reset list
    expect(resetKeys).toContain("agent:main:main");
    expect(resetKeys).not.toContain("agent:main:cron:daily-job:run:abc");
  });

  it("snapshots active subagents to disk", async () => {
    const runs = new Map([
      [
        "run-1",
        {
          runId: "run-1",
          childSessionKey: "agent:beta:subagent:abc",
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          task: "Research competitor pricing",
          cleanup: "keep" as const,
          createdAt: Date.now() - 5000,
          startedAt: Date.now() - 4000,
          label: "research-bot",
          model: "claude-sonnet-4-6",
          spawnMode: "run" as const,
          // endedAt is undefined → active
        },
      ],
      [
        "run-2",
        {
          runId: "run-2",
          childSessionKey: "agent:gamma:subagent:def",
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          task: "Old completed task",
          cleanup: "delete" as const,
          createdAt: Date.now() - 60000,
          startedAt: Date.now() - 59000,
          endedAt: Date.now() - 30000, // ended → not active
        },
      ],
    ]);
    hoisted.loadSubagentRegistryFromDiskMock.mockReturnValue(runs);

    const params = buildCommandTestParams("/powernap", baseCfg);
    const result = await handlePowernapCommand(params, true);

    expect(result!.reply?.text).toContain("Active subagents snapshotted: 1");
    expect(result!.reply?.text).toContain("research-bot");

    // Verify snapshot file was written
    expect(hoisted.writeFileSyncMock).toHaveBeenCalledOnce();
    const writtenContent = JSON.parse(hoisted.writeFileSyncMock.mock.calls[0][1] as string);
    expect(writtenContent.reason).toBe("powernap");
    expect(writtenContent.activeRuns).toHaveLength(1);
    expect(writtenContent.activeRuns[0].task).toBe("Research competitor pricing");
  });

  it("handles empty store gracefully", async () => {
    setupDefaultMocks({});
    const params = buildCommandTestParams("/powernap", baseCfg);
    const result = await handlePowernapCommand(params, true);

    expect(result!.reply?.text).toContain("Sessions reset: 0");
    expect(result!.reply?.text).toContain("No active subagents.");
  });

  it("handles no active subagents gracefully", async () => {
    hoisted.loadSubagentRegistryFromDiskMock.mockReturnValue(new Map());

    const params = buildCommandTestParams("/powernap", baseCfg);
    const result = await handlePowernapCommand(params, true);

    expect(result!.reply?.text).toContain("No active subagents.");
  });

  it("schedules restart with 3s delay when enabled", async () => {
    const params = buildCommandTestParams("/powernap", baseCfg);
    await handlePowernapCommand(params, true);

    expect(hoisted.scheduleGatewaySigusr1RestartMock).toHaveBeenCalledWith({
      delayMs: 3000,
      reason: "/powernap",
    });
  });

  it("skips restart when commands.restart is false", async () => {
    const cfg = {
      ...baseCfg,
      commands: { ...baseCfg.commands, restart: false },
    } as unknown as OpenClawConfig;
    hoisted.loadConfigMock.mockReturnValue(cfg);

    const params = buildCommandTestParams("/powernap", cfg);
    const result = await handlePowernapCommand(params, true);

    expect(hoisted.scheduleGatewaySigusr1RestartMock).not.toHaveBeenCalled();
    expect(result!.reply?.text).toContain("Gateway restart skipped");
  });

  it("writes restart sentinel before scheduling restart", async () => {
    const params = buildCommandTestParams("/powernap", baseCfg);
    await handlePowernapCommand(params, true);

    expect(hoisted.writeRestartSentinelMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "restart",
        status: "ok",
        sessionKey: "agent:main:main",
      }),
    );
  });

  it("reply includes gateway restart line when scheduled", async () => {
    const params = buildCommandTestParams("/powernap", baseCfg);
    const result = await handlePowernapCommand(params, true);

    expect(result!.reply?.text).toContain("Gateway restarting in 3s. Back shortly.");
  });

  // --- New tests for downside fixes ---

  it("fires before_reset hooks for each session", async () => {
    const runBeforeResetMock = vi.fn().mockResolvedValue(undefined);
    hoisted.getGlobalHookRunnerMock.mockReturnValue({
      hasHooks: (name: string) => name === "before_reset",
      runBeforeReset: runBeforeResetMock,
    });
    hoisted.readFileMock.mockResolvedValue(
      '{"type":"message","message":{"role":"user","content":"hi"}}\n',
    );

    const store: Record<string, SessionEntry> = {
      "agent:main:main": makeSessionEntry({
        sessionId: "sess-a",
        sessionFile: "/tmp/sess-a.jsonl",
      }),
      "agent:main:whatsapp:group:123": makeSessionEntry({
        sessionId: "sess-b",
        sessionFile: "/tmp/sess-b.jsonl",
      }),
    };
    setupDefaultMocks(store);
    // Re-apply hook runner after setupDefaultMocks clears it
    hoisted.getGlobalHookRunnerMock.mockReturnValue({
      hasHooks: (name: string) => name === "before_reset",
      runBeforeReset: runBeforeResetMock,
    });
    hoisted.readFileMock.mockResolvedValue(
      '{"type":"message","message":{"role":"user","content":"hi"}}\n',
    );

    const params = buildCommandTestParams("/powernap", baseCfg);
    await handlePowernapCommand(params, true);

    expect(runBeforeResetMock).toHaveBeenCalledTimes(2);
    // Verify the hook receives correct event shape
    expect(runBeforeResetMock).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "powernap" }),
      expect.objectContaining({ agentId: expect.any(String) }),
    );
  });

  it("restart sentinel includes subagent task details", async () => {
    const runs = new Map([
      [
        "run-1",
        {
          runId: "run-1",
          childSessionKey: "agent:beta:subagent:abc",
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          task: "Research competitor pricing",
          cleanup: "keep" as const,
          createdAt: Date.now() - 5000,
          startedAt: Date.now() - 4000,
          label: "research-bot",
          model: "claude-sonnet-4-6",
          spawnMode: "run" as const,
        },
      ],
    ]);
    hoisted.loadSubagentRegistryFromDiskMock.mockReturnValue(runs);

    const params = buildCommandTestParams("/powernap", baseCfg);
    await handlePowernapCommand(params, true);

    const sentinelCall = hoisted.writeRestartSentinelMock.mock.calls[0][0];
    expect(sentinelCall.message).toContain("Interrupted subagents (1):");
    expect(sentinelCall.message).toContain("research-bot");
    expect(sentinelCall.message).toContain("Research competitor pricing");
  });

  it("activates drain before reset and keeps it active when restart scheduled", async () => {
    const params = buildCommandTestParams("/powernap", baseCfg);
    await handlePowernapCommand(params, true);

    // Drain should be activated (true) but NOT deactivated (restart will clear it)
    const calls = hoisted.setPowernapDrainingMock.mock.calls.map((c: unknown[]) => c[0]);
    expect(calls).toContain(true);
    expect(calls).not.toContain(false);
  });

  it("clears drain when restart is disabled", async () => {
    const cfg = {
      ...baseCfg,
      commands: { ...baseCfg.commands, restart: false },
    } as unknown as OpenClawConfig;
    hoisted.loadConfigMock.mockReturnValue(cfg);

    const params = buildCommandTestParams("/powernap", cfg);
    await handlePowernapCommand(params, true);

    // Drain should be set to true then cleared (false) since no restart
    const calls = hoisted.setPowernapDrainingMock.mock.calls.map((c: unknown[]) => c[0]);
    expect(calls).toContain(true);
    expect(calls).toContain(false);
  });

  it("skips restart and warns when config is invalid", async () => {
    hoisted.readConfigFileSnapshotMock.mockResolvedValue({
      valid: false,
      issues: [{ path: "media", message: 'Unrecognized key: "localRoots"' }],
    });

    const params = buildCommandTestParams("/powernap", baseCfg);
    const result = await handlePowernapCommand(params, true);

    // Sessions should still be reset
    expect(result!.reply?.text).toContain("Sessions reset: 0");
    // Restart should be skipped with config error in reason
    expect(result!.reply?.text).toContain("Gateway restart skipped");
    expect(result!.reply?.text).toContain("config invalid");
    // Restart should NOT be scheduled
    expect(hoisted.scheduleGatewaySigusr1RestartMock).not.toHaveBeenCalled();
    // Drain should be cleared since no restart
    const calls = hoisted.setPowernapDrainingMock.mock.calls.map((c: unknown[]) => c[0]);
    expect(calls).toContain(false);
  });

  it("archives transcripts after hooks have run", async () => {
    const hookCallOrder: string[] = [];
    const runBeforeResetMock = vi.fn().mockImplementation(async () => {
      hookCallOrder.push("hook");
    });
    hoisted.getGlobalHookRunnerMock.mockReturnValue({
      hasHooks: (name: string) => name === "before_reset",
      runBeforeReset: runBeforeResetMock,
    });
    hoisted.archiveSessionTranscriptsMock.mockImplementation(() => {
      hookCallOrder.push("archive");
    });

    const store: Record<string, SessionEntry> = {
      "agent:main:main": makeSessionEntry({ sessionId: "sess-a" }),
    };
    setupDefaultMocks(store);
    // Re-apply custom mocks after setupDefaultMocks overwrites them
    hoisted.getGlobalHookRunnerMock.mockReturnValue({
      hasHooks: (name: string) => name === "before_reset",
      runBeforeReset: runBeforeResetMock,
    });
    hoisted.archiveSessionTranscriptsMock.mockImplementation(() => {
      hookCallOrder.push("archive");
    });

    const params = buildCommandTestParams("/powernap", baseCfg);
    await handlePowernapCommand(params, true);

    // Hook should fire before archive
    expect(hookCallOrder.indexOf("hook")).toBeLessThan(hookCallOrder.indexOf("archive"));
  });
});
