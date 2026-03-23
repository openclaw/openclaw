import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockSessionsConfig, runSessionsJson, writeStore } from "./sessions.test-helpers.js";

mockSessionsConfig();

import { sessionsCommand } from "./sessions.js";

type SessionsJsonPayload = {
  sessions?: Array<{
    key: string;
    model?: string | null;
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
});
