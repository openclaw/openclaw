import { describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";

const loadConfigMock = vi.hoisted(() =>
  vi.fn(() => ({
    agents: {
      defaults: {
        model: { primary: "pi:opus" },
        models: { "pi:opus": {} },
        contextTokens: 32000,
      },
      list: [
        { id: "main", default: false },
        { id: "voice", default: true },
      ],
    },
    session: {
      store: "/tmp/sessions-{agentId}.json",
    },
  })),
);

const resolveStorePathMock = vi.hoisted(() =>
  vi.fn((_store: string | undefined, opts?: { agentId?: string }) => {
    return `/tmp/sessions-${opts?.agentId ?? "missing"}.json`;
  }),
);

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: loadConfigMock,
  };
});

vi.mock("../config/sessions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/sessions.js")>();
  return {
    ...actual,
    resolveStorePath: resolveStorePathMock,
    loadSessionStore: vi.fn(() => ({})),
  };
});

import { sessionsCommand } from "./sessions.js";

function createRuntime(): { runtime: RuntimeEnv; logs: string[] } {
  const logs: string[] = [];
  return {
    runtime: {
      log: (msg: unknown) => logs.push(String(msg)),
      error: vi.fn(),
      exit: vi.fn(),
    },
    logs,
  };
}

describe("sessionsCommand default store agent selection", () => {
  it("uses configured default agent id when resolving implicit session store path", async () => {
    resolveStorePathMock.mockClear();
    const { runtime, logs } = createRuntime();

    await sessionsCommand({}, runtime);

    expect(resolveStorePathMock).toHaveBeenCalledWith("/tmp/sessions-{agentId}.json", {
      agentId: "voice",
    });
    expect(logs[0]).toContain("Session store: /tmp/sessions-voice.json");
  });
});
