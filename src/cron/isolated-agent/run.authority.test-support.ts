import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { vi } from "vitest";
import { createOpenClawCodingTools } from "../../agents/agent-tools.js";
import { persistAuthProfileBatch } from "../../agents/auth-profiles/upsert-with-lock.js";
import type { RunEmbeddedAgentParams } from "../../agents/embedded-agent-runner/run/params.js";
import { createEmbeddedAgentRunnerOpenAiConfig } from "../../agents/test-helpers/embedded-agent-runner-e2e-fixtures.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../../agents/tools/gateway-caller-context.js";
import { setRuntimeConfigSnapshot } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { stateDir } from "../../gateway/server-methods/requester-cron-authority.test-support.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { CronService } from "../service.js";
import { createNoopLogger } from "../service.test-harness.js";
import { runCronSessionTurn } from "../session-run.js";
import { resolveCronSessionTargetSessionKey } from "../session-target.js";
import * as harness from "./run.test-harness.js";

export function resetAuthorityRunHarness() {
  harness.resetRunCronIsolatedAgentTurnHarness();
  vi.stubEnv("OPENCLAW_TEST_FAST", "1");
  harness.ensureAgentWorkspaceMock.mockImplementation(async ({ dir }: { dir: string }) => ({
    dir,
  }));
  harness.resolveCronDeliveryPlanMock.mockReturnValue({ requested: false, mode: "none" });
  harness.mockRunCronFallbackPassthrough();
}

export async function prepareAuthorityConfig(overrides: Partial<OpenClawConfig> = {}) {
  const { resolveAgentDir } = await import("./run.runtime.js");
  const agentDir = path.join(stateDir, "agents", "main", "agent");
  const config: OpenClawConfig = {
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
  harness.resolveConfiguredModelRefMock.mockReturnValue({ provider: "openai", model: "gpt-4.1" });
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

export async function withAuthorityTools<T>(
  params: RunEmbeddedAgentParams,
  run: (tools: ReturnType<typeof createOpenClawCodingTools>) => Promise<T>,
  options: Partial<NonNullable<Parameters<typeof createOpenClawCodingTools>[0]>> & {
    includeOpenClawTools?: boolean;
  } = {},
) {
  const { includeOpenClawTools = false, ...overrides } = options;
  const admitted = await expectDefined(params.preparedRunAdmission, "run admission").admit(
    "gateway",
    params.runId,
  );
  const caller = createAdmittedGatewayToolCallerIdentity({
    admittedRunContext: admitted,
    agentId: "main",
    sessionKey: overrides.sessionKey ?? params.sessionKey,
  });
  return withGatewayToolCallerIdentity(caller, () => {
    const tools = createOpenClawCodingTools({
      config: params.config,
      agentId: "main",
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
      runId: params.runId,
      operationalRunInstance: admitted.operationalRunInstance,
      workspaceDir: params.workspaceDir,
      cwd: params.cwd,
      runtimeToolAllowlist: params.toolsAllow,
      scheduledToolPolicy: params.scheduledToolPolicy,
      toolConstructionPlan: {
        includeBaseCodingTools: true,
        includeShellTools: false,
        includeChannelTools: false,
        includeOpenClawTools,
        includePluginTools: false,
      },
      ...overrides,
    });
    return run(tools);
  });
}

export function createAuthorityCronService(
  config: OpenClawConfig,
  runCron: Awaited<ReturnType<typeof harness.loadRunCronIsolatedAgentTurn>>,
  overrides: Partial<ConstructorParameters<typeof CronService>[0]> = {},
) {
  return new CronService({
    scheduler: createTestGatewayScheduler(),
    storePath: path.join(stateDir, "cron", "jobs.json"),
    cronEnabled: true,
    defaultAgentId: "main",
    log: createNoopLogger(),
    enqueueSystemEvent: vi.fn(),
    runSessionEvent: (request) =>
      runCronSessionTurn({
        ...request,
        cfg: config,
        agentId: "main",
        sessionKey: expectDefined(
          resolveCronSessionTargetSessionKey(request.job.sessionTarget),
          "explicit Cron session target",
        ),
      }),
    runIsolatedAgentJob: (request) =>
      runCron({
        ...request,
        cfg: config,
        deps: {},
        agentId: "main",
        sessionKey: `cron:${request.job.id}`,
      }),
    ...overrides,
  });
}
