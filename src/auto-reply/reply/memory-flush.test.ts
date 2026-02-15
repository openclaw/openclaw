import fsNative from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { TemplateContext } from "../templating.js";
import type { FollowupRun } from "./queue.js";

const runWithModelFallbackMock = vi.fn();
const runEmbeddedPiAgentMock = vi.fn();

vi.mock("../../agents/model-fallback.js", () => ({
  runWithModelFallback: (...args: unknown[]) => runWithModelFallbackMock(...args),
}));

vi.mock("../../agents/pi-embedded.js", () => ({
  runEmbeddedPiAgent: (...args: unknown[]) => runEmbeddedPiAgentMock(...args),
}));

import {
  estimatePromptTokensForMemoryFlush,
  readPromptTokensFromSessionLog,
  resolveEffectivePromptTokens,
  runMemoryFlushIfNeeded,
} from "./agent-runner-memory.js";
import {
  DEFAULT_MEMORY_FLUSH_SOFT_TOKENS,
  resolveMemoryFlushContextWindowTokens,
  resolveMemoryFlushSettings,
  shouldRunMemoryFlush,
} from "./memory-flush.js";

afterEach(() => {
  runWithModelFallbackMock.mockReset();
  runEmbeddedPiAgentMock.mockReset();
});

function createFollowupRun(params: {
  cfg: OpenClawConfig;
  sessionId: string;
  sessionKey: string;
  sessionFile: string;
  provider?: string;
  model?: string;
}): FollowupRun {
  return {
    prompt: "hello",
    summaryLine: "hello",
    enqueuedAt: Date.now(),
    run: {
      agentId: "main",
      agentDir: "/tmp/agent",
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      messageProvider: "whatsapp",
      sessionFile: params.sessionFile,
      workspaceDir: "/tmp",
      config: params.cfg,
      skillsSnapshot: {},
      provider: params.provider ?? "anthropic",
      model: params.model ?? "claude",
      thinkLevel: "low",
      verboseLevel: "off",
      elevatedLevel: "off",
      bashElevated: {
        enabled: false,
        allowed: false,
        defaultLevel: "off",
      },
      timeoutMs: 1_000,
      blockReplyBreak: "message_end",
    },
  } as unknown as FollowupRun;
}

const baseSessionCtx = {
  Provider: "whatsapp",
  OriginatingTo: "+15550001111",
  AccountId: "primary",
  MessageSid: "msg",
} as unknown as TemplateContext;

describe("memory flush settings", () => {
  it("defaults to enabled with fallback prompt and system prompt", () => {
    const settings = resolveMemoryFlushSettings();
    expect(settings).not.toBeNull();
    expect(settings?.enabled).toBe(true);
    expect(settings?.prompt.length).toBeGreaterThan(0);
    expect(settings?.systemPrompt.length).toBeGreaterThan(0);
  });

  it("respects disable flag", () => {
    expect(
      resolveMemoryFlushSettings({
        agents: {
          defaults: { compaction: { memoryFlush: { enabled: false } } },
        },
      }),
    ).toBeNull();
  });

  it("appends NO_REPLY hint when missing", () => {
    const settings = resolveMemoryFlushSettings({
      agents: {
        defaults: {
          compaction: {
            memoryFlush: {
              prompt: "Write memories now.",
              systemPrompt: "Flush memory.",
            },
          },
        },
      },
    });
    expect(settings?.prompt).toContain("NO_REPLY");
    expect(settings?.systemPrompt).toContain("NO_REPLY");
  });
});

describe("shouldRunMemoryFlush", () => {
  it("requires totalTokens and threshold", () => {
    expect(
      shouldRunMemoryFlush({
        entry: { totalTokens: 0 },
        contextWindowTokens: 16_000,
        reserveTokensFloor: 20_000,
        softThresholdTokens: DEFAULT_MEMORY_FLUSH_SOFT_TOKENS,
      }),
    ).toBe(false);
  });

  it("skips when entry is missing", () => {
    expect(
      shouldRunMemoryFlush({
        entry: undefined,
        contextWindowTokens: 16_000,
        reserveTokensFloor: 1_000,
        softThresholdTokens: DEFAULT_MEMORY_FLUSH_SOFT_TOKENS,
      }),
    ).toBe(false);
  });

  it("skips when totalTokens is undefined in entry", () => {
    // This is the most common failure mode: sessionEntry exists but totalTokens was never set
    expect(
      shouldRunMemoryFlush({
        entry: { totalTokens: undefined },
        contextWindowTokens: 100_000,
        reserveTokensFloor: 20_000,
        softThresholdTokens: 4_000,
      }),
    ).toBe(false);
  });

  it("skips when totalTokens is null in entry", () => {
    expect(
      shouldRunMemoryFlush({
        entry: { totalTokens: null as unknown as number | undefined },
        contextWindowTokens: 100_000,
        reserveTokensFloor: 20_000,
        softThresholdTokens: 4_000,
      }),
    ).toBe(false);
  });

  it("skips when totalTokens is negative", () => {
    expect(
      shouldRunMemoryFlush({
        entry: { totalTokens: -1 },
        contextWindowTokens: 100_000,
        reserveTokensFloor: 20_000,
        softThresholdTokens: 4_000,
      }),
    ).toBe(false);
  });

  it("skips when under threshold", () => {
    expect(
      shouldRunMemoryFlush({
        entry: { totalTokens: 10_000 },
        contextWindowTokens: 100_000,
        reserveTokensFloor: 20_000,
        softThresholdTokens: 10_000,
      }),
    ).toBe(false);
  });

  it("triggers at the threshold boundary", () => {
    expect(
      shouldRunMemoryFlush({
        entry: { totalTokens: 85 },
        contextWindowTokens: 100,
        reserveTokensFloor: 10,
        softThresholdTokens: 5,
      }),
    ).toBe(true);
  });

  it("skips when already flushed for current compaction count", () => {
    expect(
      shouldRunMemoryFlush({
        entry: {
          totalTokens: 90_000,
          compactionCount: 2,
          memoryFlushCompactionCount: 2,
        },
        contextWindowTokens: 100_000,
        reserveTokensFloor: 5_000,
        softThresholdTokens: 2_000,
      }),
    ).toBe(false);
  });

  it("runs when above threshold and not flushed", () => {
    expect(
      shouldRunMemoryFlush({
        entry: { totalTokens: 96_000, compactionCount: 1 },
        contextWindowTokens: 100_000,
        reserveTokensFloor: 5_000,
        softThresholdTokens: 2_000,
      }),
    ).toBe(true);
  });

  it("ignores stale cached totals", () => {
    expect(
      shouldRunMemoryFlush({
        entry: { totalTokens: 96_000, totalTokensFresh: false, compactionCount: 1 },
        contextWindowTokens: 100_000,
        reserveTokensFloor: 5_000,
        softThresholdTokens: 2_000,
      }),
    ).toBe(false);
  });
});

describe("memory flush prompt estimates", () => {
  it("returns undefined for blank prompt text", () => {
    expect(estimatePromptTokensForMemoryFlush("   ")).toBeUndefined();
  });

  it("returns a positive integer estimate for prompt text", () => {
    const estimate = estimatePromptTokensForMemoryFlush("Hello memory flush.");
    expect(estimate).toBeTypeOf("number");
    expect(estimate).toBeGreaterThan(0);
    expect(Number.isInteger(estimate)).toBe(true);
  });

  it("projects base prompt + last output + current prompt estimate", () => {
    expect(resolveEffectivePromptTokens(120, 20, 30)).toBe(170);
  });
});

describe("memory flush transcript fallback", () => {
  it("uses the last usage entry from the session transcript", async () => {
    const tmp = await fsPromises.mkdtemp(path.join(os.tmpdir(), "openclaw-flush-"));
    const logPath = path.join(tmp, "session.jsonl");
    const storePath = path.join(tmp, "sessions.json");
    const lines = [
      JSON.stringify({ message: { usage: { input: 10, output: 5 } } }),
      JSON.stringify({ usage: { total: 25 } }),
      JSON.stringify({ usage: { input: 3, cacheRead: 2, cacheWrite: 1, output: 4 } }),
    ];
    await fsPromises.writeFile(logPath, lines.join("\n"), "utf-8");

    const sessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      sessionFile: logPath,
    };
    const snapshot = await readPromptTokensFromSessionLog("session", sessionEntry, "main", {
      storePath,
    });

    expect(snapshot).toEqual({ promptTokens: 6, outputTokens: 4 });
  });

  it("resolves relative sessionFile entries against the session store directory", async () => {
    const tmp = await fsPromises.mkdtemp(path.join(os.tmpdir(), "openclaw-flush-"));
    const logPath = path.join(tmp, "session.jsonl");
    const storePath = path.join(tmp, "sessions.json");
    await fsPromises.writeFile(
      logPath,
      JSON.stringify({ usage: { input: 60, output: 10 } }),
      "utf-8",
    );

    const sessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      sessionFile: "session.jsonl",
    };
    const snapshot = await readPromptTokensFromSessionLog("session", sessionEntry, "main", {
      storePath,
    });

    expect(snapshot).toEqual({ promptTokens: 60, outputTokens: 10 });
  });

  it("derives prompt/output snapshot when usage.total is a zero placeholder", async () => {
    const tmp = await fsPromises.mkdtemp(path.join(os.tmpdir(), "openclaw-flush-"));
    const logPath = path.join(tmp, "session.jsonl");
    const storePath = path.join(tmp, "sessions.json");
    const lines = [JSON.stringify({ usage: { total: 0, input: 80, output: 20 } })];
    await fsPromises.writeFile(logPath, lines.join("\n"), "utf-8");

    const sessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      sessionFile: logPath,
    };
    const snapshot = await readPromptTokensFromSessionLog("session", sessionEntry, "main", {
      storePath,
    });

    expect(snapshot).toEqual({ promptTokens: 80, outputTokens: 20 });
  });

  it("ignores trailing zero-usage transcript lines", async () => {
    const tmp = await fsPromises.mkdtemp(path.join(os.tmpdir(), "openclaw-flush-"));
    const logPath = path.join(tmp, "session.jsonl");
    const storePath = path.join(tmp, "sessions.json");
    const lines = [
      JSON.stringify({ usage: { input: 100, output: 20 } }),
      JSON.stringify({ usage: { input: 0, output: 0, totalTokens: 0 } }),
    ];
    await fsPromises.writeFile(logPath, lines.join("\n"), "utf-8");

    const sessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      sessionFile: logPath,
    };
    const snapshot = await readPromptTokensFromSessionLog("session", sessionEntry, "main", {
      storePath,
    });

    expect(snapshot).toEqual({ promptTokens: 100, outputTokens: 20 });
  });
});

describe("runMemoryFlushIfNeeded transcript fallback", () => {
  it("uses transcript prompt/output when totalTokensFresh is false and only persists prompt tokens", async () => {
    runWithModelFallbackMock.mockImplementation(
      async ({
        provider,
        model,
        run,
      }: {
        provider: string;
        model: string;
        run: (provider: string, model: string) => Promise<unknown>;
      }) => ({
        result: await run(provider, model),
        provider,
        model,
      }),
    );
    runEmbeddedPiAgentMock.mockResolvedValue({ payloads: [], meta: {} });

    const tmp = await fsPromises.mkdtemp(path.join(os.tmpdir(), "openclaw-flush-"));
    const logPath = path.join(tmp, "session.jsonl");
    const transcriptPromptTokens = 40;
    const transcriptOutputTokens = 20;
    await fsPromises.writeFile(
      logPath,
      JSON.stringify({ usage: { input: transcriptPromptTokens, output: transcriptOutputTokens } }),
      "utf-8",
    );

    const storePath = path.join(tmp, "sessions.json");
    const sessionKey = "main";
    const sessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      sessionFile: logPath,
      totalTokens: 5,
      totalTokensFresh: false,
      compactionCount: 0,
    };
    await fsPromises.writeFile(
      storePath,
      JSON.stringify({ [sessionKey]: sessionEntry }, null, 2),
      "utf-8",
    );

    const promptText = "Capture a brief memory note.";
    const estimate = estimatePromptTokensForMemoryFlush(promptText);
    expect(estimate).toBeTypeOf("number");
    expect(estimate).toBeGreaterThan(0);
    if (!estimate) {
      throw new Error("Expected prompt estimate");
    }

    const reserveTokensFloor = 1;
    const softThresholdTokens = 1;
    const projected = transcriptPromptTokens + transcriptOutputTokens + estimate;
    const threshold = projected - 1;
    const contextWindowTokens = threshold + reserveTokensFloor + softThresholdTokens;
    const cfg = {
      agents: {
        defaults: {
          compaction: {
            reserveTokensFloor,
            memoryFlush: { softThresholdTokens },
          },
        },
      },
    } as OpenClawConfig;
    const followupRun = createFollowupRun({
      cfg,
      sessionId: "session",
      sessionKey,
      sessionFile: logPath,
    });

    await runMemoryFlushIfNeeded({
      cfg,
      followupRun,
      promptForEstimate: promptText,
      sessionCtx: baseSessionCtx,
      defaultModel: "anthropic/claude-opus-4-5",
      agentCfgContextTokens: contextWindowTokens,
      resolvedVerboseLevel: "off",
      sessionEntry,
      sessionStore: { [sessionKey]: sessionEntry },
      sessionKey,
      storePath,
      isHeartbeat: false,
    });

    expect(runWithModelFallbackMock).toHaveBeenCalledTimes(1);
    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);

    const stored = JSON.parse(await fsPromises.readFile(storePath, "utf-8"));
    expect(stored[sessionKey].totalTokens).toBe(transcriptPromptTokens);
    expect(stored[sessionKey].totalTokensFresh).toBe(true);
    expect(stored[sessionKey].totalTokens).not.toBe(projected);
  });

  it("uses transcript fallback when totalTokensFresh is missing", async () => {
    runWithModelFallbackMock.mockImplementation(
      async ({
        provider,
        model,
        run,
      }: {
        provider: string;
        model: string;
        run: (provider: string, model: string) => Promise<unknown>;
      }) => ({
        result: await run(provider, model),
        provider,
        model,
      }),
    );
    runEmbeddedPiAgentMock.mockResolvedValue({ payloads: [], meta: {} });

    const tmp = await fsPromises.mkdtemp(path.join(os.tmpdir(), "openclaw-flush-"));
    const logPath = path.join(tmp, "session.jsonl");
    await fsPromises.writeFile(
      logPath,
      JSON.stringify({ usage: { input: 30, output: 10 } }),
      "utf-8",
    );

    const storePath = path.join(tmp, "sessions.json");
    const sessionKey = "main";
    const sessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      sessionFile: logPath,
      totalTokens: 25,
      compactionCount: 0,
    };
    await fsPromises.writeFile(
      storePath,
      JSON.stringify({ [sessionKey]: sessionEntry }, null, 2),
      "utf-8",
    );

    const promptText = "store memory";
    const estimate = estimatePromptTokensForMemoryFlush(promptText);
    expect(estimate).toBeTypeOf("number");
    expect(estimate).toBeGreaterThan(0);
    if (!estimate) {
      throw new Error("Expected prompt estimate");
    }

    const reserveTokensFloor = 1;
    const softThresholdTokens = 1;
    const projected = 30 + 10 + estimate;
    const threshold = projected - 1;
    const contextWindowTokens = threshold + reserveTokensFloor + softThresholdTokens;
    const cfg = {
      agents: {
        defaults: {
          compaction: {
            reserveTokensFloor,
            memoryFlush: { softThresholdTokens },
          },
        },
      },
    } as OpenClawConfig;
    const followupRun = createFollowupRun({
      cfg,
      sessionId: "session",
      sessionKey,
      sessionFile: logPath,
    });

    await runMemoryFlushIfNeeded({
      cfg,
      followupRun,
      promptForEstimate: promptText,
      sessionCtx: baseSessionCtx,
      defaultModel: "anthropic/claude-opus-4-5",
      agentCfgContextTokens: contextWindowTokens,
      resolvedVerboseLevel: "off",
      sessionEntry,
      sessionStore: { [sessionKey]: sessionEntry },
      sessionKey,
      storePath,
      isHeartbeat: false,
    });

    expect(runWithModelFallbackMock).toHaveBeenCalledTimes(1);
    const stored = JSON.parse(await fsPromises.readFile(storePath, "utf-8"));
    expect(stored[sessionKey].totalTokens).toBe(30);
    expect(stored[sessionKey].totalTokensFresh).toBe(true);
  });

  it("does not overwrite fresh persisted prompt tokens with a smaller transcript prompt snapshot", async () => {
    const tmp = await fsPromises.mkdtemp(path.join(os.tmpdir(), "openclaw-flush-"));
    const logPath = path.join(tmp, "session.jsonl");
    const persistedPromptTokens = 120;
    const transcriptPromptTokens = 80;
    const transcriptOutputTokens = 40;
    await fsPromises.writeFile(
      logPath,
      JSON.stringify({ usage: { input: transcriptPromptTokens, output: transcriptOutputTokens } }),
      "utf-8",
    );

    const storePath = path.join(tmp, "sessions.json");
    const sessionKey = "main";
    const sessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      sessionFile: logPath,
      totalTokens: persistedPromptTokens,
      totalTokensFresh: true,
      compactionCount: 0,
    };
    await fsPromises.writeFile(
      storePath,
      JSON.stringify({ [sessionKey]: sessionEntry }, null, 2),
      "utf-8",
    );

    const promptText = "Use transcript output tokens for gating only.";
    const estimate = estimatePromptTokensForMemoryFlush(promptText);
    expect(estimate).toBeTypeOf("number");
    expect(estimate).toBeGreaterThan(0);
    if (!estimate) {
      throw new Error("Expected prompt estimate");
    }

    const reserveTokensFloor = 1;
    const softThresholdTokens = 1;
    const projected = persistedPromptTokens + transcriptOutputTokens + estimate;
    const threshold = projected + 200;
    const contextWindowTokens = threshold + reserveTokensFloor + softThresholdTokens;
    const cfg = {
      agents: {
        defaults: {
          compaction: {
            reserveTokensFloor,
            memoryFlush: { softThresholdTokens },
          },
        },
      },
    } as OpenClawConfig;
    const followupRun = createFollowupRun({
      cfg,
      sessionId: "session",
      sessionKey,
      sessionFile: logPath,
    });

    await runMemoryFlushIfNeeded({
      cfg,
      followupRun,
      promptForEstimate: promptText,
      sessionCtx: baseSessionCtx,
      defaultModel: "anthropic/claude-opus-4-5",
      agentCfgContextTokens: contextWindowTokens,
      resolvedVerboseLevel: "off",
      sessionEntry,
      sessionStore: { [sessionKey]: sessionEntry },
      sessionKey,
      storePath,
      isHeartbeat: false,
    });

    expect(runWithModelFallbackMock).not.toHaveBeenCalled();
    const stored = JSON.parse(await fsPromises.readFile(storePath, "utf-8"));
    expect(stored[sessionKey].totalTokens).toBe(persistedPromptTokens);
    expect(stored[sessionKey].totalTokensFresh).toBe(true);
  });

  it("reads transcript near threshold and triggers flush when large output tokens flip projected usage", async () => {
    runWithModelFallbackMock.mockImplementation(
      async ({
        provider,
        model,
        run,
      }: {
        provider: string;
        model: string;
        run: (provider: string, model: string) => Promise<unknown>;
      }) => ({
        result: await run(provider, model),
        provider,
        model,
      }),
    );
    runEmbeddedPiAgentMock.mockResolvedValue({ payloads: [], meta: {} });

    const tmp = await fsPromises.mkdtemp(path.join(os.tmpdir(), "openclaw-flush-"));
    const logPath = path.join(tmp, "session.jsonl");
    const persistedPromptTokens = 90_000;
    const transcriptPromptTokens = 85_000;
    const transcriptOutputTokens = 8_000;
    await fsPromises.writeFile(
      logPath,
      JSON.stringify({ usage: { input: transcriptPromptTokens, output: transcriptOutputTokens } }),
      "utf-8",
    );

    const storePath = path.join(tmp, "sessions.json");
    const sessionKey = "main";
    const sessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      sessionFile: logPath,
      totalTokens: persistedPromptTokens,
      totalTokensFresh: true,
      compactionCount: 0,
    };
    await fsPromises.writeFile(
      storePath,
      JSON.stringify({ [sessionKey]: sessionEntry }, null, 2),
      "utf-8",
    );

    const promptText = "Use projected context tokens to gate memory flush.";
    const estimate = estimatePromptTokensForMemoryFlush(promptText);
    expect(estimate).toBeTypeOf("number");
    expect(estimate).toBeGreaterThan(0);
    if (!estimate) {
      throw new Error("Expected prompt estimate");
    }

    const reserveTokensFloor = 1;
    const softThresholdTokens = 1;
    const baselineWithoutOutput = persistedPromptTokens + estimate;
    const threshold = baselineWithoutOutput + Math.floor(transcriptOutputTokens / 2);
    const contextWindowTokens = threshold + reserveTokensFloor + softThresholdTokens;
    const cfg = {
      agents: {
        defaults: {
          compaction: {
            reserveTokensFloor,
            memoryFlush: { softThresholdTokens },
          },
        },
      },
    } as OpenClawConfig;
    const followupRun = createFollowupRun({
      cfg,
      sessionId: "session",
      sessionKey,
      sessionFile: logPath,
    });

    await runMemoryFlushIfNeeded({
      cfg,
      followupRun,
      promptForEstimate: promptText,
      sessionCtx: baseSessionCtx,
      defaultModel: "anthropic/claude-opus-4-5",
      agentCfgContextTokens: contextWindowTokens,
      resolvedVerboseLevel: "off",
      sessionEntry,
      sessionStore: { [sessionKey]: sessionEntry },
      sessionKey,
      storePath,
      isHeartbeat: false,
    });

    expect(runWithModelFallbackMock).toHaveBeenCalledTimes(1);
    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);

    const stored = JSON.parse(await fsPromises.readFile(storePath, "utf-8"));
    expect(stored[sessionKey].totalTokens).toBe(persistedPromptTokens);
    expect(stored[sessionKey].totalTokensFresh).toBe(true);
  });

  it.each([
    { label: "CLI provider", provider: "codex-cli", isHeartbeat: false },
    { label: "heartbeat", provider: "anthropic", isHeartbeat: true },
  ])("skips transcript read when $label", async ({ provider, isHeartbeat }) => {
    const tmp = await fsPromises.mkdtemp(path.join(os.tmpdir(), "openclaw-flush-"));
    const logPath = path.join(tmp, "session.jsonl");
    await fsPromises.writeFile(logPath, JSON.stringify({ usage: { total: 10 } }), "utf-8");

    const storePath = path.join(tmp, "sessions.json");
    const sessionKey = "main";
    const sessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      sessionFile: logPath,
      compactionCount: 0,
    };
    await fsPromises.writeFile(
      storePath,
      JSON.stringify({ [sessionKey]: sessionEntry }, null, 2),
      "utf-8",
    );

    const cfg = {} as OpenClawConfig;
    const followupRun = createFollowupRun({
      cfg,
      sessionId: "session",
      sessionKey,
      sessionFile: logPath,
      provider,
    });

    const readSpy = vi.spyOn(fsNative.promises, "readFile");
    try {
      await runMemoryFlushIfNeeded({
        cfg,
        followupRun,
        promptForEstimate: "Skip transcript read.",
        sessionCtx: baseSessionCtx,
        defaultModel: "anthropic/claude-opus-4-5",
        resolvedVerboseLevel: "off",
        sessionEntry,
        sessionStore: { [sessionKey]: sessionEntry },
        sessionKey,
        storePath,
        isHeartbeat,
      });
      expect(readSpy).not.toHaveBeenCalled();
    } finally {
      readSpy.mockRestore();
    }
    expect(runWithModelFallbackMock).not.toHaveBeenCalled();
  });
});

describe("resolveMemoryFlushContextWindowTokens", () => {
  it("falls back to agent config or default tokens", () => {
    expect(resolveMemoryFlushContextWindowTokens({ agentCfgContextTokens: 42_000 })).toBe(42_000);
  });
});
