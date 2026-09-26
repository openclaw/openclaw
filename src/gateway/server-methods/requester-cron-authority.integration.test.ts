import { readFile } from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../../test/helpers/promise.js";
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
  bindCronManagementGrant,
  createCronCreatorAuthorityCapability,
  runWithCronCreatorAuthorityCapability,
  type CronCreatorAuthorityCapability,
} from "../../agents/cron-creator-authority-context.js";
import { withPreparedEmbeddedGatewayTools } from "../../agents/embedded-agent-runner/run/attempt-gateway-tools.js";
import * as hostFileWrite from "../../agents/host-file-write.js";
import { makeSettledChild } from "../../agents/subagents/announce/subagent-announce.requester-settle-wake.test-support.js";
import {
  markRequesterTurnYieldedInRuns,
  settleRequesterTurnAfterSessionSpawns,
} from "../../agents/subagents/registry/subagent-registry-requester-yield.js";
import { saveSubagentRegistryChangesToSqlite } from "../../agents/subagents/registry/subagent-registry.store.sqlite.js";
import {
  revokeRequesterCronAuthority,
  withRequesterCronAuthority,
} from "../../agents/subagents/requester-cron-authority.js";
import { AUTOMATIONS_TOOL_NAME } from "../../agents/tools/automations-tool-name.js";
import {
  captureFinalEffectiveCronCreatorToolAllowlist,
  type CronCreatorToolAllowlistEntry,
  type CronToolsAllowCaptureRef,
} from "../../agents/tools/cron-tool.js";
import {
  getGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../../agents/tools/gateway-caller-context.js";
import { isConfiguredCommandOwner } from "../../auto-reply/command-auth.js";
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
import {
  bindGatewayContextResolver,
  clearGatewayContextResolver,
} from "../../plugins/runtime/gateway-request-scope.js";
import { getPluginToolMeta } from "../../plugins/tool-metadata.js";
import { trackAsyncWork } from "../../shared/async-work-scope.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../agent-runtime-approval-authority.js";
import type { AgentRuntimeIdentity } from "../agent-runtime-identity-token.js";
import { clientHasAdminScope } from "../agent-turn/agent-handler-helpers.js";
import {
  captureGatewayDeviceRevocation,
  invalidateGatewayDeviceRevocation,
} from "../device-revocation.js";
import {
  activateMcpLoopbackClientGrantCapture,
  deactivateMcpLoopbackClientGrantCapture,
  mintMcpLoopbackClientGrant,
  resolveMcpLoopbackClientGrant,
  revokeMcpLoopbackClientGrant,
} from "../mcp-grant-store.js";
import { closeMcpLoopbackServer, ensureMcpLoopbackServer } from "../mcp-http.js";
import { getActiveMcpLoopbackRuntime } from "../mcp-http.loopback-runtime.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { createRequestGatewayMethodRegistry, handleGatewayRequest } from "../server-methods.js";
import { createSyntheticPluginRuntimeClient } from "../server-plugin-runtime-client.js";
import {
  resolveGatewayCronCreatorAuthorityAdmission,
  resolveGatewayChatCronCreatorAuthorityAdmission,
  type GatewayCronCreatorAuthorityAdmission,
} from "./cron-creator-authority-admission.js";
import type { GatewayClient, RespondFn } from "./types.js";

// Attached-node inventory is unrelated to these original-caller and Cron commit boundaries.
vi.mock("../../agents/node-exec-availability.js", () => ({
  loadNodeExecAvailability: async () => ({ cacheKey: "no-nodes", isAvailable: () => false }),
}));

const SESSION = "agent:main:control-ui";
const SESSION_ID = "requester-session";
const CREATOR = { type: "human", source: "profile", id: "fixture-operator" } as const;
const cfg = { agents: { entries: { main: {} } } };
let stateDir: string;
let cron: CronService;
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

function admission(
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

type RequesterRun<T> = (
  identity: AgentRuntimeIdentity,
  admittedRun: AdmittedRunContext,
  creator?: CronCreatorAuthorityCapability,
) => Promise<T>;

async function inRun<T>(
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

async function withSuccessor<T>(admin: boolean | "channel-owner", run: RequesterRun<T>) {
  const originalRunId = "original-requester";
  const child = makeSettledChild({
    runId: "settled-child",
    requesterAgentId: "main",
    requesterSessionKey: SESSION,
    requesterTurnRunId: originalRunId,
    requesterSettleWake: undefined,
    completion: { required: true, resultText: "Maintenance review complete" },
  });
  const batch = [child];
  const runs = new Map([[child.runId, child]]);
  const persistOrThrow = (...ids: string[]) => saveSubagentRegistryChangesToSqlite(runs, ids);
  const requester = createSyntheticPluginRuntimeClient({
    scopes: admin ? ["operator.admin"] : ["operator.write"],
  });
  // The authenticated connection boundary supplies these facts; no model or
  // child result may promote the ordinary continuation below.
  requester.internal = admin === true ? { controlUiAdmin: true } : {};
  const admitted =
    admin === "channel-owner"
      ? {
          runId: originalRunId,
          callerOrigin: { kind: "unknown" as const },
          managementEntitlement: {
            source: "channel-owner" as const,
            isCurrent: () =>
              isConfiguredCommandOwner(getRuntimeConfig(), {
                channel: "discord",
                senderId: "owner-1",
              }),
          },
        }
      : admission(originalRunId, requester);
  if (admin === "channel-owner") {
    setRuntimeConfigSnapshot({ ...cfg, commands: { ownerAllowFrom: ["discord:owner-1"] } });
  }
  await inRun(originalRunId, admitted, async () => {
    expect(
      markRequesterTurnYieldedInRuns({
        requesterSessionKey: SESSION,
        requesterAgentId: "main",
        requesterTurnRunId: originalRunId,
        runs,
        persistOrThrow,
      }),
    ).toBe(1);
  });
  expect(
    settleRequesterTurnAfterSessionSpawns({
      requesterSessionKey: SESSION,
      requesterAgentId: "main",
      requesterTurnRunId: originalRunId,
      requesterYielded: true,
      acceptedSessionSpawns: [
        {
          runId: child.runId,
          childSessionKey: child.childSessionKey,
          expectsCompletionMessage: true,
        },
      ],
      runs,
      persistOrThrow,
      schedule: () => {},
    }),
  ).toBe(true);
  const runId = "successor-requester";
  return await withRequesterCronAuthority(
    {
      requesterSessionKey: SESSION,
      requesterSessionId: SESSION_ID,
      requesterAgentId: "main",
      batch,
      rearmGeneration: child.requesterSettleWake?.rearmGeneration,
      runId,
      isCurrent: () => true,
    },
    () =>
      inRun(
        runId,
        admission(runId, createSyntheticPluginRuntimeClient(), child.childSessionKey),
        async (identity, admittedRun, creator) => {
          // Queue acceptance retires the committed outbox before tools finish.
          // Its fresh admitted run must now own management and revocation.
          expect(creator?.callerScopedCreation).toBeUndefined();
          if (admin) {
            const management = bindCronManagementGrant(runId);
            expect(management?.managementOnly).toBe(true);
            expect(() => management?.mint("cron.add")).toThrow("management-only");
          }
          runs.clear();
          persistOrThrow(child.runId);
          return await run(identity, admittedRun, creator);
        },
      ),
  );
}

function createCronFixture(
  listConfiguredChannels: () => Promise<string[]> = async () => [],
  config: OpenClawConfig = cfg,
) {
  const storePath = path.join(stateDir, "cron", "jobs.json");
  cron = new CronService({
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

async function createStoredJob(
  listConfiguredChannels: () => Promise<string[]> = async () => [],
  config: OpenClawConfig = cfg,
) {
  const { context, read } = createCronFixture(listConfiguredChannels, config);
  const job = await cron.add(
    {
      name: "Maintenance",
      enabled: false,
      schedule: { kind: "every", everyMs: 1_800_000 },
      sessionTarget: "isolated",
      agentId: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "Check service health" },
      delivery: { mode: "none" },
      owner: { agentId: "main", sessionKey: "agent:main:telegram:dm:42", accountId: "telegram" },
    },
    {
      scheduledToolPolicy: { version: 1, mode: "trusted" },
      captureRuntimeAuthority: () => ({
        version: 1,
        runtimeId: "codex",
        namespace: "codex.apps",
        payload: { apps: [{ id: "calendar" }] },
      }),
    },
  );
  const before = await read();
  const runtimeAuthority = before[0]!.runtimeAuthority;
  expect(runtimeAuthority).toBeDefined();
  return {
    context,
    before,
    read,
    runtimeAuthority,
    readRuntimeAuthority: async () => (await read())[0]!.runtimeAuthority,
    update: (identity: AgentRuntimeIdentity) => updateWithGrantFor("cron.update", identity),
    updateWithGrantFor,
  };

  async function updateWithGrantFor(grantMethod: string, identity: AgentRuntimeIdentity) {
    const management = bindCronManagementGrant(identity.operationalRunInstance.runId);
    // A configured channel owner's turn reaches the Gateway without operator.admin.
    const client = createSyntheticPluginRuntimeClient({ scopes: ["operator.write"] });
    client.internal!.agentRuntimeIdentity = {
      ...identity,
      cronManagementGrant: management?.mint(grantMethod),
    };
    const respond = vi.fn<RespondFn>();
    const params = {
      id: job.id,
      patch: {
        name: "Reviewed maintenance",
        enabled: true,
        schedule: { kind: "every", everyMs: 3_600_000 },
        payload: { kind: "agentTurn", message: "Reviewed health check" },
        delivery: { mode: "none" },
      },
    };
    // The router applies the method-scope fence before the cron handler redeems the grant.
    await handleGatewayRequest({
      req: { type: "req", id: "update", method: "cron.update", params },
      client,
      context,
      respond,
      isWebchatConnect: () => false,
    });
    return expectDefined(respond.mock.calls[0], "cron update response");
  }
}

type CreatorTransportTools = {
  invoke: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  mcpCapture?: { token: string; runtimeOwnerToken: string; captureKey: string };
};

async function createCreatorTransportTools(params: {
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

describe("original caller through Cron creator transports", () => {
  it("preserves ordinary restricted caller creation without management admission", async () => {
    const config: OpenClawConfig = { ...cfg, tools: { allow: [AUTOMATIONS_TOOL_NAME] } };
    setRuntimeConfigSnapshot(config);
    const fixture = createCronFixture(undefined, config);
    const client = createSyntheticPluginRuntimeClient({ scopes: ["operator.write"] });
    client.internal = {};
    expect(admission("restricted-creator", client)).toBeUndefined();
    await inRun("restricted-creator", undefined, async (_identity, admitted) => {
      bindGatewayContextResolver(admitted, () => fixture.context);
      try {
        const tools = await createCreatorTransportTools({
          transport: "embedded",
          config,
          admitted,
          // Tool access does not grant Gateway-wide management admission.
          senderIsOwner: true,
        });
        await tools.invoke(AUTOMATIONS_TOOL_NAME, {
          action: "add",
          job: {
            name: "Restricted caller job",
            schedule: { kind: "every", everyMs: 60_000 },
            sessionTarget: "current",
            payload: { kind: "agentTurn", message: "Check status", timeoutSeconds: 0 },
            delivery: { mode: "none" },
          },
        });
        expect(await fixture.read()).toMatchObject([
          {
            createdActor: CREATOR,
            owner: { agentId: "main", sessionKey: SESSION, accountId: "default" },
            scheduledToolPolicy: {
              mode: "account",
              ownerSessionKey: SESSION,
              ownerAccountId: "default",
            },
            payload: { toolsAllow: [AUTOMATIONS_TOOL_NAME], timeoutSeconds: 0 },
          },
        ]);
      } finally {
        clearGatewayContextResolver(admitted);
      }
    });
  });
  it.each([
    ["cli", "local"],
    ["embedded", "local"],
    ["embedded", "remote"],
    ["embedded", "remote-chat"],
  ] as const)(
    "fences a real %s %s creator mutation while its run remains admitted",
    { timeout: 30_000 },
    async (transport, origin) => {
      const config: OpenClawConfig = {
        ...cfg,
        agents: { ...cfg.agents, defaults: { workspace: stateDir } },
        tools: { allow: [AUTOMATIONS_TOOL_NAME] },
      };
      setRuntimeConfigSnapshot(config);
      const entered = createDeferred();
      const release = createDeferred();
      let hold = false;
      const fixture = createCronFixture(async () => {
        if (hold) {
          entered.resolve();
          await release.promise;
        }
        return [];
      }, config);
      const caller = captureGatewayDeviceRevocation(
        fixture.context,
        { deviceId: "creator-device", role: "operator" },
        () => true,
      );
      const client = createSyntheticPluginRuntimeClient({ scopes: ["operator.admin"] });
      client.internal = origin === "local" ? { isLocalClient: true } : { controlUiAdmin: true };
      const runId = `original-${transport}-creator`;
      const creatorAdmission = expectDefined(
        origin === "remote-chat"
          ? resolveGatewayChatCronCreatorAuthorityAdmission({
              runId,
              resolvedSessionKey: SESSION,
              client,
              isCurrent: caller.isCurrent,
              hasExplicitOrigin: false,
              hasRestoredCronContinuation: false,
              isIncognito: false,
              isReconnectResume: false,
              isSystemGenerated: false,
              turnKind: "main",
              isDirectExternalUser: true,
            })
          : admission(runId, client, undefined, caller.isCurrent),
        "fresh operator admission",
      );
      const creator = expectDefined(
        createCronCreatorAuthorityCapability(
          runId,
          creatorAdmission.callerOrigin,
          creatorAdmission.managementEntitlement,
          creatorAdmission.isCurrent,
          undefined,
          creatorAdmission.requesterOwner,
          creatorAdmission.callerScopedCreation,
        ),
        "creator capability",
      );
      // Keep execution live so revocation must travel through the original caller predicate.
      const runAdmission = prepareAgentRunAdmission({
        cfg: config,
        operationalRunInstance: createOperationalRunInstanceRef(runId),
        facts: {
          runId,
          agentId: "main",
          ingress: { kind: "system", boundary: "cron-creator-caller-test", state: "present" },
        },
      });
      let admittedRun: AdmittedRunContext | undefined;
      let transportTools: CreatorTransportTools | undefined;
      let pending: Promise<unknown> | undefined;
      try {
        const admitted = await runAdmission.admit("gateway", runId);
        admittedRun = admitted;
        const delegated = expectDefined(getAdmittedRunDelegatedAuthority(admitted), "admitted run");
        bindGatewayContextResolver(admitted, () => fixture.context);
        if (transport === "cli") {
          await ensureMcpLoopbackServer(0);
        }
        await runWithCronCreatorAuthorityCapability(creator, async () => {
          const tools = await createCreatorTransportTools({
            transport,
            config,
            admitted,
            creator,
            senderIsOwner: clientHasAdminScope(client),
          });
          transportTools = tools;
          const invoke = (name: string) =>
            tools.invoke(AUTOMATIONS_TOOL_NAME, {
              action: "add",
              job: {
                name,
                schedule: { kind: "every", everyMs: 60_000 },
                sessionTarget: "current",
                wakeMode: "next-heartbeat",
                payload: { kind: "agentTurn", message: "Check service health", timeoutSeconds: 0 },
                delivery: { mode: "none" },
              },
            });

          await invoke("Live creator");
          const before = await fixture.read();
          expect(before).toMatchObject([
            {
              name: "Live creator",
              createdActor: CREATOR,
              sessionKey: SESSION,
              sessionTarget: "current",
              payload: {
                kind: "agentTurn",
                timeoutSeconds: 0,
                toolsAllow: [AUTOMATIONS_TOOL_NAME],
                toolsAllowIsDefault: true,
              },
              owner: { agentId: "main", sessionKey: SESSION, accountId: "default" },
              scheduledToolPolicy: {
                mode: "account",
                ownerSessionKey: SESSION,
                ownerAccountId: "default",
              },
              toolsAllowProvenance: {
                source: "final-executable-surface",
                callerOrigin: { kind: origin === "local" ? "local" : "unknown" },
              },
            },
          ]);
          expect(before[0]?.runtimeAuthority).toBeUndefined();
          hold = true;
          pending = invoke("Revoked creator");
          const rejected = expect(pending).rejects.toThrow(/authority.*no longer active/i);
          void rejected.catch(() => undefined);
          try {
            await withTestTimeout(
              Promise.race([
                entered.promise,
                pending.then(() => {
                  throw new Error("Creator mutation returned before service validation");
                }),
              ]),
              10_000,
              "Creator mutation did not reach real Cron validation",
            );
            expect(await fixture.read()).toEqual(before);
            invalidateGatewayDeviceRevocation(fixture.context, "creator-device", "operator");
          } finally {
            release.resolve();
            await pending.catch(() => undefined);
          }
          await rejected;
          expect(getAdmittedRunDelegatedAuthority(admitted)).toBe(delegated);
          expect(creator.active).toBe(true);
          expect(creator.signal.aborted).toBe(false);
          expect(await fixture.read()).toEqual(before);
          if (tools.mcpCapture) {
            expect(deactivateMcpLoopbackClientGrantCapture(tools.mcpCapture)).toBe(true);
          }
        });
      } finally {
        release.resolve();
        await pending?.catch(() => undefined);
        if (transportTools?.mcpCapture) {
          revokeMcpLoopbackClientGrant(transportTools.mcpCapture.token);
        }
        try {
          if (transport === "cli") {
            await closeMcpLoopbackServer();
          }
        } finally {
          if (admittedRun) {
            clearGatewayContextResolver(admittedRun);
          }
          runAdmission.close();
          caller.release();
        }
      }
    },
  );
});

describe("requester continuation persisted automation management", () => {
  it("rejects creation through the ordinary tool after a real requester handoff", async () => {
    const config: OpenClawConfig = { ...cfg, tools: { allow: [AUTOMATIONS_TOOL_NAME] } };
    setRuntimeConfigSnapshot(config);
    const fixture = createCronFixture(undefined, config);
    await withSuccessor(true, async (_identity, admitted, creator) => {
      bindGatewayContextResolver(admitted, () => fixture.context);
      try {
        const tools = await createCreatorTransportTools({
          transport: "embedded",
          config,
          admitted,
          creator,
          senderIsOwner: true,
        });
        await expect(
          tools.invoke(AUTOMATIONS_TOOL_NAME, {
            action: "add",
            job: {
              name: "Must not be created",
              schedule: { kind: "every", everyMs: 60_000 },
              sessionTarget: "current",
              payload: { kind: "agentTurn", message: "Check status", timeoutSeconds: 0 },
              delivery: { mode: "none" },
            },
          }),
        ).rejects.toThrow("This turn can only list, get, update, run, or remove automations");
        expect(await fixture.read()).toEqual([]);
      } finally {
        clearGatewayContextResolver(admitted);
      }
    });
  });
  it.each(["cli", "embedded"] as const)(
    "preserves independent %s writes after requester Cron revocation",
    { timeout: 30_000 },
    async (transport) => {
      const config: OpenClawConfig = {
        ...cfg,
        agents: { ...cfg.agents, defaults: { workspace: stateDir } },
        tools: { allow: [AUTOMATIONS_TOOL_NAME, "write"], fs: { workspaceOnly: false } },
      };
      setRuntimeConfigSnapshot(config);
      const fixture = await createStoredJob(undefined, config);
      // The listener must not inherit the requester's Cron scope at construction.
      if (transport === "cli") {
        await ensureMcpLoopbackServer(0);
      }
      try {
        await withSuccessor(true, async (_identity, admitted, capability) => {
          const creator = expectDefined(capability, "requester continuation capability");
          const isCronCurrent = expectDefined(creator.isCurrent, "requester Cron currentness");
          const delegated = expectDefined(
            getAdmittedRunDelegatedAuthority(admitted),
            "admitted run",
          );
          const assertRunActive = expectDefined(
            resolveAdmittedRunActiveAssertion(admitted),
            "admitted run assertion",
          );
          bindGatewayContextResolver(admitted, () => fixture.context);
          let transportTools: CreatorTransportTools | undefined;
          try {
            const tools = await createCreatorTransportTools({
              transport,
              config,
              admitted,
              creator,
              senderIsOwner: true,
            });
            transportTools = tools;
            const mcpGrant = tools.mcpCapture
              ? expectDefined(resolveMcpLoopbackClientGrant(tools.mcpCapture), "live MCP grant")
              : undefined;
            expect(isCronCurrent()).toBe(true);
            const committedPath = path.join(stateDir, `committed-${transport}.txt`);
            const laterPath = path.join(stateDir, `continued-${transport}.txt`);
            const content = "Independent file work remains admitted.\n";
            const originalWriteHostFile = hostFileWrite.writeHostFile;
            let revokedAcrossWrite = false;
            const writeSpy = vi
              .spyOn(hostFileWrite, "writeHostFile")
              .mockImplementation(async (...args) => {
                await originalWriteHostFile(...args);
                if (args[0] === committedPath) {
                  // Retire only Cron management after the owned file has actually committed.
                  revokeRequesterCronAuthority(SESSION);
                  revokedAcrossWrite = true;
                }
              });
            try {
              let writeResult: unknown;
              let writeError: unknown;
              try {
                writeResult = await tools.invoke("write", { path: committedPath, content });
              } catch (error) {
                writeError = error;
              }
              expect(revokedAcrossWrite).toBe(true);
              expect(await readFile(committedPath, "utf8")).toBe(content);
              expect(writeError).toBeUndefined();
              expect(writeResult).toMatchObject({
                content: [{ type: "text", text: expect.stringContaining("Successfully wrote") }],
              });
              expect(isCronCurrent()).toBe(false);
              expect(getAdmittedRunDelegatedAuthority(admitted)).toBe(delegated);
              expect(assertRunActive).not.toThrow();
              expect(creator.active).toBe(true);
              expect(creator.signal.aborted).toBe(false);
              if (mcpGrant) {
                expect(mcpGrant.isCurrent()).toBe(true);
              }
              await expect(
                tools.invoke("write", { path: laterPath, content }),
              ).resolves.toMatchObject({
                content: [{ type: "text", text: expect.stringContaining("Successfully wrote") }],
              });
              expect(await readFile(laterPath, "utf8")).toBe(content);
              await expect(
                tools.invoke(AUTOMATIONS_TOOL_NAME, {
                  action: "update",
                  jobId: fixture.before[0]!.id,
                  job: { name: "Must not persist after requester revocation" },
                }),
              ).rejects.toThrow(/Automation (caller authority is no longer active|admin grant)/i);
              expect(await fixture.read()).toEqual(fixture.before);
            } finally {
              writeSpy.mockRestore();
            }
          } finally {
            if (transportTools?.mcpCapture) {
              revokeMcpLoopbackClientGrant(transportTools.mcpCapture.token);
            }
            clearGatewayContextResolver(admitted);
          }
        });
      } finally {
        if (transport === "cli") {
          await closeMcpLoopbackServer();
        }
      }
    },
  );

  it.each([true, false, "channel-owner"] as const)(
    "permits the stored mutation only for an admitted manager: %s",
    async (admin) => {
      const fixture = await createStoredJob();
      const [ok, result, error] = await withSuccessor(admin, fixture.update);
      expect(ok).toBe(Boolean(admin));
      if (admin) {
        expect(result).toMatchObject({ name: "Reviewed maintenance", enabled: true });
        expect(await fixture.read()).toMatchObject([
          {
            name: "Reviewed maintenance",
            enabled: true,
            scheduledToolPolicy: { version: 1, mode: "trusted" },
            owner: fixture.before[0]!.owner,
            schedule: { kind: "every", everyMs: 3_600_000 },
            payload: { kind: "agentTurn", message: "Reviewed health check" },
          },
        ]);
        expect(await fixture.readRuntimeAuthority()).toEqual(fixture.runtimeAuthority);
      } else {
        // Without a management grant the write-scoped turn stops at the method-scope fence.
        expect(error).toMatchObject({ message: "missing scope: operator.admin" });
        expect(await fixture.read()).toEqual(fixture.before);
      }
    },
  );

  it("does not admit an update with a grant bound to another management method", async () => {
    const fixture = await createStoredJob();
    const [ok, , error] = await withSuccessor("channel-owner", (identity) =>
      fixture.updateWithGrantFor("cron.remove", identity),
    );
    expect(ok).toBe(false);
    expect(error).toMatchObject({ message: "missing scope: operator.admin" });
    expect(await fixture.read()).toEqual(fixture.before);
  });

  it.each(["fresh user turn", "session reset", "global owner removal"])(
    "rejects %s revocation while the real update awaits validation",
    async (reason) => {
      const entered = createDeferred();
      const release = createDeferred();
      let hold = false;
      const fixture = await createStoredJob(async () => {
        if (hold) {
          entered.resolve();
          await release.promise;
        }
        return [];
      });
      hold = true;
      const update = withSuccessor(
        reason === "global owner removal" ? "channel-owner" : true,
        fixture.update,
      );
      try {
        await Promise.race([
          entered.promise,
          update.then(() => {
            throw new Error("Update returned before reaching service validation");
          }),
        ]);
        expect(await fixture.read()).toEqual(fixture.before);
        if (reason === "global owner removal") {
          setRuntimeConfigSnapshot(cfg);
        } else if (reason === "fresh user turn") {
          const requester = createSyntheticPluginRuntimeClient({ scopes: ["operator.write"] });
          requester.internal = {};
          admission("new-user-turn", requester);
        } else {
          replaceSessionEntrySync(
            { sessionKey: SESSION },
            { sessionId: SESSION_ID, updatedAt: 2, lifecycleRevision: "reset" },
          );
        }
      } finally {
        release.resolve();
        // Join the real mutation before teardown, without replacing an assertion failure.
        await update.catch(() => undefined);
      }
      const [ok, , error] = await update;
      expect(ok).toBe(false);
      expect(error).toMatchObject({
        code: "INVALID_REQUEST",
        message: expect.stringContaining("Automation admin grant"),
      });
      expect(await fixture.read()).toEqual(fixture.before);
    },
  );
});
