import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { listAgentEntries } from "../agents/agent-scope-config.js";
import { testing as cliBackendsTesting } from "../agents/cli-backends.test-support.js";
import { prepareEmbeddedSkills } from "../agents/embedded-agent-runner/skill-runtime.js";
import { createSystemAgentTool } from "../agents/tools/system-agent-tool.js";
import type { CliSessionBinding } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.js";
import { CommandLane } from "../process/lanes.js";
import {
  cleanupSystemAgentSession,
  createSystemAgentSession,
  type SystemAgentSession,
} from "./agent-turn.js";
import {
  runSystemAgentTurnWithDeps as runSystemAgentTurnWithDepsImpl,
  type SystemAgentTurnDeps,
} from "./agent-turn.test-support.js";
import {
  configSnapshot,
  modelConfig,
  opsConfig,
  createProfileInference,
  profileConfig,
} from "./configured-inference.test-support.js";
import { SystemAgentInferenceUnavailableError } from "./inference-error.js";
import { resolveSystemAgentConfiguredRouteFromConfig as resolveSystemAgentConfiguredRouteFromConfigImpl } from "./inference-route.js";
import {
  createSystemAgentVerifiedInferenceTestFixture as createSystemAgentVerifiedInferenceTestFixtureImpl,
  installSystemAgentClaudeCliBackendTestFixture,
  createSystemAgentPluginMetadataTestSnapshot,
  type SystemAgentPluginMetadataTestSnapshot,
} from "./system-agent.test-helpers.js";
import { createSystemAgentVerifiedInferenceBinding as createSystemAgentVerifiedInferenceBindingImpl } from "./verified-inference.js";

vi.mock("../plugins/providers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/providers.js")>()),
  resolveOwningPluginIdsForModelRefs: vi.fn(() => []),
  resolveOwningPluginIdsForProviderRef: vi.fn(() => []),
}));

vi.mock("../agents/harness/runtime-plugin.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/harness/runtime-plugin.js")>()),
  resolveAgentHarnessOwnerPluginIds: vi.fn(({ runtime }: { runtime: string }) =>
    runtime === "codex" ? ["codex"] : [],
  ),
}));

type RunCliAgentParams = Parameters<NonNullable<SystemAgentTurnDeps["runCliAgent"]>>[0];
type RunEmbeddedAgentParams = Parameters<NonNullable<SystemAgentTurnDeps["runEmbeddedAgent"]>>[0];

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

const tempDirs = createTempDirTracker();
let restoreCliBackendFixture: (() => void) | undefined;
let pluginMetadataSnapshot: SystemAgentPluginMetadataTestSnapshot | undefined;

const runSystemAgentTurnWithDeps: typeof runSystemAgentTurnWithDepsImpl = (...args) =>
  pluginMetadataSnapshot!.run(() => runSystemAgentTurnWithDepsImpl(...args));

const createSystemAgentVerifiedInferenceTestFixture: typeof createSystemAgentVerifiedInferenceTestFixtureImpl =
  (...args) =>
    pluginMetadataSnapshot!.run(
      () => createSystemAgentVerifiedInferenceTestFixtureImpl(...args),
      args[0],
    );

const resolveSystemAgentConfiguredRouteFromConfig: typeof resolveSystemAgentConfiguredRouteFromConfigImpl =
  (...args) =>
    pluginMetadataSnapshot!.run(
      () => resolveSystemAgentConfiguredRouteFromConfigImpl(...args),
      args[0],
    );

const createSystemAgentVerifiedInferenceBinding: typeof createSystemAgentVerifiedInferenceBindingImpl =
  (...args) =>
    pluginMetadataSnapshot!.run(() => createSystemAgentVerifiedInferenceBindingImpl(...args));

function turnParams(
  session: SystemAgentSession,
  input = "hello",
): Parameters<typeof runSystemAgentTurnWithDeps>[0] {
  return { input, surface: "gateway", approvalArmed: false, session };
}

function useTempStateDir(): string {
  const stateDir = tempDirs.make("openclaw-turn-");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);

  return stateDir;
}

function policyConfig(mode: "full" | "deny"): OpenClawConfig {
  return {
    tools: { exec: { mode } },
    agents: {
      defaults: { model: "claude-cli/claude-opus-4-8@claude-cli:ops" },
      // OpenClaw follows global policy, not the model owner's unchanged policy.
      entries: { ops: { tools: { exec: { mode: "ask" } } } },
    },
  };
}

function nativeBinding(overrides: Partial<CliSessionBinding> = {}): CliSessionBinding {
  return { sessionId: "native-claude-session", authEpochVersion: 1, ...overrides };
}

function cliRunner(binding: CliSessionBinding, text = "ready") {
  return vi.fn(async (_params: RunCliAgentParams) => ({
    payloads: [{ text }],
    meta: { agentMeta: { cliSessionBinding: binding } },
  }));
}

async function createVerifiedSession(config: OpenClawConfig = modelConfig()) {
  const fixture = await createSystemAgentVerifiedInferenceTestFixture(config);
  const session = createSystemAgentSession(fixture.binding);
  return {
    ...fixture,
    session,
    turn: (
      overrides: SystemAgentTurnDeps = {},
      input = "hello",
      options: Partial<Parameters<typeof runSystemAgentTurnWithDeps>[0]> = {},
    ) =>
      runSystemAgentTurnWithDeps(
        { ...turnParams(session, input), ...options },
        {
          ...fixture.deps,
          readConfigFileSnapshot: vi.fn(async () => configSnapshot(config)),
          ...overrides,
        },
      ),
  };
}

beforeAll(() => {
  pluginMetadataSnapshot = createSystemAgentPluginMetadataTestSnapshot();
});

beforeEach(() => {
  restoreCliBackendFixture = installSystemAgentClaudeCliBackendTestFixture();
});

afterEach(() => {
  restoreCliBackendFixture?.();
  restoreCliBackendFixture = undefined;
  vi.unstubAllEnvs();

  vi.clearAllMocks();
  tempDirs.cleanup();
});

describe("runSystemAgentTurn", () => {
  it("keeps every turn on the verified profile and clears continuity on route drift", async () => {
    useTempStateDir();
    const verifiedConfig = profileConfig(600);
    const { binding, deps: authDeps } = await createProfileInference(
      verifiedConfig,
      {
        resolveRoute: resolveSystemAgentConfiguredRouteFromConfig,
        createBinding: createSystemAgentVerifiedInferenceBinding,
      },
      "openclaw",
    );
    const session = createSystemAgentSession(binding);
    let currentConfig: OpenClawConfig = verifiedConfig;
    const runEmbeddedAgent = vi.fn(async (_params: RunEmbeddedAgentParams) => ({
      meta: { finalAssistantVisibleText: "ready" },
    }));
    const turn = async () =>
      await runSystemAgentTurnWithDeps(turnParams(session, "continue setup"), {
        ...authDeps,
        runEmbeddedAgent: runEmbeddedAgent as never,
        readConfigFileSnapshot: vi.fn(async () => configSnapshot(currentConfig)) as never,
      });

    await turn();
    expect(runEmbeddedAgent.mock.calls[0]?.[0]).toMatchObject({
      authProfileId: "openai:p2",
      authProfileIdSource: "user",
      thinkLevel: "off",
      timeoutMs: 600_000,
    });
    expect(runEmbeddedAgent.mock.calls[0]?.[0].config).toEqual(binding.execution.runConfig);

    currentConfig = modelConfig("anthropic/claude-opus-4-8");
    await expect(turn()).rejects.toMatchObject({
      message: expect.stringContaining("verified inference route changed"),
    });
    expect(runEmbeddedAgent).toHaveBeenCalledOnce();
    expect(session.verifiedInference).toBe(binding);
    expect(session.cliSession).toBeUndefined();
  });

  it.each(["primary", "utility"] as const)(
    "isolates conversation identities and resumes the same transcript for %s inference",
    async (role) => {
      useTempStateDir();
      const config = {
        ...(role === "utility"
          ? { meta: { migrations: { utilityModelSeparation: true as const } } }
          : {}),
        agents: {
          defaults:
            role === "utility"
              ? { utilityModel: "openai/gpt-5.5" }
              : { model: { primary: "openai/gpt-5.5" } },
        },
      } satisfies OpenClawConfig;
      const fixture = await createSystemAgentVerifiedInferenceTestFixture(config);
      const first = createSystemAgentSession(fixture.binding);
      const second = createSystemAgentSession(fixture.binding);
      const deps = {
        ...fixture.deps,
        readConfigFileSnapshot: vi.fn(async () => configSnapshot(config)) as never,
      };

      for (const session of [first, second, first]) {
        await runSystemAgentTurnWithDeps(turnParams(session), deps);
      }

      const [firstCall, secondCall, resumedCall] = mocks.runEmbeddedAgent.mock.calls.map(
        ([params]) => params,
      );
      expect(firstCall?.sessionKey).toBe(`agent:openclaw:${first.sessionId}`);
      expect(secondCall?.sessionKey).toBe(`agent:openclaw:${second.sessionId}`);
      expect(resumedCall?.sessionKey).toBe(firstCall?.sessionKey);
      expect(resumedCall?.sessionManager).toBe(first.sessionManager);
      expect(resumedCall?.extraSystemPrompt).toBe(firstCall?.extraSystemPrompt);
      expect(
        firstCall?.extraSystemPrompt?.includes(
          "No primary model is configured for regular agent chat",
        ),
      ).toBe(role === "utility");

      const firstPath = firstCall?.sessionFile;
      const secondPath = secondCall?.sessionFile;
      expect(firstPath).toBe(`in-memory:${first.sessionId}`);
      expect(secondPath).toBe(`in-memory:${second.sessionId}`);
      expect(firstPath).not.toBe(secondPath);
      expect(first.sessionManager).not.toBe(second.sessionManager);
      await cleanupSystemAgentSession(first);
      expect(first.sessionManager).toBeUndefined();
    },
  );

  it("omits unreadable workspace skills from the system helper", async () => {
    const stateDir = useTempStateDir();
    const workspaceDir = path.join(stateDir, "openclaw", "workspace");
    const skillDir = path.join(workspaceDir, "skills", "workspace-only-task");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      "---\nname: workspace-only-task\ndescription: Requires the read tool.\n---\nRead task files.\n",
    );
    const { turn } = await createVerifiedSession();
    const runEmbeddedAgent = vi.fn(async (params: RunEmbeddedAgentParams) => {
      const prepared = await prepareEmbeddedSkills({
        attempt: params,
        effectiveWorkspace: params.workspaceDir,
        sandbox: null,
        sessionAgentId: "openclaw",
        includeCodeModeSkills: true,
      });
      try {
        expect(prepared.skillsPrompt).toBe("");
        expect(prepared.codeModeSkills).toEqual([]);
      } finally {
        prepared.restoreSkillEnv();
      }
      return { payloads: [{ text: "ready" }], meta: { durationMs: 0 } };
    });

    await expect(turn({ runEmbeddedAgent }, "check the gateway")).resolves.toMatchObject({
      text: "ready",
    });
    expect(runEmbeddedAgent).toHaveBeenCalledOnce();
  });

  it("uses the default agent CLI route while keeping OpenClaw session identity", async () => {
    const stateDir = useTempStateDir();
    const agentDir = path.join(stateDir, "ops-agent");
    const config = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-global" },
          timeoutSeconds: 900,
        },
        entries: {
          ops: {
            agentDir,
            model: { primary: "claude-cli/claude-opus-4-8@claude-cli:ops" },
          },
        },
      },
    } as OpenClawConfig;
    const runCliAgent = vi.fn(async (_params: RunCliAgentParams) => ({
      payloads: [{ text: "ready" }],
    }));
    const runEmbeddedAgent = vi.fn(async (_params: RunEmbeddedAgentParams) => ({
      payloads: [],
    }));
    const { session, deps } = await createVerifiedSession(config);

    await runSystemAgentTurnWithDeps(turnParams(session), {
      ...deps,
      runCliAgent: runCliAgent as never,
      runEmbeddedAgent: runEmbeddedAgent as never,
      readConfigFileSnapshot: vi.fn(async () => configSnapshot(config)) as never,
    });

    expect(runCliAgent).toHaveBeenCalledOnce();
    expect(runEmbeddedAgent).not.toHaveBeenCalled();
    const call = expectDefined(runCliAgent.mock.calls[0]?.[0], "missing CLI runner call");
    expect(call).toMatchObject({
      provider: "claude-cli",
      model: "claude-opus-4-8",
      agentDir,
      authProfileId: "claude-cli:ops",
      agentId: "openclaw",
      sessionKey: `agent:openclaw:${session.sessionId}`,
      runtimePolicySessionKey: "agent:openclaw:main",
      sessionId: session.sessionId,
      workspaceDir: path.join(stateDir, "openclaw", "workspace"),
      sessionFile: `in-memory:${session.sessionId}`,
      messageChannel: "openclaw",
      messageProvider: "openclaw",
      timeoutMs: 900_000,
    });
    expect(call.disableCliLiveSession).toBe(true);
    expect(call.cleanupCliLiveSessionOnRunEnd).toBe(true);
    expect(call.cliToolAvailability).toEqual({
      native: [],
      openClaw: ["openclaw"],
    });
    expect(call.toolsAllow).toBeUndefined();
    expect(expectDefined(call.systemAgentTool, "missing CLI OpenClaw tool").proposalRef).toBe(
      session.proposalRef,
    );
  });

  it("rejects an always-on CLI backend before launching OpenClaw", async () => {
    useTempStateDir();
    cliBackendsTesting.setDepsForTest({
      resolveRuntimeCliBackends: () => [
        {
          id: "google-gemini-cli",
          pluginId: "google",
          modelProvider: "google",
          config: { command: "gemini" },
          nativeToolMode: "always-on",
        },
      ],
    });
    const config = modelConfig("google-gemini-cli/gemini-3.1-pro-preview");
    const runCliAgent = vi.fn();
    const runEmbeddedAgent = vi.fn();
    const { turn } = await createVerifiedSession(config);
    const failure = await turn({ runCliAgent, runEmbeddedAgent }, "set up my workspace").catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(SystemAgentInferenceUnavailableError);
    expect((failure as Error).message).toContain("Select a compatible model/runtime route");
    expect((failure as Error).message).not.toContain("openclaw onboard");
    expect((failure as SystemAgentInferenceUnavailableError).failures).toEqual([
      expect.objectContaining({
        message: expect.stringContaining(
          "CLI backend google-gemini-cli cannot enforce OpenClaw's exact tool availability",
        ),
      }),
    ]);
    expect(runCliAgent).not.toHaveBeenCalled();
    expect(runEmbeddedAgent).not.toHaveBeenCalled();
  });

  it.each(["timeout", "aborted"] as const)(
    "resumes Claude's native transcript and clears continuity after a partial %s",
    async (stopReason) => {
      useTempStateDir();
      const config = modelConfig("claude-cli/claude-opus-4-8@claude-cli:ops");
      const binding = nativeBinding({ authProfileId: "claude-cli:ops" });
      const runCliAgent = cliRunner(binding);
      const { session, turn: runTurn } = await createVerifiedSession(config);
      const turn = (input: string) => runTurn({ runCliAgent: runCliAgent as never }, input);

      await turn("propose setup");
      await turn("yes");

      const firstCall = expectDefined(runCliAgent.mock.calls[0]?.[0], "missing first CLI call");
      const secondCall = expectDefined(runCliAgent.mock.calls[1]?.[0], "missing second CLI call");
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
      runCliAgent.mockImplementationOnce(async () => {
        session.proposalRef.current = "unfinished-proposal";
        session.proposalRef.operation = { kind: "setup" };
        return {
          payloads: [{ text: "I'll check the gateway." }],
          meta: {
            agentMeta: { cliSessionBinding: binding },
            aborted: true,
            providerStarted: true,
            stopReason,
            ...(stopReason === "timeout" ? { timeoutPhase: "provider" as const } : {}),
          },
        };
      });
      await expect(turn("check the gateway")).rejects.toMatchObject({
        code: "SYSTEM_AGENT_INFERENCE_UNAVAILABLE",
        message: expect.stringContaining(stopReason === "timeout" ? "timed out" : "aborted"),
      });
      expect(session.cliSession).toBeUndefined();
      expect(session.proposalRef).toEqual({});
      await turn("retry the check");
      expect(runCliAgent.mock.calls[3]?.[0].cliSessionBinding).toBeUndefined();
      await cleanupSystemAgentSession(session);

      expect(session.cliSession).toBeUndefined();
      expect(session.sessionManager).toBeUndefined();
    },
  );

  it("runs a canonical Anthropic model through its configured Claude CLI runtime", async () => {
    const stateDir = useTempStateDir();
    const agentDir = path.join(stateDir, "ops-agent");
    const config = opsConfig(
      { primary: "anthropic/claude-opus-4-8@anthropic:claude-cli" },
      agentDir,
      {
        models: { "anthropic/claude-opus-4-8": { agentRuntime: { id: "claude-cli" } } },
      },
    );
    const runCliAgent = vi.fn(async (_params: RunCliAgentParams) => ({
      payloads: [{ text: "ready" }],
    }));
    const { turn } = await createVerifiedSession(config);

    await turn({
      runCliAgent: runCliAgent as never,
      runEmbeddedAgent: vi.fn(async (_params: RunEmbeddedAgentParams) => ({ payloads: [] })),
    });

    expect(runCliAgent).toHaveBeenCalledOnce();
    expect(runCliAgent.mock.calls[0]?.[0]).toMatchObject({
      provider: "claude-cli",
      model: "claude-opus-4-8",
      agentDir,
    });
    expect(runCliAgent.mock.calls[0]?.[0].lane).toBeUndefined();
    expect(runCliAgent.mock.calls[0]?.[0].authProfileId).toBeUndefined();
  });

  it("reuses the guarded CLI binding when a denied proposal becomes approved", async () => {
    const stateDir = useTempStateDir();
    const agentDir = path.join(stateDir, "ops-agent");
    const config = opsConfig("claude-cli/claude-opus-4-8@claude-cli:ops", agentDir);
    const binding = nativeBinding({
      authProfileId: "claude-cli:ops",
      authEpoch: "auth-epoch",
      cwdHash: "cwd-hash",
      mcpResumeHash: "openclaw-mcp-resume",
    });
    const runCliAgent = cliRunner(binding);
    const { session, turn } = await createVerifiedSession(config);
    await turn({ runCliAgent: runCliAgent as never }, "set the default model");
    // Mirrors the denied tool result that arms the exact-operation hash.
    session.proposalRef.current = "proposal-sha256";
    await turn({ runCliAgent: runCliAgent as never }, "yes", { approvalArmed: true });

    expect(runCliAgent).toHaveBeenCalledTimes(2);
    const firstCall = expectDefined(runCliAgent.mock.calls[0]?.[0], "missing first CLI call");
    const secondCall = expectDefined(runCliAgent.mock.calls[1]?.[0], "missing second CLI call");
    expect(firstCall.cliSessionBinding).toBeUndefined();
    expect(secondCall).toMatchObject({
      cliSessionBinding: binding,
      disableCliLiveSession: true,
      cleanupCliLiveSessionOnRunEnd: true,
      systemAgentTool: {
        approvalArmed: true,
        proposalRef: { current: "proposal-sha256" },
      },
    });
  });

  it.each(["auth-route", "executable-policy"])(
    "rejects a %s change and invalidates CLI continuity",
    async (kind) => {
      useTempStateDir();
      const policy = kind === "executable-policy";
      const config = policy
        ? policyConfig("full")
        : modelConfig("claude-cli/claude-opus-4-8@claude-cli:ops");
      const changed = policy
        ? policyConfig("deny")
        : modelConfig("claude-cli/claude-opus-4-8@claude-cli:other");
      const runCliAgent = cliRunner(
        nativeBinding(policy ? { authProfileId: "claude-cli:ops" } : {}),
      );
      const readConfigFileSnapshot = vi
        .fn()
        .mockResolvedValueOnce(configSnapshot(config))
        .mockResolvedValueOnce(configSnapshot(config))
        .mockResolvedValueOnce(configSnapshot(changed));
      const { session, turn: runTurn } = await createVerifiedSession(config);
      const turn = () => runTurn({ runCliAgent, readConfigFileSnapshot });
      await turn();
      await expect(turn()).rejects.toBeInstanceOf(SystemAgentInferenceUnavailableError);
      expect(runCliAgent).toHaveBeenCalledOnce();
      expect(session.cliSession).toBeUndefined();
    },
  );

  it("rejects an intervening embedded route before it can revive CLI continuity", async () => {
    const stateDir = useTempStateDir();
    const agentDir = path.join(stateDir, "ops-agent");
    const cliConfig = opsConfig("claude-cli/claude-opus-4-8@claude-cli:ops", agentDir);
    const embeddedConfig = opsConfig("openai/gpt-5.4@openai:ops", agentDir, {
      models: { "openai/gpt-5.4": { agentRuntime: { id: "codex" } } },
    });
    const binding = nativeBinding();
    const runCliAgent = cliRunner(binding, "cli");
    const runEmbeddedAgent = vi.fn(async (_params: RunEmbeddedAgentParams) => ({
      payloads: [{ text: "embedded" }],
    }));
    const readConfigFileSnapshot = vi
      .fn()
      .mockResolvedValueOnce(configSnapshot(cliConfig))
      .mockResolvedValueOnce(configSnapshot(cliConfig))
      .mockResolvedValueOnce(configSnapshot(embeddedConfig));
    const { session, turn: runTurn } = await createVerifiedSession(cliConfig);
    const turn = (input: string) =>
      runTurn({ runCliAgent, runEmbeddedAgent, readConfigFileSnapshot }, input);

    await turn("first CLI turn");
    expect(session.cliSession?.binding.sessionId).toBe(binding.sessionId);
    await expect(turn("embedded turn")).rejects.toBeInstanceOf(
      SystemAgentInferenceUnavailableError,
    );
    expect(session.cliSession).toBeUndefined();

    expect(runCliAgent).toHaveBeenCalledOnce();
    expect(runEmbeddedAgent).not.toHaveBeenCalled();
  });

  it("uses the default agent embedded model, auth directory, profile, and runtime", async () => {
    const stateDir = useTempStateDir();
    const agentDir = path.join(stateDir, "ops-agent");
    const config = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-global" },
          systemAgent: { agentId: "ops" },
          models: {
            "openai/gpt-5.4": { agentRuntime: { id: "openclaw" } },
          },
        },
        entries: {
          ops: {
            agentDir,
            model: { primary: "openai/gpt-5.4@openai:ops" },
            params: { temperature: 0.2 },
            tools: { allow: ["read"], deny: ["exec"] },
            models: {
              "openai/gpt-5.4": { agentRuntime: { id: "codex" } },
            },
          },
          openclaw: {
            params: { temperature: 1.7 },
            tools: { allow: ["exec"] },
          },
        },
      },
    } as OpenClawConfig;
    const runCliAgent = vi.fn(async (_params: RunCliAgentParams) => ({ payloads: [] }));
    const runEmbeddedAgent = vi.fn(async (_params: RunEmbeddedAgentParams) => ({
      payloads: [{ text: "ready" }],
    }));
    const { session, turn } = await createVerifiedSession(config);

    await turn({ runCliAgent, runEmbeddedAgent });

    expect(runEmbeddedAgent).toHaveBeenCalledOnce();
    expect(runCliAgent).not.toHaveBeenCalled();
    const call = expectDefined(runEmbeddedAgent.mock.calls[0]?.[0], "missing embedded runner call");
    expect(call).not.toHaveProperty("streamParams");
    expect(call).toMatchObject({
      provider: "openai",
      model: "gpt-5.4",
      lane: CommandLane.SystemAgentInference,
      systemAgentTool: { agentId: "ops" },
      agentDir,
      authProfileId: "openai:ops",
      authProfileIdSource: "user",
      agentHarnessRuntimeOverride: "codex",
      agentId: "openclaw",
      sessionKey: `agent:openclaw:${session.sessionId}`,
      sandboxSessionKey: "agent:openclaw:main",
      sessionId: session.sessionId,
      workspaceDir: path.join(stateDir, "openclaw", "workspace"),
      sessionFile: `in-memory:${session.sessionId}`,
      messageChannel: "openclaw",
      messageProvider: "openclaw",
      toolsAllow: ["openclaw"],
      disableMessageTool: true,
    });
    expect(call.agentHarnessId).toBeUndefined();
    expect(listAgentEntries(call.config ?? {}).find((agent) => agent.id === "openclaw")).toEqual({
      id: "openclaw",
      params: { temperature: 0.2 },
      tools: { allow: ["read"], deny: ["exec"] },
    });
    expect(expectDefined(call.systemAgentTool, "missing embedded OpenClaw tool").proposalRef).toBe(
      session.proposalRef,
    );
  });

  it("threads operator-approval-only into the real ring-zero tool and stages the delegated proposal", async () => {
    useTempStateDir();
    const { session, turn } = await createVerifiedSession();
    const runEmbeddedAgent = vi.fn(async (params: RunEmbeddedAgentParams) => {
      const options = expectDefined(params.systemAgentTool, "missing system agent tool options");
      const tool = createSystemAgentTool(options);
      const result = await tool.execute("delegated-turn", {
        action: "config_set",
        path: "agents.defaults.subagents.thinking",
        value: "high",
        approved: true,
      });
      const text = (result as { content: Array<{ type: string; text?: string }> }).content
        .map((block) => block.text ?? "")
        .filter(Boolean)
        .join("\n");
      return { meta: { finalAssistantVisibleText: text } };
    });

    const reply = await turn({ runEmbeddedAgent }, "switch the thinking level", {
      operatorApprovalOnly: true,
    });

    expect(runEmbeddedAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        systemAgentTool: expect.objectContaining({ operatorApprovalOnly: true }),
      }),
    );
    expect(reply?.text).toContain("requesting session's permission policy");
    expect(reply?.text).toContain("returns the final outcome");
    expect(reply?.text).not.toContain("OpenClaw operator UI");
    expect(reply?.text).not.toContain("ask the user to reply yes");
    // Staging still registers the exact proposal for host authorization.
    expect(session.proposalRef.current).toBeDefined();
  });

  it("rejects a low-level session without verified inference before lookup or run", async () => {
    useTempStateDir();
    const runCliAgent = vi.fn();
    const runEmbeddedAgent = vi.fn();
    const readConfigFileSnapshot = vi.fn(async () => configSnapshot(modelConfig()));
    const unverifiedSession = {
      sessionId: "openclaw-unverified",
      proposalRef: {},
    } as unknown as SystemAgentSession;

    await expect(
      runSystemAgentTurnWithDeps(turnParams(unverifiedSession), {
        runCliAgent: runCliAgent as never,
        runEmbeddedAgent: runEmbeddedAgent as never,
        readConfigFileSnapshot: readConfigFileSnapshot as never,
      }),
    ).rejects.toMatchObject({ message: expect.stringContaining("openclaw onboard") });
    expect(readConfigFileSnapshot).not.toHaveBeenCalled();
    expect(runCliAgent).not.toHaveBeenCalled();
    expect(runEmbeddedAgent).not.toHaveBeenCalled();
  });

  it("converts route-planning failures to a typed error and clears session state", async () => {
    useTempStateDir();
    const config = {
      agents: { defaults: { model: "openai/gpt-5.5" } },
    } satisfies OpenClawConfig;
    const { session, deps } = await createVerifiedSession(config);
    session.proposalRef.current = "partial-proposal";
    session.cliSession = {
      routeKey: "stale-route",
      binding: { sessionId: "uncertain-cli-session" },
    };

    await expect(
      runSystemAgentTurnWithDeps(turnParams(session), {
        ...deps,
        readConfigFileSnapshot: vi.fn(async () => {
          throw new Error("config read failed");
        }) as never,
      }),
    ).rejects.toBeInstanceOf(SystemAgentInferenceUnavailableError);
    expect(session.proposalRef.current).toBeUndefined();
    expect(session.cliSession).toBeUndefined();
  });
});
