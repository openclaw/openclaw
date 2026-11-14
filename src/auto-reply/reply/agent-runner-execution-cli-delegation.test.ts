import { afterEach, beforeEach, expect, it } from "vitest";
import { buildCliMcpGrantContext } from "../../agents/cli-runner/mcp-grant-context.js";
import type { RunCliAgentParams } from "../../agents/cli-runner/types.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import {
  createFollowupRun,
  createMinimalRunAgentTurnParams,
  fallbackAttemptOptions,
  getExecuteAgentTurnForTest,
  initialFallbackAttemptOptions,
  requireMockCall,
  setupAgentRunnerExecutionTestState,
  runFallbackCandidate,
} from "./agent-runner-execution.test-support.js";
import type { FallbackRunnerParams } from "./agent-runner-execution.test-support.js";

const state = await setupAgentRunnerExecutionTestState();

beforeEach(() => {
  state.isCliProviderMock.mockImplementation((provider) => provider === "codex-cli");
  state.runCliAgentMock.mockResolvedValue({ payloads: [{ text: "done" }], meta: {} });
  // WhatsApp has no buildToolContext adapter; preserve its default threading path.
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "whatsapp",
        plugin: createChannelTestPluginBase({ id: "whatsapp" }),
        source: "test",
      },
    ]),
  );
});
afterEach(resetPluginRuntimeStateForTest);

async function expectCliGrant(capability: "report_only" | undefined, primary = false) {
  const followupRun = createFollowupRun({
    ...(primary ? { provider: "codex-cli", model: "gpt-5.4" } : {}),
    inputProvenance: { kind: "inter_session", sourceTool: "subagent_announce" },
  });
  const executeAgentTurn = await getExecuteAgentTurnForTest();
  expect((await executeAgentTurn(createMinimalRunAgentTurnParams({ followupRun }))).kind).toBe(
    "success",
  );
  const run = requireMockCall(state.runCliAgentMock, 0, "CLI run params")[0] as RunCliAgentParams;
  expect(
    buildCliMcpGrantContext({
      run,
      config: run.config ?? {},
      requireExplicitMessageTarget: false,
      agentId: "main",
      modelProvider: "openai",
      modelId: "gpt-5.4",
    }).delegationCapability,
  ).toBe(capability);
}

it("keeps primary CLI completion grants unrestricted", async () => {
  state.isCliProviderMock.mockReturnValue(true);
  state.runWithModelFallbackMock.mockImplementationOnce((params: FallbackRunnerParams) =>
    runFallbackCandidate(params, "codex-cli", "gpt-5.4"),
  );
  await expectCliGrant(undefined, true);
});

it("restricts fallback CLI completion grants", async () => {
  state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => {
    await params.run("anthropic", "claude", initialFallbackAttemptOptions(params));
    return {
      result: await params.run("codex-cli", "gpt-5.4", fallbackAttemptOptions(params, "unknown")),
      provider: "codex-cli",
      model: "gpt-5.4",
      attempts: [{ provider: "anthropic", model: "claude", error: "rate limit" }],
    };
  });
  state.runEmbeddedAgentMock.mockResolvedValue({ payloads: [], meta: {} });
  await expectCliGrant("report_only");
});

it("restricts a sticky rate-limit fallback CLI completion grant that runs first", async () => {
  state.runWithModelFallbackMock.mockImplementationOnce((params: FallbackRunnerParams) =>
    runFallbackCandidate(
      params,
      "codex-cli",
      "gpt-5.4",
      fallbackAttemptOptions(params, "rate_limit"),
    ),
  );
  await expectCliGrant("report_only");
});
