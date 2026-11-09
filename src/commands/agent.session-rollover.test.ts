import path from "node:path";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { beforeEach, expect, it, vi } from "vitest";
import "./agent-command.test-mocks.js";
import "./agent-command-attempt.test-mocks.js";
import { runEmbeddedAgent } from "../agents/embedded-agent.js";
import {
  appendTranscriptEvent,
  loadSessionEntry,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import { clearSessionStoreCacheForTest } from "../config/sessions/store-writer-state.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createDefaultAgentResult } from "./agent-session.test-support.js";
import { agentCommand } from "./agent.js";
import { createThrowingTestRuntime } from "./test-runtime-config-helpers.js";

const configIoMocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  readConfigFileSnapshotForWrite: vi.fn(),
}));
// mock-isolation: Rollover cases supply session config in memory without loading persisted config.
vi.mock("../config/io.js", () => ({
  captureRuntimeConfigAsyncReader: () => async () => configIoMocks.loadConfig(),
  getRuntimeConfig: configIoMocks.loadConfig,
  loadConfig: configIoMocks.loadConfig,
  readConfigFileSnapshotForWrite: configIoMocks.readConfigFileSnapshotForWrite,
}));

beforeEach(() => {
  vi.clearAllMocks();
  clearSessionStoreCacheForTest();
  vi.mocked(runEmbeddedAgent).mockResolvedValue(createDefaultAgentResult());
  configIoMocks.readConfigFileSnapshotForWrite.mockResolvedValue({
    snapshot: { valid: false, resolved: {} },
    writeOptions: {},
  });
});

it("starts a new lifecycle revision when a killed main session rolls over", () =>
  withTempHome(async (home) => {
    const storePath = path.join(home, "sessions.json");
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-6" },
          models: { "anthropic/claude-opus-4-6": {} },
          workspace: path.join(home, "openclaw"),
        },
      },
      session: { store: storePath, mainKey: "main" },
    };
    configIoMocks.loadConfig.mockReturnValue(cfg);
    const sessionKey = "agent:main:main";
    const sessionId = "killed-main-session";
    await replaceSessionEntry(
      { sessionKey, storePath },
      {
        sessionId,
        lifecycleRevision: "killed-main-revision",
        status: "killed",
        updatedAt: Date.now() - 10_000,
      },
    );
    // A transcript write after the registry row makes the killed main session stale.
    await appendTranscriptEvent(
      { agentId: "main", sessionId, sessionKey, storePath },
      { type: "custom", timestamp: new Date().toISOString() },
    );

    await agentCommand({ message: "hi", sessionKey }, createThrowingTestRuntime());

    const persisted = loadSessionEntry({ sessionKey, storePath });
    expect(persisted?.sessionId).not.toBe(sessionId);
    expect(persisted?.lifecycleRevision).toEqual(expect.any(String));
    expect(persisted?.lifecycleRevision).not.toBe("killed-main-revision");
  }));
