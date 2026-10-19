import path from "node:path";
import { vi } from "vitest";
import { createOpenClawCodingTools } from "../../agents/agent-tools.js";
import { persistAuthProfileBatch } from "../../agents/auth-profiles/upsert-with-lock.js";
import type { RunEmbeddedAgentParams } from "../../agents/embedded-agent-runner/run/params.js";
import { createEmbeddedAgentRunnerOpenAiConfig } from "../../agents/test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { setRuntimeConfigSnapshot } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  cfg,
  stateDir,
} from "../../gateway/server-methods/requester-cron-authority.test-support.js";
import { resolveConfiguredModelRefMock } from "./run.test-harness.js";

export async function prepareAuthorityConfig(overrides: Partial<OpenClawConfig> = {}) {
  const { resolveAgentDir } = await import("./run.runtime.js");
  const agentDir = path.join(stateDir, "agents", "main", "agent");
  const config: OpenClawConfig = {
    ...cfg,
    models: createEmbeddedAgentRunnerOpenAiConfig(["gpt-4.1"]).models,
    agents: {
      defaults: { skipBootstrap: true, workspace: stateDir, model: "openai/gpt-4.1" },
      entries: { main: { agentDir, workspace: stateDir } },
    },
    auth: {
      profiles: { "openai:cron-fixture": { provider: "openai", mode: "api_key" } },
      order: { openai: ["openai:cron-fixture"] },
    },
    ...overrides,
  };
  setRuntimeConfigSnapshot(config);
  // Capture and execution must address the same canonical credential owner.
  vi.mocked(resolveAgentDir).mockReturnValue(agentDir);
  resolveConfiguredModelRefMock.mockReturnValue({ provider: "openai", model: "gpt-4.1" });
  await persistAuthProfileBatch({
    stateDir,
    profiles: [
      {
        profileId: "openai:cron-fixture",
        credential: { type: "api_key", provider: "openai", key: "gpt-4.1-key" },
      },
    ],
  });
  return config;
}

export function createAuthorityTools(
  params: RunEmbeddedAgentParams,
  overrides: Partial<NonNullable<Parameters<typeof createOpenClawCodingTools>[0]>>,
) {
  return createOpenClawCodingTools({
    config: params.config,
    agentId: "main",
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    runId: params.runId,
    workspaceDir: params.workspaceDir,
    cwd: params.cwd,
    runtimeToolAllowlist: params.toolsAllow,
    scheduledToolPolicy: params.scheduledToolPolicy,
    toolConstructionPlan: {
      includeBaseCodingTools: true,
      includeShellTools: false,
      includeChannelTools: false,
      includeOpenClawTools: false,
      includePluginTools: false,
    },
    ...overrides,
  });
}
