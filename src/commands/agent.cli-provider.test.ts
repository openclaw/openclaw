import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withTempHome as withTempHomeBase } from "../../test/helpers/temp-home.js";
import "../cron/isolated-agent.mocks.js";
import { __testing as acpManagerTesting } from "../acp/control-plane/manager.js";
import * as cliRunnerModule from "../agents/cli-runner.js";
import { FailoverError } from "../agents/failover-error.js";
import { loadModelCatalog } from "../agents/model-catalog.js";
import * as modelSelectionModule from "../agents/model-selection.js";
import { runEmbeddedPiAgent } from "../agents/pi-embedded.js";
import type { OpenClawConfig } from "../config/config.js";
import * as configModule from "../config/config.js";
import { clearSessionStoreCacheForTest } from "../config/sessions.js";
import { resetAgentEventsForTest, resetAgentRunContextForTest } from "../infra/agent-events.js";
import { resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import type { RuntimeEnv } from "../runtime.js";
import { agentCommand } from "./agent.js";

vi.mock("../logging/subsystem.js", () => {
  const createMockLogger = () => ({
    subsystem: "test",
    isEnabled: vi.fn(() => true),
    trace: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    raw: vi.fn(),
    child: vi.fn(() => createMockLogger()),
  });
  return {
    createSubsystemLogger: vi.fn(() => createMockLogger()),
  };
});

vi.mock("../agents/workspace.js", () => ({
  DEFAULT_AGENT_WORKSPACE_DIR: "/tmp/openclaw-workspace",
  DEFAULT_AGENTS_FILENAME: "AGENTS.md",
  DEFAULT_IDENTITY_FILENAME: "IDENTITY.md",
  resolveDefaultAgentWorkspaceDir: () => "/tmp/openclaw-workspace",
  ensureAgentWorkspace: vi.fn(async ({ dir }: { dir: string }) => ({ dir })),
}));

vi.mock("../agents/skills.js", () => ({
  buildWorkspaceSkillSnapshot: vi.fn(() => undefined),
  loadWorkspaceSkillEntries: vi.fn(() => []),
}));

vi.mock("../agents/skills/refresh.js", () => ({
  getSkillsSnapshotVersion: vi.fn(() => 0),
}));

const runtime: RuntimeEnv = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(() => {
    throw new Error("exit");
  }),
};

const configSpy = vi.spyOn(configModule, "loadConfig");
const readConfigFileSnapshotForWriteSpy = vi.spyOn(configModule, "readConfigFileSnapshotForWrite");
const runCliAgentSpy = vi.spyOn(cliRunnerModule, "runCliAgent");

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  return withTempHomeBase(fn, { prefix: "openclaw-agent-cli-" });
}

function mockConfig(
  home: string,
  storePath: string,
  agentOverrides?: Partial<NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>>,
) {
  const cfg = {
    agents: {
      defaults: {
        model: { primary: "anthropic/claude-opus-4-6" },
        models: { "anthropic/claude-opus-4-6": {} },
        workspace: path.join(home, "openclaw"),
        ...agentOverrides,
      },
    },
    session: { store: storePath, mainKey: "main" },
  } as OpenClawConfig;
  configSpy.mockReturnValue(cfg);
  return cfg;
}

function writeSessionStoreSeed(
  storePath: string,
  sessions: Record<string, Record<string, unknown>>,
) {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, JSON.stringify(sessions, null, 2));
}

function readSessionStore<T>(storePath: string): Record<string, T> {
  return JSON.parse(fs.readFileSync(storePath, "utf-8")) as Record<string, T>;
}

function createDefaultAgentResult() {
  return {
    payloads: [{ text: "ok" }],
    meta: {
      durationMs: 5,
      agentMeta: { sessionId: "s", provider: "p", model: "m" },
    },
  };
}

function expectLastEmbeddedProviderModel(provider: string, model: string): void {
  const callArgs = vi.mocked(runEmbeddedPiAgent).mock.calls.at(-1)?.[0];
  expect(callArgs?.provider).toBe(provider);
  expect(callArgs?.model).toBe(model);
}

beforeEach(() => {
  vi.clearAllMocks();
  clearSessionStoreCacheForTest();
  resetAgentEventsForTest();
  resetAgentRunContextForTest();
  resetPluginRuntimeStateForTest();
  acpManagerTesting.resetAcpSessionManagerForTests();
  configModule.clearRuntimeConfigSnapshot();
  runCliAgentSpy.mockResolvedValue(createDefaultAgentResult() as never);
  vi.mocked(runEmbeddedPiAgent).mockResolvedValue(createDefaultAgentResult());
  vi.mocked(loadModelCatalog).mockResolvedValue([]);
  vi.mocked(modelSelectionModule.isCliProvider).mockImplementation(() => false);
  readConfigFileSnapshotForWriteSpy.mockResolvedValue({
    snapshot: { valid: false, resolved: {} as OpenClawConfig },
    writeOptions: {},
  } as Awaited<ReturnType<typeof configModule.readConfigFileSnapshotForWrite>>);
});

describe("agentCommand CLI provider handling", () => {
  it("rejects explicit CLI overrides that are outside the models allowlist", async () => {
    vi.mocked(modelSelectionModule.isCliProvider).mockImplementation(
      (provider) => provider.trim().toLowerCase() === "codex-cli",
    );
    try {
      await withTempHome(async (home) => {
        const store = path.join(home, "sessions.json");
        mockConfig(home, store, {
          models: {
            "openai/gpt-4.1-mini": {},
          },
        });

        await expect(
          agentCommand(
            {
              message: "use disallowed cli override",
              sessionKey: "agent:main:subagent:cli-override-error",
              model: "codex-cli/gpt-5.4",
            },
            runtime,
          ),
        ).rejects.toThrow('Model override "codex-cli/gpt-5.4" is not allowed for agent "main".');
      });
    } finally {
      vi.mocked(modelSelectionModule.isCliProvider).mockImplementation(() => false);
    }
  });

  it("clears stored CLI overrides when they fall outside the models allowlist", async () => {
    vi.mocked(modelSelectionModule.isCliProvider).mockImplementation(
      (provider) => provider.trim().toLowerCase() === "codex-cli",
    );
    try {
      await withTempHome(async (home) => {
        const store = path.join(home, "sessions.json");
        writeSessionStoreSeed(store, {
          "agent:main:subagent:clear-cli-overrides": {
            sessionId: "session-clear-cli-overrides",
            updatedAt: Date.now(),
            providerOverride: "codex-cli",
            modelOverride: "gpt-5.4",
          },
        });

        mockConfig(home, store, {
          model: { primary: "openai/gpt-4.1-mini" },
          models: {
            "openai/gpt-4.1-mini": {},
          },
        });

        vi.mocked(loadModelCatalog).mockResolvedValueOnce([
          { id: "gpt-4.1-mini", name: "GPT-4.1 Mini", provider: "openai" },
          { id: "gpt-5.4", name: "GPT-5.4", provider: "codex-cli" },
        ]);

        await agentCommand(
          {
            message: "hi",
            sessionKey: "agent:main:subagent:clear-cli-overrides",
          },
          runtime,
        );

        expectLastEmbeddedProviderModel("openai", "gpt-4.1-mini");

        const saved = readSessionStore<{
          providerOverride?: string;
          modelOverride?: string;
        }>(store);
        expect(saved["agent:main:subagent:clear-cli-overrides"]?.providerOverride).toBeUndefined();
        expect(saved["agent:main:subagent:clear-cli-overrides"]?.modelOverride).toBeUndefined();
      });
    } finally {
      vi.mocked(modelSelectionModule.isCliProvider).mockImplementation(() => false);
    }
  });

  it("clears stale CLI session IDs before retrying after session expiration", async () => {
    vi.mocked(modelSelectionModule.isCliProvider).mockImplementation(
      (provider) => provider.trim().toLowerCase() === "codex-cli",
    );
    try {
      await withTempHome(async (home) => {
        const store = path.join(home, "sessions.json");
        const sessionKey = "agent:main:subagent:cli-expired";
        writeSessionStoreSeed(store, {
          [sessionKey]: {
            sessionId: "session-cli-123",
            updatedAt: Date.now(),
            providerOverride: "codex-cli",
            modelOverride: "gpt-5.4",
            cliSessionIds: { "codex-cli": "stale-cli-session" },
          },
        });

        mockConfig(home, store, {
          model: { primary: "codex-cli/gpt-5.4", fallbacks: [] },
          models: { "codex-cli/gpt-5.4": {} },
        });

        runCliAgentSpy
          .mockRejectedValueOnce(
            new FailoverError("session expired", {
              reason: "session_expired",
              provider: "codex-cli",
              model: "gpt-5.4",
              status: 410,
            }),
          )
          .mockRejectedValue(new Error("retry failed"));

        await expect(agentCommand({ message: "hi", sessionKey }, runtime)).rejects.toThrow(
          "retry failed",
        );

        expect(runCliAgentSpy).toHaveBeenCalledTimes(2);
        const firstCall = runCliAgentSpy.mock.calls[0]?.[0] as
          | { cliSessionId?: string }
          | undefined;
        const secondCall = runCliAgentSpy.mock.calls[1]?.[0] as
          | { cliSessionId?: string }
          | undefined;
        expect(firstCall?.cliSessionId).toBe("stale-cli-session");
        expect(secondCall?.cliSessionId).toBeUndefined();

        const saved = readSessionStore<{
          cliSessionIds?: Record<string, string>;
        }>(store);
        expect(saved[sessionKey]?.cliSessionIds?.["codex-cli"]).toBeUndefined();
      });
    } finally {
      vi.mocked(modelSelectionModule.isCliProvider).mockImplementation(() => false);
    }
  });
});
