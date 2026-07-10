import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliBackendConfig, OpenClawConfig } from "../config/types.js";
import {
  cleanupCrestodianAgentSession,
  createCrestodianAgentSession,
  runCrestodianAgentTurn,
  runCrestodianAgentTurnWithDeps,
  type CrestodianAgentTurnDeps,
} from "./agent-turn.js";
import { CrestodianInferenceUnavailableError } from "./inference-error.js";

type RunCliAgentParams = Parameters<NonNullable<CrestodianAgentTurnDeps["runCliAgent"]>>[0];
type RunEmbeddedAgentParams = Parameters<
  NonNullable<CrestodianAgentTurnDeps["runEmbeddedAgent"]>
>[0];

const mocks = vi.hoisted(() => ({
  runEmbeddedAgent: vi.fn(async (_params: RunEmbeddedAgentParams) => ({
    meta: { finalAssistantVisibleText: "ready" },
  })),
}));

vi.mock("../agents/embedded-agent.js", () => ({
  runEmbeddedAgent: mocks.runEmbeddedAgent,
}));

vi.mock("../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config.js")>()),
  readConfigFileSnapshot: vi.fn(async () => ({
    exists: true,
    valid: true,
    path: "/tmp/openclaw.json",
    hash: "hash",
    config: { agents: { defaults: { model: { primary: "openai/gpt-5.5" } } } },
    runtimeConfig: { agents: { defaults: { model: { primary: "openai/gpt-5.5" } } } },
    sourceConfig: { agents: { defaults: { model: { primary: "openai/gpt-5.5" } } } },
    issues: [],
  })),
}));

const tempDirs: string[] = [];

function useTempStateDir(): string {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "crestodian-turn-"));
  tempDirs.push(stateDir);
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  return stateDir;
}

function configSnapshot(config: OpenClawConfig) {
  return {
    exists: true,
    valid: true,
    path: "/tmp/openclaw.json",
    hash: "hash",
    config,
    runtimeConfig: config,
    sourceConfig: config,
    issues: [],
  };
}

function requireValue<T>(value: T | undefined, message: string): T {
  if (value === undefined) {
    throw new Error(message);
  }
  return value;
}

const cliBackendRouteChanges: Array<{
  name: string;
  first: CliBackendConfig;
  second: CliBackendConfig;
}> = [
  {
    name: "backend command",
    first: { command: "claude" },
    second: { command: "/opt/openclaw/bin/claude" },
  },
  {
    name: "effective model alias",
    first: { command: "claude", modelAliases: { current: "claude-opus-4-8" } },
    second: { command: "claude", modelAliases: { current: "claude-sonnet-5" } },
  },
  {
    name: "resume protocol",
    first: { command: "claude", resumeArgs: ["--resume", "{sessionId}", "--print", "{prompt}"] },
    second: {
      command: "claude",
      resumeArgs: ["--resume-session", "{sessionId}", "--print", "{prompt}"],
    },
  },
];

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("runCrestodianAgentTurn", () => {
  it("uses a distinct transcript for each chat session", async () => {
    useTempStateDir();
    const overview = { defaultModel: "openai/gpt-5.5" } as never;
    const first = createCrestodianAgentSession();
    const second = createCrestodianAgentSession();

    await runCrestodianAgentTurn({
      input: "hello",
      overview,
      surface: "gateway",
      approvalArmed: false,
      session: first,
    });
    await runCrestodianAgentTurn({
      input: "hello",
      overview,
      surface: "gateway",
      approvalArmed: false,
      session: second,
    });

    const firstPath = requireValue(
      mocks.runEmbeddedAgent.mock.calls[0]?.[0]?.sessionFile,
      "missing first embedded transcript path",
    );
    const secondPath = requireValue(
      mocks.runEmbeddedAgent.mock.calls[1]?.[0]?.sessionFile,
      "missing second embedded transcript path",
    );
    expect(firstPath).toContain(`${first.sessionId}.jsonl`);
    expect(secondPath).toContain(`${second.sessionId}.jsonl`);
    expect(firstPath).not.toBe(secondPath);

    await fs.promises.writeFile(firstPath, "transcript");
    await cleanupCrestodianAgentSession(first);
    await expect(fs.promises.access(firstPath)).rejects.toThrow();
  });

  it("uses the default agent CLI route while keeping Crestodian session identity", async () => {
    const stateDir = useTempStateDir();
    const agentDir = path.join(stateDir, "ops-agent");
    const config = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-global" },
          cliBackends: { "claude-cli": { command: "claude" } },
        },
        list: [
          {
            id: "ops",
            default: true,
            agentDir,
            model: { primary: "claude-cli/claude-opus-4-8@claude-cli:ops" },
          },
        ],
      },
    } as OpenClawConfig;
    const runCliAgent = vi.fn(async (_params: RunCliAgentParams) => ({
      payloads: [{ text: "ready" }],
    }));
    const runEmbeddedAgent = vi.fn(async (_params: RunEmbeddedAgentParams) => ({
      payloads: [],
    }));
    const session = createCrestodianAgentSession();

    await runCrestodianAgentTurnWithDeps(
      {
        input: "hello",
        overview: { defaultModel: "claude-cli/claude-opus-4-8" } as never,
        surface: "gateway",
        approvalArmed: false,
        session,
      },
      {
        runCliAgent: runCliAgent as never,
        runEmbeddedAgent: runEmbeddedAgent as never,
        readConfigFileSnapshot: vi.fn(async () => configSnapshot(config)) as never,
      },
    );

    expect(runCliAgent).toHaveBeenCalledOnce();
    expect(runEmbeddedAgent).not.toHaveBeenCalled();
    const call = requireValue(runCliAgent.mock.calls[0]?.[0], "missing CLI runner call");
    expect(call).toMatchObject({
      provider: "claude-cli",
      model: "claude-opus-4-8",
      agentDir,
      authProfileId: "claude-cli:ops",
      agentId: "crestodian",
      sessionKey: "agent:crestodian:main",
      sessionId: session.sessionId,
      workspaceDir: path.join(stateDir, "crestodian", "workspace"),
      sessionFile: path.join(stateDir, "crestodian", "sessions", `${session.sessionId}.jsonl`),
      messageChannel: "crestodian",
      messageProvider: "crestodian",
    });
    expect(call.disableCliLiveSession).toBe(true);
    expect(call.cleanupCliLiveSessionOnRunEnd).toBe(true);
    expect(call.toolsAllow).toBeUndefined();
    expect(requireValue(call.crestodianTool, "missing CLI Crestodian tool").proposalRef).toBe(
      session.proposalRef,
    );
  });

  it("resumes Claude's native transcript through fresh per-turn processes", async () => {
    const stateDir = useTempStateDir();
    const config = {
      agents: {
        defaults: {
          cliBackends: { "claude-cli": { command: "claude" } },
          model: "claude-cli/claude-opus-4-8@claude-cli:ops",
        },
      },
    } as OpenClawConfig;
    const binding = {
      sessionId: "native-claude-session",
      authProfileId: "claude-cli:ops",
      authEpochVersion: 1,
    };
    const runCliAgent = vi.fn(async (_params: RunCliAgentParams) => ({
      payloads: [{ text: "ready" }],
      meta: { agentMeta: { cliSessionBinding: binding } },
    }));
    const session = createCrestodianAgentSession();
    const turn = async (input: string) =>
      await runCrestodianAgentTurnWithDeps(
        {
          input,
          overview: { defaultModel: "claude-cli/claude-opus-4-8" } as never,
          surface: "gateway",
          approvalArmed: false,
          session,
        },
        {
          runCliAgent: runCliAgent as never,
          readConfigFileSnapshot: vi.fn(async () => configSnapshot(config)) as never,
        },
      );

    await turn("propose setup");
    await turn("yes");

    const firstCall = requireValue(runCliAgent.mock.calls[0]?.[0], "missing first CLI call");
    const secondCall = requireValue(runCliAgent.mock.calls[1]?.[0], "missing second CLI call");
    expect(firstCall.cliSessionBinding).toBeUndefined();
    expect(secondCall.cliSessionBinding).toEqual(binding);
    expect(firstCall).toMatchObject({
      disableCliLiveSession: true,
      cleanupCliLiveSessionOnRunEnd: true,
    });
    expect(secondCall).toMatchObject({
      disableCliLiveSession: true,
      cleanupCliLiveSessionOnRunEnd: true,
    });
    const transcript = path.join(stateDir, "crestodian", "sessions", `${session.sessionId}.jsonl`);
    await fs.promises.writeFile(transcript, "transcript");

    await cleanupCrestodianAgentSession(session);

    expect(session.cliSession).toBeUndefined();
    await expect(fs.promises.access(transcript)).rejects.toThrow();
  });

  it("runs a canonical Anthropic model through its configured Claude CLI runtime", async () => {
    const stateDir = useTempStateDir();
    const agentDir = path.join(stateDir, "ops-agent");
    const config = {
      agents: {
        defaults: { cliBackends: { "claude-cli": { command: "claude" } } },
        list: [
          {
            id: "ops",
            default: true,
            agentDir,
            model: { primary: "anthropic/claude-opus-4-8@anthropic:claude-cli" },
            models: {
              "anthropic/claude-opus-4-8": { agentRuntime: { id: "claude-cli" } },
            },
          },
        ],
      },
    } as OpenClawConfig;
    const runCliAgent = vi.fn(async (_params: RunCliAgentParams) => ({
      payloads: [{ text: "ready" }],
    }));

    await runCrestodianAgentTurnWithDeps(
      {
        input: "hello",
        overview: { defaultModel: "anthropic/claude-opus-4-8" } as never,
        surface: "gateway",
        approvalArmed: false,
        session: createCrestodianAgentSession(),
      },
      {
        runCliAgent: runCliAgent as never,
        runEmbeddedAgent: vi.fn(async (_params: RunEmbeddedAgentParams) => ({
          payloads: [],
        })) as never,
        readConfigFileSnapshot: vi.fn(async () => configSnapshot(config)) as never,
      },
    );

    expect(runCliAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "claude-cli",
        model: "claude-opus-4-8",
        agentDir,
        authProfileId: "anthropic:claude-cli",
      }),
    );
  });

  it("reuses the guarded CLI binding when a denied proposal becomes approved", async () => {
    const stateDir = useTempStateDir();
    const agentDir = path.join(stateDir, "ops-agent");
    const config = {
      agents: {
        defaults: { cliBackends: { "claude-cli": { command: "claude" } } },
        list: [
          {
            id: "ops",
            default: true,
            agentDir,
            model: "claude-cli/claude-opus-4-8@claude-cli:ops",
          },
        ],
      },
    } as OpenClawConfig;
    const binding = {
      sessionId: "native-claude-session",
      authProfileId: "claude-cli:ops",
      authEpoch: "auth-epoch",
      authEpochVersion: 1,
      cwdHash: "cwd-hash",
      mcpResumeHash: "crestodian-mcp-resume",
    };
    const runCliAgent = vi.fn(async (_params: RunCliAgentParams) => ({
      payloads: [{ text: "ready" }],
      meta: { agentMeta: { cliSessionBinding: binding } },
    }));
    const session = createCrestodianAgentSession();
    const readConfigFileSnapshot = vi.fn(async () => configSnapshot(config)) as never;

    await runCrestodianAgentTurnWithDeps(
      {
        input: "set the default model",
        overview: { defaultModel: "claude-cli/claude-opus-4-8" } as never,
        surface: "gateway",
        approvalArmed: false,
        session,
      },
      { runCliAgent: runCliAgent as never, readConfigFileSnapshot },
    );
    // Mirrors the denied tool result that arms the exact-operation hash.
    session.proposalRef.current = "proposal-sha256";
    await runCrestodianAgentTurnWithDeps(
      {
        input: "yes",
        overview: { defaultModel: "claude-cli/claude-opus-4-8" } as never,
        surface: "gateway",
        approvalArmed: true,
        session,
      },
      { runCliAgent: runCliAgent as never, readConfigFileSnapshot },
    );

    expect(runCliAgent).toHaveBeenCalledTimes(2);
    const firstCall = requireValue(runCliAgent.mock.calls[0]?.[0], "missing first CLI call");
    const secondCall = requireValue(runCliAgent.mock.calls[1]?.[0], "missing second CLI call");
    expect(firstCall.cliSessionBinding).toBeUndefined();
    expect(secondCall).toMatchObject({
      cliSessionBinding: binding,
      disableCliLiveSession: true,
      cleanupCliLiveSessionOnRunEnd: true,
      crestodianTool: {
        approvalArmed: true,
        proposalRef: { current: "proposal-sha256" },
      },
    });
  });

  it("does not resume a CLI binding after the configured auth route changes", async () => {
    useTempStateDir();
    const configForProfile = (profileId: string) =>
      ({
        agents: {
          defaults: {
            cliBackends: { "claude-cli": { command: "claude" } },
            model: `claude-cli/claude-opus-4-8@${profileId}`,
          },
        },
      }) as OpenClawConfig;
    const binding = { sessionId: "native-claude-session", authEpochVersion: 1 };
    const runCliAgent = vi.fn(async (_params: RunCliAgentParams) => ({
      payloads: [{ text: "ready" }],
      meta: { agentMeta: { cliSessionBinding: binding } },
    }));
    const readConfigFileSnapshot = vi
      .fn()
      .mockResolvedValueOnce(configSnapshot(configForProfile("claude-cli:ops")))
      .mockResolvedValueOnce(configSnapshot(configForProfile("claude-cli:other")));
    const session = createCrestodianAgentSession();
    const turn = async () =>
      await runCrestodianAgentTurnWithDeps(
        {
          input: "hello",
          overview: { defaultModel: "claude-cli/claude-opus-4-8" } as never,
          surface: "gateway",
          approvalArmed: false,
          session,
        },
        {
          runCliAgent: runCliAgent as never,
          readConfigFileSnapshot: readConfigFileSnapshot as never,
        },
      );

    await turn();
    await turn();

    expect(runCliAgent).toHaveBeenCalledTimes(2);
    const secondCall = requireValue(runCliAgent.mock.calls[1]?.[0], "missing second CLI call");
    expect(secondCall).toMatchObject({ authProfileId: "claude-cli:other" });
    expect(secondCall.cliSessionBinding).toBeUndefined();
  });

  it.each(cliBackendRouteChanges)(
    "does not resume a CLI binding after the $name changes",
    async ({ first, second }) => {
      useTempStateDir();
      const configForBackend = (backend: CliBackendConfig) =>
        ({
          agents: {
            defaults: {
              cliBackends: { "claude-cli": backend },
              model: "claude-cli/current@claude-cli:ops",
            },
          },
        }) as OpenClawConfig;
      const binding = {
        sessionId: "native-claude-session",
        authProfileId: "claude-cli:ops",
        authEpoch: "auth-epoch",
        authEpochVersion: 4,
        cwdHash: "cwd-hash",
        mcpResumeHash: "resume-hash",
      };
      const runCliAgent = vi.fn(async (_params: RunCliAgentParams) => ({
        payloads: [{ text: "ready" }],
        meta: { agentMeta: { cliSessionBinding: binding } },
      }));
      const readConfigFileSnapshot = vi
        .fn()
        .mockResolvedValueOnce(configSnapshot(configForBackend(first)))
        .mockResolvedValueOnce(configSnapshot(configForBackend(second)));
      const session = createCrestodianAgentSession();
      const turn = async () =>
        await runCrestodianAgentTurnWithDeps(
          {
            input: "hello",
            overview: { defaultModel: "claude-cli/current" } as never,
            surface: "gateway",
            approvalArmed: false,
            session,
          },
          {
            runCliAgent: runCliAgent as never,
            readConfigFileSnapshot: readConfigFileSnapshot as never,
          },
        );

      await turn();
      await turn();

      expect(runCliAgent).toHaveBeenCalledTimes(2);
      const firstCall = requireValue(runCliAgent.mock.calls[0]?.[0], "missing first CLI call");
      const secondCall = requireValue(runCliAgent.mock.calls[1]?.[0], "missing second CLI call");
      expect(firstCall.cliSessionBinding).toBeUndefined();
      expect(secondCall.cliSessionBinding).toBeUndefined();
    },
  );

  it("invalidates CLI continuity when the helper's executable policy changes", async () => {
    useTempStateDir();
    const configForGlobalPolicy = (security: "full" | "deny", ask: "off" | "always") =>
      ({
        tools: { exec: { security, ask } },
        agents: {
          defaults: {
            cliBackends: { "claude-cli": { command: "claude" } },
            model: "claude-cli/claude-opus-4-8@claude-cli:ops",
          },
          list: [
            {
              id: "ops",
              default: true,
              // Keep the model owner's policy stable. Crestodian executes with
              // its own identity and therefore follows the changing global policy.
              tools: { exec: { security: "allowlist", ask: "on-miss" } },
            },
          ],
        },
      }) as OpenClawConfig;
    const binding = {
      sessionId: "native-claude-session",
      authProfileId: "claude-cli:ops",
      authEpochVersion: 1,
    };
    const runCliAgent = vi.fn(async (_params: RunCliAgentParams) => ({
      payloads: [{ text: "ready" }],
      meta: { agentMeta: { cliSessionBinding: binding } },
    }));
    const readConfigFileSnapshot = vi
      .fn()
      .mockResolvedValueOnce(configSnapshot(configForGlobalPolicy("full", "off")))
      .mockResolvedValueOnce(configSnapshot(configForGlobalPolicy("deny", "always")));
    const session = createCrestodianAgentSession();
    const turn = async () =>
      await runCrestodianAgentTurnWithDeps(
        {
          input: "hello",
          overview: { defaultModel: "claude-cli/claude-opus-4-8" } as never,
          surface: "gateway",
          approvalArmed: false,
          session,
        },
        {
          runCliAgent: runCliAgent as never,
          readConfigFileSnapshot: readConfigFileSnapshot as never,
        },
      );

    await turn();
    await turn();

    const secondCall = requireValue(runCliAgent.mock.calls[1]?.[0], "missing second CLI call");
    expect(secondCall.cliSessionBinding).toBeUndefined();
  });

  it("drops CLI continuity across an intervening embedded turn", async () => {
    const stateDir = useTempStateDir();
    const agentDir = path.join(stateDir, "ops-agent");
    const cliConfig = {
      agents: {
        defaults: { cliBackends: { "claude-cli": { command: "claude" } } },
        list: [
          {
            id: "ops",
            default: true,
            agentDir,
            model: "claude-cli/claude-opus-4-8@claude-cli:ops",
          },
        ],
      },
    } as OpenClawConfig;
    const embeddedConfig = {
      agents: {
        list: [
          {
            id: "ops",
            default: true,
            agentDir,
            model: "openai/gpt-5.4@openai:ops",
            models: { "openai/gpt-5.4": { agentRuntime: { id: "codex" } } },
          },
        ],
      },
    } as OpenClawConfig;
    const binding = { sessionId: "native-claude-session", authEpochVersion: 1 };
    const runCliAgent = vi.fn(async (_params: RunCliAgentParams) => ({
      payloads: [{ text: "cli" }],
      meta: { agentMeta: { cliSessionBinding: binding } },
    }));
    const runEmbeddedAgent = vi.fn(async (_params: RunEmbeddedAgentParams) => ({
      payloads: [{ text: "embedded" }],
    }));
    const readConfigFileSnapshot = vi
      .fn()
      .mockResolvedValueOnce(configSnapshot(cliConfig))
      .mockResolvedValueOnce(configSnapshot(embeddedConfig))
      .mockResolvedValueOnce(configSnapshot(cliConfig));
    const session = createCrestodianAgentSession();
    const turn = async (input: string) =>
      await runCrestodianAgentTurnWithDeps(
        {
          input,
          overview: { defaultModel: "configured" } as never,
          surface: "gateway",
          approvalArmed: false,
          session,
        },
        {
          runCliAgent: runCliAgent as never,
          runEmbeddedAgent: runEmbeddedAgent as never,
          readConfigFileSnapshot: readConfigFileSnapshot as never,
        },
      );

    await turn("first CLI turn");
    expect(session.cliSession?.binding.sessionId).toBe(binding.sessionId);
    await turn("embedded turn");
    expect(session.cliSession).toBeUndefined();
    await turn("return to CLI");

    expect(runCliAgent).toHaveBeenCalledTimes(2);
    const secondCall = requireValue(runCliAgent.mock.calls[1]?.[0], "missing second CLI call");
    expect(secondCall.cliSessionBinding).toBeUndefined();
  });

  it("uses the default agent embedded model, auth directory, profile, and runtime", async () => {
    const stateDir = useTempStateDir();
    const agentDir = path.join(stateDir, "ops-agent");
    const config = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-global" },
          models: {
            "openai/gpt-5.4": { agentRuntime: { id: "openclaw" } },
          },
        },
        list: [
          {
            id: "ops",
            default: true,
            agentDir,
            model: { primary: "openai/gpt-5.4@openai:ops" },
            models: {
              "openai/gpt-5.4": { agentRuntime: { id: "codex" } },
            },
          },
        ],
      },
    } as OpenClawConfig;
    const runCliAgent = vi.fn(async (_params: RunCliAgentParams) => ({ payloads: [] }));
    const runEmbeddedAgent = vi.fn(async (_params: RunEmbeddedAgentParams) => ({
      payloads: [{ text: "ready" }],
    }));
    const session = createCrestodianAgentSession();

    await runCrestodianAgentTurnWithDeps(
      {
        input: "hello",
        overview: { defaultModel: "openai/gpt-5.4" } as never,
        surface: "gateway",
        approvalArmed: false,
        session,
      },
      {
        runCliAgent: runCliAgent as never,
        runEmbeddedAgent: runEmbeddedAgent as never,
        readConfigFileSnapshot: vi.fn(async () => configSnapshot(config)) as never,
      },
    );

    expect(runEmbeddedAgent).toHaveBeenCalledOnce();
    expect(runCliAgent).not.toHaveBeenCalled();
    const call = requireValue(runEmbeddedAgent.mock.calls[0]?.[0], "missing embedded runner call");
    expect(call).toMatchObject({
      provider: "openai",
      model: "gpt-5.4",
      agentDir,
      authProfileId: "openai:ops",
      authProfileIdSource: "user",
      agentHarnessRuntimeOverride: "codex",
      agentId: "crestodian",
      sessionKey: "agent:crestodian:main",
      sessionId: session.sessionId,
      workspaceDir: path.join(stateDir, "crestodian", "workspace"),
      sessionFile: path.join(stateDir, "crestodian", "sessions", `${session.sessionId}.jsonl`),
      messageChannel: "crestodian",
      messageProvider: "crestodian",
      toolsAllow: ["crestodian"],
      disableMessageTool: true,
    });
    expect(call.agentHarnessId).toBeUndefined();
    expect(requireValue(call.crestodianTool, "missing embedded Crestodian tool").proposalRef).toBe(
      session.proposalRef,
    );
  });

  it("rejects an implicit default model as unavailable inference", async () => {
    useTempStateDir();
    const runCliAgent = vi.fn();
    const runEmbeddedAgent = vi.fn();

    await expect(
      runCrestodianAgentTurnWithDeps(
        {
          input: "hello",
          overview: { defaultModel: "openai/stale-overview-model" } as never,
          surface: "gateway",
          approvalArmed: false,
          session: createCrestodianAgentSession(),
        },
        {
          runCliAgent: runCliAgent as never,
          runEmbeddedAgent: runEmbeddedAgent as never,
          readConfigFileSnapshot: vi.fn(async () => configSnapshot({})) as never,
        },
      ),
    ).rejects.toBeInstanceOf(CrestodianInferenceUnavailableError);
    expect(runCliAgent).not.toHaveBeenCalled();
    expect(runEmbeddedAgent).not.toHaveBeenCalled();
  });

  it("converts route-planning failures to a typed error and clears session state", async () => {
    useTempStateDir();
    const session = createCrestodianAgentSession();
    session.proposalRef.current = "partial-proposal";
    session.cliSession = {
      routeKey: "stale-route",
      binding: { sessionId: "uncertain-cli-session" },
    };

    await expect(
      runCrestodianAgentTurnWithDeps(
        {
          input: "hello",
          overview: { defaultModel: "openai/gpt-5.5" } as never,
          surface: "gateway",
          approvalArmed: false,
          session,
        },
        {
          readConfigFileSnapshot: vi.fn(async () => {
            throw new Error("config read failed");
          }) as never,
        },
      ),
    ).rejects.toBeInstanceOf(CrestodianInferenceUnavailableError);
    expect(session.proposalRef.current).toBeUndefined();
    expect(session.cliSession).toBeUndefined();
  });

  it.each([
    {
      name: "runner rejection",
      runEmbeddedAgent: async () => {
        throw new Error("provider unavailable");
      },
    },
    {
      name: "empty model output",
      runEmbeddedAgent: async () => ({ payloads: [] }),
    },
  ])("clears partial session state after $name", async ({ runEmbeddedAgent }) => {
    useTempStateDir();
    const config: OpenClawConfig = {
      agents: { defaults: { model: { primary: "openai/gpt-5.5" } } },
    };
    const session = createCrestodianAgentSession();
    session.proposalRef.current = "partial-proposal";
    session.cliSession = {
      routeKey: "stale-route",
      binding: { sessionId: "uncertain-cli-session" },
    };

    await expect(
      runCrestodianAgentTurnWithDeps(
        {
          input: "hello",
          overview: { defaultModel: "openai/gpt-5.5" } as never,
          surface: "gateway",
          approvalArmed: false,
          session,
        },
        {
          runEmbeddedAgent: runEmbeddedAgent as never,
          readConfigFileSnapshot: vi.fn(async () => configSnapshot(config)) as never,
        },
      ),
    ).rejects.toBeInstanceOf(CrestodianInferenceUnavailableError);
    expect(session.proposalRef.current).toBeUndefined();
    expect(session.cliSession).toBeUndefined();
  });
});
