import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../config/sessions/types.js";
import type { TaskRecord } from "../tasks/task-registry.types.js";
import {
  isWinOllamaQuarantinedCronRunLogEntry,
  isWinOllamaQuarantinedCronTask,
  isWinOllamaQuarantinedSessionEntry,
} from "./win-ollama-quarantine.js";

const baseSession: SessionEntry = {
  sessionId: "sid",
  updatedAt: Date.now(),
  model: "qwen3:4b",
  modelProvider: "ollama",
};

function baseTask(overrides: Partial<TaskRecord>): TaskRecord {
  return {
    taskId: "t1",
    runtime: "cron",
    requesterSessionKey: "agent:main:main",
    ownerKey: "agent:main:main",
    scopeKind: "system",
    task: "job",
    status: "succeeded",
    deliveryStatus: "not_applicable",
    notifyPolicy: "done_only",
    createdAt: Date.now(),
    ...overrides,
  };
}

describe("isWinOllamaQuarantinedSessionEntry", () => {
  it("returns false for qwen3/gemma models without win-ollama markers", () => {
    expect(
      isWinOllamaQuarantinedSessionEntry({
        ...baseSession,
        model: "qwen3:4b",
        modelProvider: "ollama",
      }),
    ).toBe(false);
    expect(
      isWinOllamaQuarantinedSessionEntry({
        ...baseSession,
        model: "gemma4:e4b",
      }),
    ).toBe(false);
  });

  it("flags exact win-ollama providers", () => {
    expect(
      isWinOllamaQuarantinedSessionEntry({
        ...baseSession,
        modelProvider: "win-ollama",
        model: "qwen3:4b",
      }),
    ).toBe(true);
    expect(
      isWinOllamaQuarantinedSessionEntry({
        ...baseSession,
        providerOverride: "win-ollama",
      }),
    ).toBe(true);
    expect(
      isWinOllamaQuarantinedSessionEntry({
        ...baseSession,
        origin: { provider: "win-ollama" },
      }),
    ).toBe(true);
  });

  it("flags win-ollama substring in model id", () => {
    expect(
      isWinOllamaQuarantinedSessionEntry({
        ...baseSession,
        model: "win-ollama/custom",
      }),
    ).toBe(true);
  });

  it("flags win-ollama in runtime/host-like fields", () => {
    expect(
      isWinOllamaQuarantinedSessionEntry({
        ...baseSession,
        execHost: "//win-ollama-host/run",
      }),
    ).toBe(true);
    expect(
      isWinOllamaQuarantinedSessionEntry({
        ...baseSession,
        acp: {
          backend: "win-ollama-bridge",
          agent: "a",
          runtimeSessionName: "r",
          mode: "persistent",
          state: "idle",
          lastActivityAt: 0,
        },
      }),
    ).toBe(true);
  });
});

describe("isWinOllamaQuarantinedCronTask", () => {
  it("ignores non-cron tasks", () => {
    expect(
      isWinOllamaQuarantinedCronTask(baseTask({ runtime: "cli", task: "win-ollama sweep" })),
    ).toBe(false);
  });

  it("flags cron tasks when payload strings mention win-ollama", () => {
    expect(isWinOllamaQuarantinedCronTask(baseTask({ task: "invoke win-ollama runner" }))).toBe(
      true,
    );
  });
});

describe("isWinOllamaQuarantinedCronRunLogEntry", () => {
  it("flags explicit win-ollama providers", () => {
    expect(
      isWinOllamaQuarantinedCronRunLogEntry({
        jobId: "job-1",
        provider: "win-ollama",
        model: "qwen3:4b",
      }),
    ).toBe(true);
  });

  it("flags win-ollama markers in run metadata", () => {
    expect(
      isWinOllamaQuarantinedCronRunLogEntry({
        jobId: "job-1",
        summary: "completed via win-ollama bridge",
      }),
    ).toBe(true);
  });

  it("does not quarantine regular ollama model names", () => {
    expect(
      isWinOllamaQuarantinedCronRunLogEntry({
        jobId: "job-1",
        provider: "ollama",
        model: "qwen3:4b",
      }),
    ).toBe(false);
  });
});
