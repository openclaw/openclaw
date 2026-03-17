import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mockSessionsConfig,
  resetMockSessionsConfig,
  runSessionsJson,
  setMockSessionsConfig,
  writeStore,
} from "./sessions.test-helpers.js";

mockSessionsConfig();

import { sessionsCommand } from "./sessions.js";

type SessionsJsonPayload = {
  sessions?: Array<{
    key: string;
    model?: string | null;
    contextTokens?: number | null;
  }>;
};

async function resolveSubagentModel(
  runtimeFields: Record<string, unknown>,
  sessionId: string,
): Promise<string | null | undefined> {
  const store = writeStore(
    {
      "agent:research:subagent:demo": {
        sessionId,
        updatedAt: Date.now() - 2 * 60_000,
        ...runtimeFields,
      },
    },
    "sessions-model",
  );

  const payload = await runSessionsJson<SessionsJsonPayload>(sessionsCommand, store);
  return payload.sessions?.find((row) => row.key === "agent:research:subagent:demo")?.model;
}

describe("sessionsCommand model resolution", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-12-06T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    resetMockSessionsConfig();
  });

  it("prefers runtime model fields for subagent sessions in JSON output", async () => {
    const model = await resolveSubagentModel(
      {
        modelProvider: "openai-codex",
        model: "gpt-5.3-codex",
        modelOverride: "pi:opus",
      },
      "subagent-1",
    );
    expect(model).toBe("gpt-5.3-codex");
  });

  it("falls back to modelOverride when runtime model is missing", async () => {
    const model = await resolveSubagentModel(
      { modelOverride: "openai-codex/gpt-5.3-codex" },
      "subagent-2",
    );
    expect(model).toBe("gpt-5.3-codex");
  });

  it("uses provider-qualified context windows in JSON output when model ids collide", async () => {
    setMockSessionsConfig({
      models: {
        providers: {
          anthropic: {
            models: [{ id: "claude-opus-4-6", contextWindow: 200_000 }],
          },
          "custom-synai996-space": {
            models: [{ id: "claude-opus-4-6", contextWindow: 16_000 }],
          },
        },
      },
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-6" },
          models: { "anthropic/claude-opus-4-6": {} },
        },
      },
    });

    const store = writeStore(
      {
        "agent:research:subagent:demo": {
          sessionId: "subagent-3",
          updatedAt: Date.now() - 2 * 60_000,
          modelProvider: "anthropic",
          model: "claude-opus-4-6",
        },
      },
      "sessions-context-collision",
    );

    const payload = await runSessionsJson<SessionsJsonPayload>(sessionsCommand, store);
    const row = payload.sessions?.find((entry) => entry.key === "agent:research:subagent:demo");

    expect(row?.model).toBe("claude-opus-4-6");
    expect(row?.contextTokens).toBe(200_000);
  });
});
