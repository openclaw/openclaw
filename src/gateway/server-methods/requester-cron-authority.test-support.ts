import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as runContext from "../../agents/admitted-run-context.js";
import { createOpenClawCodingTools } from "../../agents/agent-tools.js";
import * as cliGrants from "../../agents/cli-runner/mcp-grant-context.js";
import * as cronAuthority from "../../agents/cron-creator-authority-context.js";
import { withPreparedEmbeddedGatewayTools } from "../../agents/embedded-agent-runner/run/attempt-gateway-tools.js";
import { revokeRequesterCronAuthority } from "../../agents/subagents/requester-cron-authority.js";
import * as cronTools from "../../agents/tools/cron-tool.js";
import * as gatewayCaller from "../../agents/tools/gateway-caller-context.js";
import * as runtimeConfig from "../../config/config.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { CronService } from "../../cron/service.js";
import { createNoopLogger } from "../../cron/service.test-harness.js";
import { loadCronStore } from "../../cron/store.js";
import { clearAgentRunContext, registerAgentRunContext } from "../../infra/agent-run-registry.js";
import { getPluginToolMeta } from "../../plugins/tool-metadata.js";
import { trackAsyncWork } from "../../shared/async-work-scope.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db-lifecycle.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../agent-runtime-approval-authority.js";
import type { AgentRuntimeIdentity } from "../agent-runtime-identity-token.js";
import * as mcpGrants from "../mcp-grant-store.js";
import { json, prepareAdmission, request } from "../mcp-http-request.test-support.js";
import { getActiveMcpLoopbackRuntime } from "../mcp-http.loopback-runtime.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { createRequestGatewayMethodRegistry } from "../server-methods.js";
import * as cronAdmission from "./cron-creator-authority-admission.js";
import type { GatewayClient } from "./types.js";

export const SESSION = "agent:main:control-ui";
export const SESSION_ID = "requester-session";
export const CREATOR = { type: "human", source: "profile", id: "fixture-operator" } as const;
export const cfg = { agents: { entries: { main: {} } } };
export let stateDir: string;
export let cron: CronService;

export function installRequesterCronAuthorityTestHooks() {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  beforeEach(() => {
    stateDir = tempDirs.make("openclaw-requester-cron-authority-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    runtimeConfig.setRuntimeConfigSnapshot(cfg);
    replaceSessionEntrySync(
      { sessionKey: SESSION },
      { sessionId: SESSION_ID, updatedAt: 1, lifecycleRevision: "original", createdActor: CREATOR },
    );
  });

  afterEach(async () => {
    cron?.stop();
    await cron?.waitForIdle();
    revokeRequesterCronAuthority(SESSION);
    await cleanupSessionStateForTest({ stateDir });
    closeOpenClawAgentDatabasesForTest(stateDir);
    runtimeConfig.clearRuntimeConfigSnapshot();
    vi.unstubAllEnvs();
  });
}

export function admission(
  runId: string,
  client: GatewayClient,
  childSessionKey?: string,
  isCurrent?: () => boolean,
) {
  return cronAdmission.resolveGatewayCronCreatorAuthorityAdmission({
    runId,
    resolvedSessionKey: SESSION,
    sessionId: SESSION_ID,
    client,
    isCurrent,
    request: { message: "Update the maintenance automation", idempotencyKey: runId },
    inputProvenance: childSessionKey
      ? {
          kind: "inter_session",
          sourceTool: "subagent_settle",
          sourceSessionKey: childSessionKey,
        }
      : undefined,
    hasRestoredCronContinuation: false,
    isOneShotModelRun: false,
    isRestartRecoveryResumeRun: false,
  });
}

export type RequesterRun<T> = (
  identity: AgentRuntimeIdentity,
  admittedRun: runContext.AdmittedRunContext,
  creator?: cronAuthority.CronCreatorAuthorityCapability,
) => Promise<T>;

export async function inRun<T>(
  runId: string,
  admitted: cronAdmission.GatewayCronCreatorAuthorityAdmission | undefined,
  run: RequesterRun<T>,
  operatorAuthority?: runContext.AdmittedRunOperatorAuthority,
) {
  const runAdmission = prepareAdmission(runId, "requester-cron-test", {
    cfg: runtimeConfig.getRuntimeConfig(),
    operatorAuthority,
  });
  try {
    const admittedRun = await runAdmission.admit("gateway", runId);
    const { operationalRunInstance } = admittedRun;
    const authority = expectDefined(
      runContext.getAdmittedRunDelegatedAuthority(admittedRun),
      "admitted run",
    );
    registerAgentRunContext(runId, { agentId: "main", sessionKey: SESSION, sessionId: SESSION_ID });
    const caller = { agentId: "main", sessionKey: SESSION, operationalRunInstance };
    const identity: AgentRuntimeIdentity = {
      kind: "agentRuntime",
      ...caller,
      delegatedAuthority: { kind: "local", ...authority },
    };
    const execute = (creator?: cronAuthority.CronCreatorAuthorityCapability) =>
      gatewayCaller.withGatewayToolCallerIdentity({ ...caller, approvalAuthority: authority }, () =>
        run(identity, admittedRun, creator),
      );
    if (!admitted) {
      return await execute();
    }
    const capability = expectDefined(
      cronAuthority.createCronCreatorAuthorityCapability(
        runId,
        admitted.callerOrigin,
        admitted.managementEntitlement,
        admitted.isCurrent,
        undefined,
        admitted.requesterOwner,
        admitted.callerScopedCreation,
      ),
      "admitted cron capability",
    );
    admitted.bindRunScope?.(capability);
    return await cronAuthority.runWithCronCreatorAuthorityCapability(capability, () =>
      execute(capability),
    );
  } finally {
    runAdmission.close();
    clearAgentRunContext(runId);
  }
}

export function createCronFixture(
  listConfiguredChannels: () => Promise<string[]> = async () => [],
  config: OpenClawConfig = cfg,
) {
  const storePath = path.join(stateDir, "cron", "jobs.json");
  cron = new CronService({
    scheduler: createTestGatewayScheduler(),
    nowMs: () => Date.now(),
    storePath,
    cronEnabled: false,
    defaultAgentId: "main",
    log: createNoopLogger(),
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    listConfiguredChannels,
  });
  const context = createDirectChatContext({
    cron,
    cronStorePath: storePath,
    getRuntimeConfig: () => config,
    validateAgentRuntimeApprovalAuthority: createAgentRuntimeApprovalAuthorityValidator(),
    getGatewayMethodRegistry: () => createRequestGatewayMethodRegistry(),
    trackExecution: trackAsyncWork,
  });
  return { context, read: async () => (await loadCronStore(storePath)).jobs };
}

export type CreatorTransportTools = {
  invoke: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  mcpCapture?: { token: string; runtimeOwnerToken: string; captureKey: string };
};

export async function createCreatorTransportTools(params: {
  transport: "cli" | "embedded";
  config: OpenClawConfig;
  admitted: runContext.AdmittedRunContext;
  creator?: cronAuthority.CronCreatorAuthorityCapability;
  senderIsOwner: boolean;
  workspaceDir?: string;
}): Promise<CreatorTransportTools> {
  const { transport, config, admitted, creator, senderIsOwner } = params;
  const workspaceDir = params.workspaceDir ?? stateDir;
  const { runId } = admitted.operationalRunInstance;
  const toolsAllow = expectDefined(config.tools?.allow, "fixture tool allowlist");
  const session = { sessionKey: SESSION, sessionId: SESSION_ID };
  const toolContext = { ...session, runId, workspaceDir, agentAccountId: "default", senderIsOwner };
  const expectedTools = expect.arrayContaining(
    toolsAllow.map((name) => expect.objectContaining({ name })),
  );
  let sequence = 0;
  if (transport === "cli") {
    const runtime = expectDefined(getActiveMcpLoopbackRuntime(), "MCP runtime");
    const context = cliGrants.buildCliMcpGrantContext({
      run: {
        ...toolContext,
        sessionFile: path.join(workspaceDir, "creator.jsonl"),
        provider: "claude-cli",
        model: "creator-fixture",
        prompt: "Update an automation",
        timeoutMs: 30_000,
        cronCreatorCallerOrigin: creator?.callerOrigin,
      },
      config,
      agentId: "main",
      modelProvider: "anthropic",
      modelId: "creator-fixture",
      requireExplicitMessageTarget: true,
    });
    const grant = mcpGrants.mintMcpLoopbackClientGrant({
      ...expectDefined(
        cliGrants.finalizeCliMcpGrant(context, toolsAllow, false, {
          assertCurrent: runContext.resolveAdmittedRunActiveAssertion(admitted),
        }),
        "prepared CLI grant",
      ),
      runtimeOwnerToken: runtime.ownerToken,
      admittedRunContext: admitted,
    });
    const mcpCapture = {
      token: grant.token,
      runtimeOwnerToken: runtime.ownerToken,
      captureKey: `capture-${runId}`,
    };
    const rpc = async (method: string, rpcParams?: Record<string, unknown>) => {
      const response = await request(
        runtime,
        { jsonrpc: "2.0", id: ++sequence, method, params: rpcParams },
        {
          token: grant.token,
          captureKey: mcpCapture.captureKey,
          signal: AbortSignal.timeout(15_000),
        },
      );
      const message = (await json(response)) as {
        error?: unknown;
        result?: {
          tools?: Array<{ name: string }>;
          isError?: boolean;
          content?: Array<{ text?: string }>;
        };
      };
      expect(message.error).toBeUndefined();
      if (message.result?.isError) {
        throw new Error(message.result.content?.map((item) => item.text).join("\n"));
      }
      return message.result;
    };
    try {
      expect(mcpGrants.activateMcpLoopbackClientGrantCapture(mcpCapture)).not.toBe(false);
      expect((await rpc("tools/list"))?.tools).toEqual(expectedTools);
      return {
        invoke: (name, args) => rpc("tools/call", { name, arguments: args }),
        mcpCapture,
      };
    } catch (error) {
      mcpGrants.revokeMcpLoopbackClientGrant(grant.token);
      throw error;
    }
  }

  const callerIdentity = expectDefined(
    await withPreparedEmbeddedGatewayTools(
      {
        cronCreatorAuthorityCapability: creator,
        agentAccountId: "default",
        admittedRunContext: admitted,
        agentId: "main",
        ...session,
        agentHarnessId: "openclaw",
      },
      async () => gatewayCaller.getGatewayToolCallerIdentity(),
    ),
    "embedded Gateway caller",
  );
  const creatorTools: cronTools.CronCreatorToolAllowlistEntry[] = [];
  const creatorCapture: cronTools.CronToolsAllowCaptureRef = {};
  const tools = await gatewayCaller.withGatewayToolCallerIdentity(callerIdentity, () =>
    createOpenClawCodingTools({
      config,
      agentId: "main",
      ...toolContext,
      cronCreatorToolAllowlistRef: creatorTools,
      cronCreatorToolAllowlistCaptureRef: creatorCapture,
      toolConstructionPlan: {
        includeBaseCodingTools: toolsAllow.includes("write"),
        includeShellTools: false,
        includeChannelTools: false,
        includeOpenClawTools: true,
        includePluginTools: false,
      },
    }),
  );
  cronTools.captureFinalEffectiveCronCreatorToolAllowlist(
    creatorTools,
    creatorCapture,
    tools,
    getPluginToolMeta,
  );
  expect(tools).toEqual(expectedTools);
  return {
    invoke: (name, args) => {
      const tool = expectDefined(
        tools.find((entry) => entry.name === name),
        `embedded ${name} tool`,
      );
      return gatewayCaller.withGatewayToolCallerIdentity(callerIdentity, () =>
        tool.execute(`creator-${++sequence}`, args),
      );
    },
  };
}
