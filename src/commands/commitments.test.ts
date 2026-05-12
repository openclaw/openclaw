import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommitmentRecord } from "../commitments/types.js";
import type { OutputRuntimeEnv, RuntimeEnv } from "../runtime.js";
import { stripAnsi } from "../terminal/ansi.js";
import { commitmentsDismissCommand, commitmentsListCommand } from "./commitments.js";

const mocks = vi.hoisted(() => ({
  listCommitments: vi.fn(),
  markCommitmentsStatus: vi.fn(),
  resolveCommitmentStorePath: vi.fn(() => "/tmp/openclaw-commitments.json"),
  getRuntimeConfig: vi.fn(() => ({
    commitments: {
      enabled: true,
    },
  })),
}));

vi.mock("../commitments/store.js", () => ({
  listCommitments: mocks.listCommitments,
  markCommitmentsStatus: mocks.markCommitmentsStatus,
  resolveCommitmentStorePath: mocks.resolveCommitmentStorePath,
}));

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: mocks.getRuntimeConfig,
}));

function createRuntime(): { runtime: RuntimeEnv; logs: string[] } {
  const logs: string[] = [];
  return {
    logs,
    runtime: {
      log: (message: unknown) => logs.push(String(message)),
      error: vi.fn(),
      exit: vi.fn(),
    },
  };
}

function createOutputRuntime(): {
  runtime: OutputRuntimeEnv;
  logs: string[];
  stdout: string[];
  jsonWrites: unknown[];
} {
  const logs: string[] = [];
  const stdout: string[] = [];
  const jsonWrites: unknown[] = [];
  return {
    logs,
    stdout,
    jsonWrites,
    runtime: {
      log: (message: unknown) => logs.push(String(message)),
      error: vi.fn(),
      exit: vi.fn(),
      writeStdout: (chunk: string) => stdout.push(chunk),
      writeJson: (value: unknown, space = 2) => {
        jsonWrites.push(value);
        stdout.push(JSON.stringify(value, null, space > 0 ? space : undefined) + "\n");
      },
    },
  };
}

function commitment(overrides?: Partial<CommitmentRecord>): CommitmentRecord {
  return {
    id: "cm_escape",
    agentId: "main\u001b[31m",
    sessionKey: "agent:main:session\u001b]8;;https://example.test\u0007",
    channel: "telegram",
    to: "+15551234567\u001b[0m",
    kind: "event_check_in",
    sensitivity: "routine",
    source: "inferred_user_context",
    status: "pending",
    reason: "The user mentioned an interview.",
    suggestedText: "How did it go?\u001b]52;c;YWJj\u0007\nspoofed",
    dedupeKey: "interview:2026-04-30",
    confidence: 0.91,
    dueWindow: {
      earliestMs: Date.parse("2026-04-30T17:00:00.000Z"),
      latestMs: Date.parse("2026-04-30T23:00:00.000Z"),
      timezone: "America/Los_Angeles",
    },
    createdAtMs: Date.parse("2026-04-29T16:00:00.000Z"),
    updatedAtMs: Date.parse("2026-04-29T16:00:00.000Z"),
    attempts: 0,
    ...overrides,
  };
}

describe("commitments command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listCommitments.mockResolvedValue([commitment()]);
  });

  it("sanitizes untrusted commitment fields in table output", async () => {
    const { runtime, logs } = createRuntime();

    await commitmentsListCommand({}, runtime);

    expect(logs.map(stripAnsi)).toEqual([
      "Commitments: 1",
      "Store: /tmp/openclaw-commitments.json",
      "Status filter: pending",
      "ID               Status     Kind             Due                      Scope                        Suggested text",
      "cm_escape        pending    event_check_in   2026-04-30T17:00:00.000Z main/telegram/+15551234567   How did it go?\\nspoofed",
    ]);
  });

  it("writes list --json payload through writeJson (stdout), not runtime.log (regression for #81183)", async () => {
    const { runtime, logs, stdout, jsonWrites } = createOutputRuntime();

    await commitmentsListCommand({ json: true }, runtime);

    expect(jsonWrites).toHaveLength(1);
    const payload = jsonWrites[0] as Record<string, unknown>;
    expect(payload.count).toBe(1);
    expect(payload.status).toBe("pending");
    expect(payload.store).toBe("/tmp/openclaw-commitments.json");
    expect(Array.isArray(payload.commitments)).toBe(true);
    expect(logs).toEqual([]);
    expect(stdout).toHaveLength(1);
    expect(JSON.parse(stdout[0])).toEqual(payload);
  });

  it("writes list --json --all payload through writeJson with null status", async () => {
    const { runtime, jsonWrites } = createOutputRuntime();

    await commitmentsListCommand({ json: true, all: true }, runtime);

    expect(jsonWrites).toHaveLength(1);
    const payload = jsonWrites[0] as Record<string, unknown>;
    expect(payload.status).toBeNull();
  });

  it("writes dismiss --json payload through writeJson (stdout), not runtime.log (regression for #81183)", async () => {
    mocks.markCommitmentsStatus.mockResolvedValue(undefined);
    const { runtime, logs, stdout, jsonWrites } = createOutputRuntime();

    await commitmentsDismissCommand({ ids: ["cm_abc"], json: true }, runtime);

    expect(jsonWrites).toEqual([{ dismissed: ["cm_abc"] }]);
    expect(logs).toEqual([]);
    expect(stdout).toHaveLength(1);
    expect(JSON.parse(stdout[0])).toEqual({ dismissed: ["cm_abc"] });
  });

  it("falls back to runtime.log when runtime does not expose writeJson (back-compat)", async () => {
    const { runtime, logs } = createRuntime();

    await commitmentsListCommand({ json: true }, runtime);

    // Plain RuntimeEnv mocks have no writeJson; writeRuntimeJson falls back to
    // runtime.log so older callers and the existing test runtime still work.
    expect(logs).toHaveLength(1);
    const parsed = JSON.parse(logs[0]) as Record<string, unknown>;
    expect(parsed.count).toBe(1);
    expect(parsed.store).toBe("/tmp/openclaw-commitments.json");
  });
});
