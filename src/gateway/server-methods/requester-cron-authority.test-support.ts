import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  createOperationalRunInstanceRef,
  getAdmittedRunDelegatedAuthority,
  prepareAgentRunAdmission,
  resolveAdmittedRunActiveAssertion,
  type AdmittedRunContext,
} from "../../agents/admitted-run-context.js";
import { createOpenClawCodingTools } from "../../agents/agent-tools.js";
import {
  buildCliMcpGrantContext,
  finalizeCliMcpGrant,
} from "../../agents/cli-runner/mcp-grant-context.js";
import {
  createCronCreatorAuthorityCapability,
  runWithCronCreatorAuthorityCapability,
  type CronCreatorAuthorityCapability,
} from "../../agents/cron-creator-authority-context.js";
import { withPreparedEmbeddedGatewayTools } from "../../agents/embedded-agent-runner/run/attempt-gateway-tools.js";
import { revokeRequesterCronAuthority } from "../../agents/subagents/requester-cron-authority.js";
import {
  captureFinalEffectiveCronCreatorToolAllowlist,
  type CronCreatorToolAllowlistEntry,
  type CronToolsAllowCaptureRef,
} from "../../agents/tools/cron-tool.js";
import {
  getGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../../agents/tools/gateway-caller-context.js";
import {
  clearRuntimeConfigSnapshot,
  getRuntimeConfig,
  setRuntimeConfigSnapshot,
} from "../../config/config.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { CronService } from "../../cron/service.js";
import { createNoopLogger } from "../../cron/service.test-harness.js";
import { loadCronStore } from "../../cron/store.js";
import { clearAgentRunContext, registerAgentRunContext } from "../../infra/agent-run-registry.js";
import { getPluginToolMeta } from "../../plugins/tool-metadata.js";
import { trackAsyncWork } from "../../shared/async-work-scope.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../agent-runtime-approval-authority.js";
import type { AgentRuntimeIdentity } from "../agent-runtime-identity-token.js";
import {
  activateMcpLoopbackClientGrantCapture,
  mintMcpLoopbackClientGrant,
  revokeMcpLoopbackClientGrant,
} from "../mcp-grant-store.js";
import { getActiveMcpLoopbackRuntime } from "../mcp-http.loopback-runtime.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { createRequestGatewayMethodRegistry } from "../server-methods.js";
import {
  resolveGatewayCronCreatorAuthorityAdmission,
  type GatewayCronCreatorAuthorityAdmission,
} from "./cron-creator-authority-admission.js";
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
    setRuntimeConfigSnapshot(cfg);
    replaceSessionEntrySync(
      { sessionKey: SESSION },
      { sessionId: SESSION_ID, updatedAt: 1, lifecycleRevision: "original", createdActor: CREATOR },
    );
  });

  afterEach(async () => {
    cron?.stop();
    revokeRequesterCronAuthority(SESSION);
    await cleanupSessionStateForTest({ stateDir });
    clearRuntimeConfigSnapshot();
    vi.unstubAllEnvs();
  });
}

export function admission(
  runId: string,
  client: GatewayClient,
  childSessionKey?: string,
  isCurrent?: () => boolean,
) {
  return resolveGatewayCronCreatorAuthorityAdmission({
    runId,
    resolvedSessionKey: SESSION,
    sessionId: SESSION_ID,
    client,
    isCurrent,
    request: { message: "Update the maintenance automation", idempotencyKey: runId },
    ...(childSessionKey
      ? {
          inputProvenance: {
            kind: "inter_session" as const,
            sourceTool: "subagent_settle",
            sourceSessionKey: childSessionKey,
          },
        }
      : {}),
    hasRestoredCronContinuation: false,
    isOneShotModelRun: false,
    isRestartRecoveryResumeRun: false,
  });
}

export type RequesterRun<T> = (
  identity: AgentRuntimeIdentity,
  admittedRun: AdmittedRunContext,
  creator?: CronCreatorAuthorityCapability,
) => Promise<T>;

export async function inRun<T>(
  runId: string,
  admitted: GatewayCronCreatorAuthorityAdmission | undefined,
  run: RequesterRun<T>,
) {
  const runAdmission = prepareAgentRunAdmission({
    cfg: getRuntimeConfig(),
    operationalRunInstance: createOperationalRunInstanceRef(runId),
    facts: {
      runId,
      agentId: "main",
      ingress: { kind: "system", boundary: "requester-cron-test", state: "present" },
    },
  });
  try {
    const admittedRun = await runAdmission.admit("gateway", runId);
    const { operationalRunInstance } = admittedRun;
    const authority = expectDefined(getAdmittedRunDelegatedAuthority(admittedRun), "admitted run");
    registerAgentRunContext(runId, { agentId: "main", sessionKey: SESSION, sessionId: SESSION_ID });
    const identity: AgentRuntimeIdentity = {
      kind: "agentRuntime",
      agentId: "main",
      sessionKey: SESSION,
      operationalRunInstance,
      delegatedAuthority: { kind: "local", ...authority },
    };
    const execute = (creator?: CronCreatorAuthorityCapability) =>
      withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey: SESSION,
          operationalRunInstance,
          approvalAuthority: authority,
        },
        () => run(identity, admittedRun, creator),
      );
    if (!admitted) {
      return await execute();
    }
    const capability = expectDefined(
      createCronCreatorAuthorityCapability(
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
    return await runWithCronCreatorAuthorityCapability(capability, () => execute(capability));
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
  admitted: AdmittedRunContext;
  creator?: CronCreatorAuthorityCapability;
  senderIsOwner: boolean;
}): Promise<CreatorTransportTools> {
  const { transport, config, admitted, creator, senderIsOwner } = params;
  const { runId } = admitted.operationalRunInstance;
  const toolsAllow = expectDefined(config.tools?.allow, "fixture tool allowlist");
  let sequence = 0;
  if (transport === "cli") {
    const runtime = expectDefined(getActiveMcpLoopbackRuntime(), "MCP runtime");
    const grant = mintMcpLoopbackClientGrant({
      ...expectDefined(
        finalizeCliMcpGrant(
          buildCliMcpGrantContext({
            run: {
              sessionKey: SESSION,
              sessionId: SESSION_ID,
              sessionFile: path.join(stateDir, "creator.jsonl"),
              runId,
              workspaceDir: stateDir,
              provider: "claude-cli",
              model: "creator-fixture",
              prompt: "Update an automation",
              timeoutMs: 30_000,
              agentAccountId: "default",
              cronCreatorCallerOrigin: creator?.callerOrigin,
              senderIsOwner,
            },
            config,
            agentId: "main",
            modelProvider: "anthropic",
            modelId: "creator-fixture",
            requireExplicitMessageTarget: true,
          }),
          toolsAllow,
          false,
          resolveAdmittedRunActiveAssertion(admitted),
        ),
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
      const response = await fetch(`http://127.0.0.1:${runtime.port}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${grant.token}`,
          "content-type": "application/json",
          "x-openclaw-cli-capture-key": mcpCapture.captureKey,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++sequence, method, params: rpcParams }),
        signal: AbortSignal.timeout(15_000),
      });
      const message = (await response.json()) as {
        error?: unknown;
        result?: {
          tools?: Array<{ name: string }>;
          isError?: boolean;
          content?: Array<{ text?: string }>;
        };
      };
      expect(response.status).toBe(200);
      expect(message.error).toBeUndefined();
      if (message.result?.isError) {
        throw new Error(message.result.content?.map((item) => item.text).join("\n"));
      }
      return message.result;
    };
    try {
      expect(activateMcpLoopbackClientGrantCapture(mcpCapture)).not.toBe(false);
      expect((await rpc("tools/list"))?.tools).toEqual(
        expect.arrayContaining(toolsAllow.map((name) => expect.objectContaining({ name }))),
      );
      return {
        invoke: (name, args) => rpc("tools/call", { name, arguments: args }),
        mcpCapture,
      };
    } catch (error) {
      revokeMcpLoopbackClientGrant(grant.token);
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
        sessionKey: SESSION,
        sessionId: SESSION_ID,
        agentHarnessId: "openclaw",
      },
      () => getAdmittedRunDelegatedAuthority(admitted) !== undefined,
      async () => getGatewayToolCallerIdentity(),
    ),
    "embedded Gateway caller",
  );
  const creatorTools: CronCreatorToolAllowlistEntry[] = [];
  const creatorCapture: CronToolsAllowCaptureRef = {};
  const tools = await withGatewayToolCallerIdentity(callerIdentity, () =>
    createOpenClawCodingTools({
      config,
      agentId: "main",
      sessionKey: SESSION,
      sessionId: SESSION_ID,
      runId,
      workspaceDir: stateDir,
      agentAccountId: "default",
      senderIsOwner,
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
  captureFinalEffectiveCronCreatorToolAllowlist(
    creatorTools,
    creatorCapture,
    tools,
    getPluginToolMeta,
  );
  expect(tools).toEqual(
    expect.arrayContaining(toolsAllow.map((name) => expect.objectContaining({ name }))),
  );
  return {
    invoke: (name, args) => {
      const tool = expectDefined(
        tools.find((entry) => entry.name === name),
        `embedded ${name} tool`,
      );
      return withGatewayToolCallerIdentity(callerIdentity, () =>
        tool.execute(`creator-${++sequence}`, args),
      );
    },
  };
}
