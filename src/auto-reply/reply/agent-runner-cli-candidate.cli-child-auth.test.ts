// Proves the CLI child credential handoff end to end: the reply dispatch
// converts a session-layer auth pin before the run, and the spawned claude
// child must observe the converted identity. A model-provider auto pin must
// reach the child as no forwarded credential so the CLI keeps its own native
// login, while a profile the backend owns is forwarded and materialized by the
// backend's own execution preparation. The stub child records only credential
// env key names, never values.
import { mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import nodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { resolveAgentDir } from "../../agents/agent-scope-config.js";
import { clearAuthProfileMigrationDiagnostics } from "../../agents/auth-profiles/legacy-source-diagnostic.js";
import { updateAuthProfileStoreWithLock } from "../../agents/auth-profiles/store-runtime.js";
import type { AuthProfileCredential } from "../../agents/auth-profiles/types.js";
import { testing as cliBackendsTesting } from "../../agents/cli-backends.test-support.js";
import type { RunCliAgentParams } from "../../agents/cli-runner/types.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import type { TemplateContext } from "../templating.js";
import {
  setupAgentRunnerExecutionTestState,
  getExecuteAgentTurnForTest,
  createFollowupRun,
  createMinimalRunAgentTurnParams,
  initialFallbackAttemptOptions,
  requireMockCall,
  loadActualRunCliAgentForTest,
} from "./agent-runner-execution.test-support.js";
import type { FallbackRunnerParams } from "./agent-runner-execution.test-support.js";

const state = await setupAgentRunnerExecutionTestState();

const scriptedCliProgram = String.raw`
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  if (!input.trim()) process.exit(2);
  const fs = require("node:fs");
  const dumpPath = process.argv[1] || process.env.OPENCLAW_TEST_CHILD_DUMP;
  if (!dumpPath) process.exit(3);
  const credentialEnvKeys = Object.keys(process.env)
    .filter((name) => name === "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR")
    .sort();
  fs.appendFileSync(
    dumpPath,
    JSON.stringify({
      credentialEnvKeys,
      forwardsApiKeyDescriptor: Boolean(process.env.CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR),
    }) + "\n",
  );
  const events = [
    { type: "init", session_id: "scripted-auth-handoff" },
    {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "Scripted final answer." },
      },
    },
    { type: "stream_event", event: { type: "message_stop" } },
    { type: "result", session_id: "scripted-auth-handoff", result: "Scripted final answer." },
  ];
  process.stdout.write(events.map((event) => JSON.stringify(event)).join("\n") + "\n");
});
`;

type ChildCredentialDump = {
  credentialEnvKeys: string[];
  forwardsApiKeyDescriptor: boolean;
};

const claudeCliModel = "claude-opus-4-6";

describe("executeAgentTurn: CLI child credential handoff", () => {
  let stateDir: string;
  let agentDir: string;
  let dumpPath: string;

  beforeEach(() => {
    stateDir = useAutoCleanupTempDirTracker(onTestFinished).make("openclaw-cli-child-auth-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    agentDir = resolveAgentDir({}, "agent");
    mkdirSync(agentDir, { recursive: true });
    dumpPath = nodePath.join(stateDir, "child-credential-dumps.jsonl");
    vi.stubEnv("OPENCLAW_TEST_CHILD_DUMP", dumpPath);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    clearAuthProfileMigrationDiagnostics();
    cliBackendsTesting.resetDepsForTest();
  });

  async function seedAuthProfile(profileId: string, credential: AuthProfileCredential) {
    await updateAuthProfileStoreWithLock({
      agentDir,
      updater: (store) => {
        store.profiles[profileId] = credential;
        return true;
      },
    });
  }

  function registerScriptedClaudeCliBackend() {
    // The stub backend keeps the core one-shot JSONL transport; the plugin's
    // own credential materialization seam is covered by the plugin's tests, so
    // this child run observes the credential env the runner forwards itself.
    const backend = {
      id: "claude-cli",
      modelProvider: "anthropic",
      pluginId: "anthropic",
      bundleMcp: false,
      config: {
        command: process.execPath,
        args: ["-e", scriptedCliProgram, dumpPath],
        input: "stdin" as const,
        output: "jsonl" as const,
        jsonlDialect: "claude-stream-json" as const,
        sessionMode: "none" as const,
        systemPromptWhen: "never" as const,
      },
    };
    cliBackendsTesting.setDepsForTest({
      resolvePluginSetupCliBackend: ({ backend: id }) =>
        id === backend.id ? { pluginId: backend.pluginId, backend } : undefined,
      resolveRuntimeCliBackends: () => [backend],
    });
  }

  function runRealCliRunnerForOnce() {
    state.runCliAgentMock.mockImplementationOnce(async (params: RunCliAgentParams) => {
      return await (
        await loadActualRunCliAgentForTest()
      )(params);
    });
  }

  function useClaudeCliFallback() {
    state.isCliProviderMock.mockReturnValue(true);
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
      result: await params.run("claude-cli", claudeCliModel, initialFallbackAttemptOptions(params)),
      provider: "claude-cli",
      model: claudeCliModel,
      attempts: [],
    }));
  }

  function createClaudeCliFollowupRun() {
    const followupRun = createFollowupRun();
    followupRun.run.agentId = "agent";
    followupRun.run.provider = "claude-cli";
    followupRun.run.model = claudeCliModel;
    followupRun.run.skillsSnapshot = { prompt: "", skills: [], version: 0 };
    followupRun.run.timeoutMs = 10_000;
    return followupRun;
  }

  async function readChildDump(): Promise<ChildCredentialDump> {
    const raw = await readFile(dumpPath, "utf8");
    const lines = raw.split("\n").filter((line) => line.trim());
    expect(lines).toHaveLength(1);
    return JSON.parse(lines[0] ?? "") as ChildCredentialDump;
  }

  it("spawns the claude child with no forwarded credential for a model-provider auto pin", async () => {
    registerScriptedClaudeCliBackend();
    runRealCliRunnerForOnce();
    await seedAuthProfile("anthropic:default", {
      type: "api_key",
      provider: "anthropic",
      key: "test-anthropic-key",
    });
    useClaudeCliFallback();

    const followupRun = createClaudeCliFollowupRun();
    followupRun.run.authProfileId = "anthropic:default";
    followupRun.run.authProfileIdSource = "auto";
    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const result = await executeAgentTurn(
      createMinimalRunAgentTurnParams({
        followupRun,
        sessionCtx: { Provider: "telegram", MessageSid: "msg" } as unknown as TemplateContext,
      }),
    );

    expect(result.kind).toBe("success");
    if (result.kind === "success") {
      expect(result.runResult.payloads).toEqual([{ text: "Scripted final answer." }]);
    }
    // The dispatch boundary dropped the model-provider pin, so the claude child
    // keeps its own native login instead of silently billing the stored key.
    const dump = await readChildDump();
    expect(dump.forwardsApiKeyDescriptor).toBe(false);
    expect(dump.credentialEnvKeys).toEqual([]);
  }, 60_000);

  it("drops a model-provider auto pin at the reply dispatch before the child runs", async () => {
    registerScriptedClaudeCliBackend();
    state.runCliAgentMock.mockResolvedValueOnce({ payloads: [{ text: "done" }], meta: {} });
    await seedAuthProfile("anthropic:default", {
      type: "api_key",
      provider: "anthropic",
      key: "test-anthropic-key",
    });
    useClaudeCliFallback();

    const followupRun = createClaudeCliFollowupRun();
    followupRun.run.authProfileId = "anthropic:default";
    followupRun.run.authProfileIdSource = "auto";
    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const result = await executeAgentTurn(
      createMinimalRunAgentTurnParams({
        followupRun,
        sessionCtx: { Provider: "telegram", MessageSid: "msg" } as unknown as TemplateContext,
      }),
    );

    expect(result.kind).toBe("success");
    const forwarded = requireMockCall(
      state.runCliAgentMock,
      0,
      "CLI run params",
    )[0] as RunCliAgentParams;
    expect(forwarded.authProfileId).toBeUndefined();
  }, 60_000);

  it("forwards a backend-owned profile through the reply dispatch for the child handoff", async () => {
    registerScriptedClaudeCliBackend();
    state.runCliAgentMock.mockResolvedValueOnce({ payloads: [{ text: "done" }], meta: {} });
    await seedAuthProfile("claude-cli:work", {
      type: "api_key",
      provider: "claude-cli",
      key: "test-claude-key",
    });
    useClaudeCliFallback();

    const followupRun = createClaudeCliFollowupRun();
    followupRun.run.authProfileId = "claude-cli:work";
    followupRun.run.authProfileIdSource = "auto";
    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const result = await executeAgentTurn(
      createMinimalRunAgentTurnParams({
        followupRun,
        sessionCtx: { Provider: "telegram", MessageSid: "msg" } as unknown as TemplateContext,
      }),
    );

    expect(result.kind).toBe("success");
    const forwarded = requireMockCall(
      state.runCliAgentMock,
      0,
      "CLI run params",
    )[0] as RunCliAgentParams;
    expect(forwarded.authProfileId).toBe("claude-cli:work");
  }, 60_000);
});
