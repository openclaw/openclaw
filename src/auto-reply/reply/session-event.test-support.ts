import { expectDefined } from "@openclaw/normalization-core/expect";
import type { TestContext } from "vitest";
import {
  applyEmbeddedAttemptToolsAllow,
  resolveEmbeddedAttemptToolConstructionPlan,
} from "../../agents/embedded-agent-runner/run/attempt-tool-construction-plan.js";
import { buildEmbeddedAttemptToolRunContext } from "../../agents/embedded-agent-runner/run/attempt-tool-run-context.js";
import type { RunEmbeddedAgentParams } from "../../agents/embedded-agent-runner/run/params.js";
import type { AgentHarnessHostCapabilities } from "../../agents/harness/host-capability-types.js";
import type { resolveAttemptWorkspaceSandbox } from "../../agents/workspace-sandbox.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createReplyAgentDefaults } from "./get-reply-config.test-support.js";

export async function configureEventState(
  state: OpenClawTestState,
  overrides: Partial<OpenClawConfig> = {},
) {
  const config: OpenClawConfig = {
    agents: {
      entries: { main: { workspace: state.workspaceDir } },
      defaults: createReplyAgentDefaults(state.workspaceDir),
    },
    plugins: { enabled: false },
    skills: { load: { watch: false } },
    ...overrides,
  };
  setRuntimeConfigSnapshot(config);
  await state.writeConfig(config);
  openOpenClawStateDatabase();
  return config;
}

export async function startEmbeddedTurn(params: RunEmbeddedAgentParams, label: string) {
  const admission = expectDefined(params.preparedRunAdmission, label);
  const context = await admission.admit("gateway", params.runId);
  params.onExecutionPhase?.({ phase: "model_call_started" });
  await params.onExecutionStarted?.();
  await params.onAgentEvent?.({ stream: "lifecycle", data: { phase: "start" } });
  return context;
}

export function runEventFixture(
  label: string,
  onTestFinished: TestContext["onTestFinished"],
  run: (state: OpenClawTestState) => Promise<void>,
) {
  const work = withOpenClawTestState({ label, env: { OPENCLAW_TEST_FAST: "0" } }, run);
  // Cancellation must settle the state owner even when the test body times out.
  onTestFinished(async () => {
    await Promise.allSettled([work]);
  });
  return work;
}

export function createEventManagedTools(
  params: RunEmbeddedAgentParams,
  workspace: Awaited<ReturnType<typeof resolveAttemptWorkspaceSandbox>>,
  createToolSurface: NonNullable<AgentHarnessHostCapabilities["createToolSurface"]>,
  options: { includeOpenClawTools?: boolean } = {},
) {
  const toolRunContext = buildEmbeddedAttemptToolRunContext({
    ...params,
    model:
      params.provider && params.model ? { provider: params.provider, id: params.model } : undefined,
  });
  const construction = resolveEmbeddedAttemptToolConstructionPlan({
    toolsAllow: toolRunContext.runtimeToolAllowlist,
  });
  return applyEmbeddedAttemptToolsAllow(
    createToolSurface({
      ...toolRunContext,
      config: params.config,
      agentId: params.agentId,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      workspaceDir: workspace.effectiveWorkspace,
      cwd: workspace.effectiveCwd,
      sessionPermissionPolicy: workspace.sessionPermissionPolicy,
      toolConstructionPlan: {
        ...construction.codingToolConstructionPlan,
        includeShellTools: false,
        includeChannelTools: false,
        includeOpenClawTools: options.includeOpenClawTools === true,
        includePluginTools: false,
      },
    }),
    construction.runtimeToolAllowlist,
  );
}
