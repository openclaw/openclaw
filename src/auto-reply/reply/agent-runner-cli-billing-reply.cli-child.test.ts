// Proves the billing reply copy end to end: a real CLI backend run fails with
// a billing error, and the user-visible reply must describe the credential the
// run actually used. A subscription-backed (oauth) CLI profile must render the
// subscription wording, while an API-key profile keeps the API-key wording.
// The candidate chain is pinned to claude-cli; the CLI process, settlement,
// failover error, and reply rendering are the real implementations.
import { mkdirSync } from "node:fs";
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
  loadActualRunCliAgentForTest,
} from "./agent-runner-execution.test-support.js";
import type { FallbackRunnerParams } from "./agent-runner-execution.test-support.js";

const state = await setupAgentRunnerExecutionTestState();

// A claude CLI whose run ends in the real failure shape: a stream-json result
// record marked is_error carrying a billing refusal.
const billingFailureCliProgram = String.raw`
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  if (!input.trim()) process.exit(2);
  const events = [
    {
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      result: "Credit balance is too low",
    },
  ];
  process.stdout.write(events.map((event) => JSON.stringify(event)).join("\n") + "\n");
});
`;

const claudeCliModel = "claude-opus-4-6";

describe("executeAgentTurn: CLI billing failure reply copy", () => {
  let stateDir: string;
  let agentDir: string;

  beforeEach(() => {
    stateDir = useAutoCleanupTempDirTracker(onTestFinished).make("openclaw-cli-billing-reply-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    agentDir = resolveAgentDir({}, "agent");
    mkdirSync(agentDir, { recursive: true });
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

  function registerBillingFailureClaudeCliBackend() {
    // The stub backend keeps the core one-shot JSONL transport so the run
    // exercises the real CLI process execution and settlement path.
    const backend = {
      id: "claude-cli",
      modelProvider: "anthropic",
      pluginId: "anthropic",
      bundleMcp: false,
      config: {
        command: process.execPath,
        args: ["-e", billingFailureCliProgram],
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

  async function runTurnAndReadFailureReplyText(): Promise<string> {
    registerBillingFailureClaudeCliBackend();
    runRealCliRunnerForOnce();
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
    expect(result.kind).toBe("final");
    if (result.kind !== "final") {
      throw new Error("expected the failed turn to settle into a final failure reply");
    }
    const text = result.payload.text;
    expect(text, "final failure reply should carry text").toBeTruthy();
    return text ?? "";
  }

  it("reports subscription billing copy when a subscription-backed CLI run fails billing", async () => {
    await seedAuthProfile("claude-cli:work", {
      type: "oauth",
      provider: "claude-cli",
      access: "stub-access-token",
      refresh: "stub-refresh-token",
      expires: Date.now() + 3_600_000,
    });

    const replyText = await runTurnAndReadFailureReplyText();

    expect(replyText).toContain("check your account for subscription or usage limits");
    expect(replyText).toContain(`claude-cli (${claudeCliModel})`);
    expect(replyText).not.toContain("API key has run out of credits");
  }, 60_000);

  it("keeps the API-key billing copy for an API-key-backed CLI run", async () => {
    await seedAuthProfile("claude-cli:work", {
      type: "api_key",
      provider: "claude-cli",
      key: "test-claude-key",
    });

    const replyText = await runTurnAndReadFailureReplyText();

    expect(replyText).toContain("API key has run out of credits");
    expect(replyText).not.toContain("check your account for subscription or usage limits");
  }, 60_000);
});
