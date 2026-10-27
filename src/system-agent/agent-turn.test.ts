import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { listAgentEntries } from "../agents/agent-scope-config.js";
import { testing as cliBackendsTesting } from "../agents/cli-backends.test-support.js";
import * as cliRunner from "../agents/cli-runner.js";
import * as embeddedAgent from "../agents/embedded-agent.js";
import * as configModule from "../config/config.js";
import { createSnapshot } from "../config/mutate.test-support.js";
import type { CliSessionBinding } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.js";
import {
  cleanupSystemAgentSession,
  createSystemAgentSession,
  runSystemAgentTurn as runSystemAgentTurnImpl,
  type SystemAgentSession,
} from "./agent-turn.js";
import { SystemAgentInferenceUnavailableError } from "./inference-error.js";
import {
  createSystemAgentVerifiedInferenceTestFixture,
  installSystemAgentClaudeCliBackendTestFixture,
  createSystemAgentSelectedProfileTestBinding,
  createSystemAgentPluginMetadataTestSnapshot,
  type SystemAgentPluginMetadataTestSnapshot,
} from "./system-agent.test-helpers.js";

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

type RunCliAgentParams = Parameters<typeof cliRunner.runCliAgent>[0] & {
  systemAgentTool?: import("../agents/tools/system-agent-tool.js").SystemAgentToolOptions;
};
type RunEmbeddedAgentParams = Parameters<typeof embeddedAgent.runEmbeddedAgent>[0] & {
  systemAgentTool?: import("../agents/tools/system-agent-tool.js").SystemAgentToolOptions;
};

const mocks = vi.hoisted(() => ({
  runEmbeddedAgent: vi.fn(async (_params: RunEmbeddedAgentParams) => ({
    meta: { durationMs: 0, finalAssistantVisibleText: "ready" },
  })),
}));

vi.mock("../agents/embedded-agent.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/embedded-agent.js")>()),
  runEmbeddedAgent: mocks.runEmbeddedAgent,
}));

vi.mock("../agents/cli-runner.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/cli-runner.js")>()),
  runCliAgent: vi.fn(),
}));

vi.mock("../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config.js")>()),
  readConfigFileSnapshot: vi.fn(async () => configSnapshot(defaultConfig())),
}));

const tempDirs = createTempDirTracker();
let stateDir: string;
let restoreCliBackendFixture: (() => void) | undefined;
let pluginMetadataSnapshot: SystemAgentPluginMetadataTestSnapshot | undefined;

const runSystemAgentTurn: typeof runSystemAgentTurnImpl = (...args) =>
  pluginMetadataSnapshot!.run(() => runSystemAgentTurnImpl(...args));

function turnParams(
  session: SystemAgentSession,
  input = "hello",
  overrides: Partial<Parameters<typeof runSystemAgentTurn>[0]> = {},
): Parameters<typeof runSystemAgentTurn>[0] {
  return { input, surface: "gateway", approvalArmed: false, session, ...overrides };
}

const defaultConfig = (model = "openai/gpt-5.5"): OpenClawConfig => ({
  agents: { defaults: { model } },
});
type Agents = NonNullable<OpenClawConfig["agents"]>;
type Agent = NonNullable<Agents["entries"]>[string];
function ownerConfig(
  agentDir: string,
  model: Agent["model"],
  defaults: Agents["defaults"] = {},
  extra: Partial<Agent> = {},
): OpenClawConfig {
  return { agents: { defaults, entries: { ops: { agentDir, model, ...extra } } } };
}

function configSnapshot(config: OpenClawConfig) {
  return {
    ...createSnapshot({ sourceConfig: config, hash: "hash" }),
    raw: JSON.stringify(config),
  };
}

async function createVerifiedSession(config: OpenClawConfig = defaultConfig()) {
  const fixture = await pluginMetadataSnapshot!.run(
    () => createSystemAgentVerifiedInferenceTestFixture(config),
    config,
  );
  vi.spyOn(configModule, "readConfigFileSnapshot").mockResolvedValue(configSnapshot(config));
  return {
    ...fixture,
    session: createSystemAgentSession(fixture.binding),
  };
}

function cliResult(binding?: CliSessionBinding, text = "ready") {
  const agentMeta = binding && {
    sessionId: binding.sessionId,
    provider: "claude-cli",
    model: "claude-opus-4-8",
    cliSessionBinding: binding,
  };
  return {
    payloads: [{ text }],
    meta: { durationMs: 0, ...(agentMeta ? { agentMeta } : {}) },
  };
}

function mockCliRunner(binding?: CliSessionBinding, text = "ready") {
  const run = vi.fn(async (_params: RunCliAgentParams) => cliResult(binding, text));
  vi.spyOn(cliRunner, "runCliAgent").mockImplementation(run);
  return run;
}

function mockEmbeddedRunner(text?: string) {
  const run = vi.fn(async (_params: RunEmbeddedAgentParams) => ({
    payloads: text === undefined ? [] : [{ text }],
    meta: { durationMs: 0 },
  }));
  vi.spyOn(embeddedAgent, "runEmbeddedAgent").mockImplementation(run);
  return run;
}

const cliIsolation = { disableCliLiveSession: true, cleanupCliLiveSessionOnRunEnd: true };

beforeAll(() => {
  pluginMetadataSnapshot = createSystemAgentPluginMetadataTestSnapshot();
});

beforeEach(() => {
  restoreCliBackendFixture = installSystemAgentClaudeCliBackendTestFixture();
  stateDir = tempDirs.make("openclaw-turn-");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
});

afterEach(() => {
  restoreCliBackendFixture?.();
  restoreCliBackendFixture = undefined;
  vi.unstubAllEnvs();

  vi.clearAllMocks();
  vi.restoreAllMocks();
  mocks.runEmbeddedAgent.mockImplementation(async () => ({
    meta: { durationMs: 0, finalAssistantVisibleText: "ready" },
  }));
  tempDirs.cleanup();
});

describe("runSystemAgentTurn", () => {
  it("keeps every turn on the verified profile and clears continuity on route drift", async () => {
    const verifiedConfig = {
      agents: {
        defaults: {
          model: "openai/gpt-5.5",
          timeoutSeconds: 600,
          models: {
            "openai/gpt-5.5": { agentRuntime: { id: "openclaw" } },
          },
        },
      },
      auth: {
        profiles: { "openai:p2": { provider: "openai", mode: "api_key" } },
      },
    } satisfies OpenClawConfig;
    const binding = await pluginMetadataSnapshot!.run(
      () => createSystemAgentSelectedProfileTestBinding(verifiedConfig, "openai:p2", "openclaw"),
      verifiedConfig,
    );
    const session = createSystemAgentSession(binding);
    let currentConfig: OpenClawConfig = verifiedConfig;
    const runEmbeddedAgent = mocks.runEmbeddedAgent;
    vi.spyOn(configModule, "readConfigFileSnapshot").mockImplementation(async () =>
      configSnapshot(currentConfig),
    );
    const turn = async () => await runSystemAgentTurn(turnParams(session, "continue setup"));

    await turn();
    expect(runEmbeddedAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        authProfileId: "openai:p2",
        authProfileIdSource: "user",
        config: binding.execution.runConfig,
        thinkLevel: "off",
        timeoutMs: 600_000,
      }),
    );

    currentConfig = {
      agents: { defaults: { model: "anthropic/claude-opus-4-8" } },
    };
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
      const fixture = await createVerifiedSession(config);
      const first = createSystemAgentSession(fixture.binding);
      const second = createSystemAgentSession(fixture.binding);
      const turns = [
        { session: first, input: "hello" },
        { session: second, input: "new conversation" },
        { session: first, input: "continue this conversation" },
      ];
      for (const { session, input } of turns) {
        await runSystemAgentTurn(turnParams(session, input));
      }

      const recorders = mocks.runEmbeddedAgent.mock.calls.map(([params]) =>
        expectDefined(params.userTurnTranscriptRecorder, "missing system-agent user-turn recorder"),
      );
      expect(new Set(recorders).size).toBe(turns.length);
      for (const [index, recorder] of recorders.entries()) {
        await expect(recorder.resolveMessage()).resolves.toMatchObject({
          role: "user",
          content: turns[index]?.input,
        });
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

      const firstPath = expectDefined(firstCall?.sessionFile, "missing first transcript path");
      const secondPath = expectDefined(secondCall?.sessionFile, "missing second transcript path");
      expect(firstPath).toBe(`in-memory:${first.sessionId}`);
      expect(secondPath).toBe(`in-memory:${second.sessionId}`);
      expect(firstPath).not.toBe(secondPath);
      expect(first.sessionManager).not.toBe(second.sessionManager);
      await cleanupSystemAgentSession(first);
      expect(first.sessionManager).toBeUndefined();
    },
  );

  it.each(["cli", "canonical-cli", "embedded"] as const)(
    "uses the default owner's %s model, credentials, and runtime",
    async (route) => {
      const agentDir = path.join(stateDir, "ops-agent");
      const embedded = route === "embedded";
      const canonical = route === "canonical-cli";
      const model = embedded
        ? "openai/gpt-5.4@openai:ops"
        : canonical
          ? "anthropic/claude-opus-4-8@anthropic:claude-cli"
          : "claude-cli/claude-opus-4-8@claude-cli:ops";
      const config = ownerConfig(
        agentDir,
        { primary: model },
        {
          model: { primary: "anthropic/claude-global" },
          systemAgent: { agentId: "ops" },
          models: { "openai/gpt-5.4": { agentRuntime: { id: "openclaw" } } },
        },
        embedded
          ? {
              params: { temperature: 0.2 },
              tools: { allow: ["read"], deny: ["exec"] },
              models: { "openai/gpt-5.4": { agentRuntime: { id: "codex" } } },
            }
          : canonical
            ? {
                models: { "anthropic/claude-opus-4-8": { agentRuntime: { id: "claude-cli" } } },
              }
            : {},
      );
      config.agents!.entries!.openclaw = {
        params: { temperature: 1.7 },
        tools: { allow: ["exec"] },
      };
      const cli = mockCliRunner();
      const sdk = mockEmbeddedRunner("ready");
      const { session } = await createVerifiedSession(config);
      await runSystemAgentTurn(turnParams(session, "hello", { operatorApprovalOnly: embedded }));
      const call = expectDefined((embedded ? sdk : cli).mock.calls[0]?.[0], "missing runner call");
      expect(embedded ? cli : sdk).not.toHaveBeenCalled();
      expect(call).toMatchObject({
        agentId: "openclaw",
        provider: embedded ? "openai" : "claude-cli",
        model: embedded ? "gpt-5.4" : "claude-opus-4-8",
        agentDir,
      });
      expect(call.authProfileId).toBe(
        canonical ? undefined : embedded ? "openai:ops" : "claude-cli:ops",
      );
      expect(expectDefined(call.systemAgentTool, "missing OpenClaw tool").proposalRef).toBe(
        session.proposalRef,
      );
      if (embedded) {
        expect(call).not.toHaveProperty("streamParams");
        expect(call).toMatchObject({
          systemAgentTool: { agentId: "ops", operatorApprovalOnly: true },
          authProfileIdSource: "user",
          agentHarnessRuntimeOverride: "codex",
          sandboxSessionKey: "agent:openclaw:main",
          toolsAllow: ["openclaw"],
          toolExecutionAllow: ["openclaw"],
          disableMessageTool: true,
        });
        expect(sdk.mock.calls[0]?.[0].agentHarnessId).toBeUndefined();
        expect(
          listAgentEntries(call.config ?? {}).find((agent) => agent.id === "openclaw"),
        ).toEqual({
          id: "openclaw",
          params: { temperature: 0.2 },
          tools: { allow: ["read"], deny: ["exec"] },
        });
      } else {
        expect(call).toMatchObject({
          runtimePolicySessionKey: "agent:openclaw:main",
          ...cliIsolation,
        });
        expect(call).toHaveProperty("cliToolAvailability", { native: [], openClaw: ["openclaw"] });
        expect(call.toolsAllow).toBeUndefined();
      }
    },
  );

  it("rejects an always-on CLI backend before launching OpenClaw", async () => {
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
    const config = defaultConfig("google-gemini-cli/gemini-3.1-pro-preview");
    const runCliAgent = vi.fn();
    const runEmbeddedAgent = vi.fn();
    const { session } = await createVerifiedSession(config);
    vi.spyOn(cliRunner, "runCliAgent").mockImplementation(runCliAgent);
    vi.spyOn(embeddedAgent, "runEmbeddedAgent").mockImplementation(runEmbeddedAgent);
    const failure = await runSystemAgentTurn(turnParams(session, "set up my workspace")).catch(
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
      const config = defaultConfig("claude-cli/claude-opus-4-8@claude-cli:ops");
      const binding = {
        sessionId: "native-claude-session",
        authProfileId: "claude-cli:ops",
        authEpochVersion: 1,
        authEpoch: "auth-epoch",
        cwdHash: "cwd-hash",
        mcpResumeHash: "openclaw-mcp-resume",
      };
      const runCliAgent = mockCliRunner(binding);
      const { session } = await createVerifiedSession(config);
      const turn = async (input: string) => await runSystemAgentTurn(turnParams(session, input));

      await turn("propose setup");
      session.proposalRef.current = "proposal-sha256";
      await runSystemAgentTurn(turnParams(session, "yes", { approvalArmed: true }));

      const firstCall = expectDefined(runCliAgent.mock.calls[0]?.[0], "missing first CLI call");
      const secondCall = expectDefined(runCliAgent.mock.calls[1]?.[0], "missing second CLI call");
      expect(firstCall.cliSessionBinding).toBeUndefined();
      expect(secondCall.cliSessionBinding).toEqual(binding);
      expect(secondCall).toMatchObject({
        systemAgentTool: { approvalArmed: true, proposalRef: { current: "proposal-sha256" } },
      });
      expect(firstCall).toMatchObject(cliIsolation);
      expect(secondCall).toMatchObject(cliIsolation);
      runCliAgent.mockImplementationOnce(async () => {
        session.proposalRef.current = "unfinished-proposal";
        session.proposalRef.operation = { kind: "setup" };
        const partial = cliResult(binding, "I'll check the gateway.");
        return {
          ...partial,
          meta: {
            ...partial.meta,
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

  it.each(["auth-route", "executable-policy", "embedded-route"] as const)(
    "rejects %s drift without resuming CLI continuity",
    async (drift) => {
      const agentDir = path.join(stateDir, "ops-agent");
      const cliModel = "claude-cli/claude-opus-4-8@claude-cli:ops";
      const config: OpenClawConfig =
        drift === "embedded-route" ? ownerConfig(agentDir, cliModel) : defaultConfig(cliModel);
      if (drift === "executable-policy") {
        config.tools = { exec: { mode: "full" } };
        // Model-owner policy stays fixed; OpenClaw follows the changing global policy.
        config.agents!.entries = { ops: { tools: { exec: { mode: "ask" } } } };
      }
      const changed = structuredClone(config);
      if (drift === "auth-route") {
        changed.agents!.defaults!.model = "claude-cli/claude-opus-4-8@claude-cli:other";
      } else if (drift === "executable-policy") {
        changed.tools!.exec!.mode = "deny";
      } else {
        changed.agents = ownerConfig(
          agentDir,
          "openai/gpt-5.4@openai:ops",
          {},
          {
            models: { "openai/gpt-5.4": { agentRuntime: { id: "codex" } } },
          },
        ).agents;
      }
      const binding = {
        sessionId: "native-claude-session",
        authEpochVersion: 1,
        ...(drift === "executable-policy" ? { authProfileId: "claude-cli:ops" } : {}),
      };
      const runCliAgent = mockCliRunner(binding, drift === "embedded-route" ? "cli" : "ready");
      const readConfigFileSnapshot = vi
        .fn()
        .mockResolvedValueOnce(configSnapshot(config))
        .mockResolvedValueOnce(configSnapshot(config))
        .mockResolvedValueOnce(configSnapshot(changed));
      const { session } = await createVerifiedSession(config);
      vi.spyOn(configModule, "readConfigFileSnapshot").mockImplementation(readConfigFileSnapshot);
      const runEmbeddedAgent =
        drift === "embedded-route" ? mockEmbeddedRunner("embedded") : undefined;
      await runSystemAgentTurn(turnParams(session, "first CLI turn"));
      if (drift === "embedded-route") {
        expect(session.cliSession?.binding.sessionId).toBe(binding.sessionId);
      }
      await expect(runSystemAgentTurn(turnParams(session))).rejects.toBeInstanceOf(
        SystemAgentInferenceUnavailableError,
      );
      expect(session.cliSession).toBeUndefined();
      expect(runCliAgent).toHaveBeenCalledOnce();
      if (runEmbeddedAgent) {
        expect(runEmbeddedAgent).not.toHaveBeenCalled();
      }
    },
  );

  it("rejects a low-level session without verified inference before lookup or run", async () => {
    const runCliAgent = vi.fn();
    const runEmbeddedAgent = vi.fn();
    const readConfigFileSnapshot = vi.fn(async () => configSnapshot(defaultConfig()));
    const unverifiedSession = {
      sessionId: "openclaw-unverified",
      proposalRef: {},
    } as unknown as SystemAgentSession;

    vi.spyOn(cliRunner, "runCliAgent").mockImplementation(runCliAgent);
    vi.spyOn(embeddedAgent, "runEmbeddedAgent").mockImplementation(runEmbeddedAgent);
    vi.spyOn(configModule, "readConfigFileSnapshot").mockImplementation(readConfigFileSnapshot);
    await expect(runSystemAgentTurn(turnParams(unverifiedSession))).rejects.toMatchObject({
      message: expect.stringContaining("openclaw onboard"),
    });
    expect(readConfigFileSnapshot).not.toHaveBeenCalled();
    expect(runCliAgent).not.toHaveBeenCalled();
    expect(runEmbeddedAgent).not.toHaveBeenCalled();
  });

  it("converts route-planning failures to a typed error and clears session state", async () => {
    const { session } = await createVerifiedSession();
    session.proposalRef.current = "partial-proposal";
    session.cliSession = {
      routeKey: "stale-route",
      binding: { sessionId: "uncertain-cli-session" },
    };

    vi.spyOn(configModule, "readConfigFileSnapshot").mockImplementation(async () => {
      throw new Error("config read failed");
    });
    await expect(runSystemAgentTurn(turnParams(session))).rejects.toBeInstanceOf(
      SystemAgentInferenceUnavailableError,
    );
    expect(session.proposalRef.current).toBeUndefined();
    expect(session.cliSession).toBeUndefined();
  });
});
