import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withTempHome as withTempHomeBase } from "../../test/helpers/temp-home.js";
import "../cron/isolated-agent.mocks.js";
import { runEmbeddedPiAgent } from "../agents/pi-embedded.js";
import * as configModule from "../config/config.js";
import type { OpenClawConfig } from "../config/config.js";
import { clearSessionStoreCacheForTest } from "../config/sessions.js";
import type { RuntimeEnv } from "../runtime.js";
import { agentCommandFromIngress } from "./agent.js";

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

vi.mock("../agents/auth-profiles.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agents/auth-profiles.js")>();
  return {
    ...actual,
    ensureAuthProfileStore: vi.fn(() => ({ version: 1, profiles: {} })),
  };
});

vi.mock("../agents/workspace.js", () => ({
  DEFAULT_AGENT_WORKSPACE_DIR: "/tmp/openclaw-workspace",
  DEFAULT_AGENTS_FILENAME: "AGENTS.md",
  DEFAULT_IDENTITY_FILENAME: "IDENTITY.md",
  resolveDefaultAgentWorkspaceDir: () => "/tmp/openclaw-workspace",
  ensureAgentWorkspace: vi.fn(async ({ dir }: { dir: string }) => ({ dir })),
}));

vi.mock("../agents/command/session-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agents/command/session-store.js")>();
  return {
    ...actual,
    updateSessionStoreAfterAgentRun: vi.fn(async () => undefined),
  };
});

vi.mock("../agents/skills.js", () => ({
  buildWorkspaceSkillSnapshot: vi.fn(() => undefined),
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

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  return withTempHomeBase(fn, { prefix: "openclaw-agent-vida-forwarding-" });
}

function mockConfig(home: string, storePath: string): OpenClawConfig {
  const cfg = {
    agents: {
      defaults: {
        model: { primary: "anthropic/claude-opus-4-5" },
        models: { "anthropic/claude-opus-4-5": {} },
        workspace: path.join(home, "openclaw"),
      },
    },
    session: { store: storePath, mainKey: "main" },
  } as OpenClawConfig;
  configSpy.mockReturnValue(cfg);
  return cfg;
}

beforeEach(() => {
  vi.clearAllMocks();
  clearSessionStoreCacheForTest();
  configModule.clearRuntimeConfigSnapshot();
  vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
    payloads: [{ text: "ok" }],
    meta: {
      durationMs: 5,
      agentMeta: { sessionId: "s", provider: "p", model: "m" },
    },
  });
  readConfigFileSnapshotForWriteSpy.mockResolvedValue({
    snapshot: { valid: false, resolved: {} as OpenClawConfig },
    writeOptions: {},
  } as Awaited<ReturnType<typeof configModule.readConfigFileSnapshotForWrite>>);
});

describe("agentCommandFromIngress Vida hosted-run forwarding", () => {
  it("forwards clientTools, providerMetadata, toolResultMaxDataBytes, and onReasoningStream", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      mockConfig(home, store);
      const onReasoningStream = vi.fn();
      const clientTools = [
        {
          type: "function" as const,
          function: {
            name: "get_weather",
            description: "Get weather",
          },
        },
      ];
      const providerMetadata = {
        vida: {
          traceId: "trace-123",
        },
        relay: {
          requestId: "req-456",
        },
      };

      await agentCommandFromIngress(
        {
          message: "hi",
          sessionKey: "main",
          senderIsOwner: false,
          allowModelOverride: false,
          clientTools,
          providerMetadata,
          toolResultMaxDataBytes: 2048,
          onReasoningStream,
        },
        runtime,
      );

      const ingressCall = vi.mocked(runEmbeddedPiAgent).mock.calls.at(-1)?.[0];
      expect(ingressCall?.clientTools).toEqual(clientTools);
      expect(ingressCall?.providerMetadata).toEqual(providerMetadata);
      expect(ingressCall?.toolResultMaxDataBytes).toBe(2048);
      expect(ingressCall?.onReasoningStream).toBe(onReasoningStream);
    });
  });
});
