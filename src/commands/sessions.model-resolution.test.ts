import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => ({
      agents: {
        defaults: {
          model: { primary: "pi:opus" },
          models: { "pi:opus": {} },
          contextTokens: 32000,
        },
      },
    }),
  };
});

import { sessionsCommand } from "./sessions.js";

const makeRuntime = () => {
  const logs: string[] = [];
  return {
    runtime: {
      log: (msg: unknown) => logs.push(String(msg)),
      error: (msg: unknown) => {
        throw new Error(String(msg));
      },
      exit: (code: number) => {
        throw new Error(`exit ${code}`);
      },
    },
    logs,
  } as const;
};

const writeStore = (data: unknown) => {
  const file = path.join(
    os.tmpdir(),
    `sessions-model-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
  );
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return file;
};

describe("sessionsCommand model resolution", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-12-06T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("prefers runtime model fields for subagent sessions in JSON output", async () => {
    const store = writeStore({
      "agent:research:subagent:demo": {
        sessionId: "subagent-1",
        updatedAt: Date.now() - 2 * 60_000,
        modelProvider: "openai-codex",
        model: "gpt-5.3-codex",
        modelOverride: "pi:opus",
      },
    });

    const { runtime, logs } = makeRuntime();
    await sessionsCommand({ store, json: true }, runtime);

    fs.rmSync(store);

    const payload = JSON.parse(logs[0] ?? "{}") as {
      sessions?: Array<{
        key: string;
        model?: string | null;
      }>;
    };
    const subagent = payload.sessions?.find((row) => row.key === "agent:research:subagent:demo");
    expect(subagent?.model).toBe("gpt-5.3-codex");
  });

  it("falls back to modelOverride when runtime model is missing", async () => {
    const store = writeStore({
      "agent:research:subagent:demo": {
        sessionId: "subagent-2",
        updatedAt: Date.now() - 2 * 60_000,
        modelOverride: "openai-codex/gpt-5.3-codex",
      },
    });

    const { runtime, logs } = makeRuntime();
    await sessionsCommand({ store, json: true }, runtime);

    fs.rmSync(store);

    const payload = JSON.parse(logs[0] ?? "{}") as {
      sessions?: Array<{
        key: string;
        model?: string | null;
      }>;
    };
    const subagent = payload.sessions?.find((row) => row.key === "agent:research:subagent:demo");
    expect(subagent?.model).toBe("gpt-5.3-codex");
  });
});
