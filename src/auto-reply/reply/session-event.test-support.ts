import { expectDefined } from "@openclaw/normalization-core/expect";
import type { TestContext } from "vitest";
import type { RunEmbeddedAgentParams } from "../../agents/embedded-agent-runner/run/params.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";

export async function configureEventState(
  state: OpenClawTestState,
  overrides: Partial<OpenClawConfig> = {},
) {
  const config: OpenClawConfig = {
    agents: {
      entries: { main: { workspace: state.workspaceDir } },
      defaults: {
        workspace: state.workspaceDir,
        skipBootstrap: true,
        model: { primary: "mock-openai/gpt-5.6-luna" },
        models: { "mock-openai/gpt-5.6-luna": { agentRuntime: { id: "openclaw" } } },
      },
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
