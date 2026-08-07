// Real Gateway proof for private run identity binding at approval creation.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { GATEWAY_CLIENT_CAPS } from "../../packages/gateway-protocol/src/client-info.js";
import { executionIdentity } from "../agents/agent-command-execution-identity.js";
import {
  createAgentExecutionAttribution,
  type AgentExecutionAttribution,
} from "../agents/agent-execution-attribution.js";
import { createApprovalAuthorityForAgentHarnessAttempt } from "../agents/agent-harness-approval-authority.js";
import { createOpenClawCodingToolsForRuntime } from "../agents/agent-tools-internal.js";
import type { PreparedAgentCommandExecution } from "../agents/command/prepare.js";
import { bindEmbeddedAttemptExecutionAttribution } from "../agents/embedded-agent-runner/run/attempt-execution-attribution.js";
import type { EmbeddedRunAttemptParams } from "../agents/embedded-agent-runner/run/types.js";
import {
  invokeNativeHookRelay,
  resolveNativeHookRelayDeferredToolApproval,
} from "../agents/harness/native-hook-relay.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { createGatewayToolCallerWrapper } from "../agents/tools/gateway-caller-context.js";
import { callGatewayTool } from "../agents/tools/gateway.js";
import { isExecutionIdentityCollectionEnabled } from "../audit/audit-config.js";
import {
  createExecutionIdentityAdmissionToken,
  getExecutionIdentityAdmissionScope,
} from "../audit/execution-identity-admission.js";
import { clearConfigCache } from "../config/config.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import { resetGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { loadAndActivateRootPluginRegistry } from "../plugins/loader.js";
import { resetPluginLoaderTestStateForTest } from "../plugins/loader.test-fixtures.js";
import { resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { APPROVALS_SCOPE } from "./method-scopes.js";
import { getOperatorApprovalDetailed } from "./operator-approval-store.js";
import { startGatewayServer } from "./server.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
  getFreeGatewayPort,
} from "./test-helpers.e2e.js";

const ENV_KEYS = [
  "HOME",
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_GATEWAY_PORT",
  "OPENCLAW_GATEWAY_TOKEN",
  "OPENCLAW_GATEWAY_PASSWORD",
  "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
];

const APPROVAL_PLUGIN_ID = "execution-identity-approval-e2e";
const APPROVAL_PLUGIN_TOOL_NAME = "execution_identity_approval_e2e";

type Cleanup = () => Promise<void> | void;

function prepared(params: {
  cfg: OpenClawConfig;
  runId: string;
  executionAttribution?: AgentExecutionAttribution;
}): PreparedAgentCommandExecution {
  return {
    cfg: params.cfg,
    runId: params.runId,
    opts: {
      message: "approval identity e2e",
      runId: params.runId,
      ...(params.executionAttribution ? { executionAttribution: params.executionAttribution } : {}),
    },
  } as PreparedAgentCommandExecution;
}

describe("execution identity approval Gateway e2e", () => {
  const cleanup: Cleanup[] = [];

  afterEach(async () => {
    for (const step of cleanup.splice(0).toReversed()) {
      await step();
    }
    closeOpenClawStateDatabaseForTest();
    resetGlobalHookRunner();
    resetPluginRuntimeStateForTest();
    resetPluginLoaderTestStateForTest();
    clearRuntimeConfigSnapshot();
    clearConfigCache();
  });

  it("binds only exact enabled local tool identity across restart and same-run reuse", async () => {
    const envSnapshot = captureEnv(ENV_KEYS);
    cleanup.push(() => envSnapshot.restore());
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-execution-approval-e2e-"));
    cleanup.push(() => fs.rm(home, { recursive: true, force: true, maxRetries: 5 }));
    const stateDir = path.join(home, ".openclaw");
    const configPath = path.join(home, "openclaw.json");
    await fs.mkdir(stateDir, { recursive: true });
    const pluginDir = path.join(home, "plugins", APPROVAL_PLUGIN_ID);
    const pluginEntry = path.join(pluginDir, "index.cjs");
    const readFixture = path.join(home, "approval-fixture.txt");
    await fs.mkdir(pluginDir, { recursive: true });
    await Promise.all([
      fs.writeFile(readFixture, "approval identity fixture\n", "utf8"),
      fs.writeFile(
        path.join(pluginDir, "openclaw.plugin.json"),
        JSON.stringify({
          id: APPROVAL_PLUGIN_ID,
          contracts: { tools: [APPROVAL_PLUGIN_TOOL_NAME] },
          configSchema: { type: "object", additionalProperties: false, properties: {} },
        }),
        "utf8",
      ),
      fs.writeFile(
        pluginEntry,
        `module.exports = {
  id: ${JSON.stringify(APPROVAL_PLUGIN_ID)},
  register(api) {
    api.registerTool({
      name: ${JSON.stringify(APPROVAL_PLUGIN_TOOL_NAME)},
      description: "Test-only plugin approval identity tool.",
      parameters: { type: "object", additionalProperties: false, properties: {} },
      async execute() {
        return { content: [{ type: "text", text: "approved" }] };
      },
    });
    api.on("before_tool_call", (event) => {
      if (event.toolName !== "read" && event.toolName !== "exec" && event.toolName !== ${JSON.stringify(APPROVAL_PLUGIN_TOOL_NAME)}) {
        return;
      }
      return {
        requireApproval: {
          title: "Approve identity E2E tool",
          description: "Exercise the durable plugin approval owner binding.",
          severity: "warning",
          timeoutMs: 60000,
          allowedDecisions: ["allow-once", "deny"],
        },
      };
    });
  },
};
`,
        "utf8",
      ),
    ]);

    const port = await getFreeGatewayPort();
    const gatewayToken = "execution-approval-e2e-token";
    const enabledConfig: OpenClawConfig = {
      gateway: { port, auth: { mode: "token", token: gatewayToken } },
      logging: { audit: { enabled: true, executionIdentity: true } },
      plugins: {
        enabled: true,
        allow: [APPROVAL_PLUGIN_ID],
        load: { paths: [pluginEntry] },
        entries: { [APPROVAL_PLUGIN_ID]: { enabled: true } },
        slots: { memory: "none" },
      },
    };
    await fs.writeFile(configPath, JSON.stringify(enabledConfig), "utf8");
    setTestEnvValue("HOME", home);
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    setTestEnvValue("OPENCLAW_CONFIG_PATH", configPath);
    setTestEnvValue("OPENCLAW_GATEWAY_PORT", String(port));
    setTestEnvValue("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
    setRuntimeConfigSnapshot(enabledConfig, enabledConfig);

    let server = await startGatewayServer(port, {
      bind: "loopback",
      auth: { mode: "token", token: gatewayToken },
      controlUiEnabled: false,
      sidecarStartup: "defer",
    });
    cleanup.push(async () => server.close());
    loadAndActivateRootPluginRegistry({
      cache: false,
      config: enabledConfig,
      env: process.env,
      workspaceDir: home,
    });
    const url = `ws://127.0.0.1:${port}`;
    const approvalIds = new Map<string, string>();
    const nativeApprovalIds: string[] = [];
    const nativeApprovalRequests: Array<{ pluginId: unknown; toolName: string }> = [];
    let collectNativeApprovals = false;
    const approvalResolutions: Promise<unknown>[] = [];
    const approvalDeviceIdentity = loadOrCreateDeviceIdentity({
      path: path.join(stateDir, "approval-resolver.sqlite"),
    });
    const resolveApprovalRequest = (id: string) =>
      approvalClient.request(
        "plugin.approval.resolve",
        { id, decision: "allow-once" },
        { timeoutMs: 30_000 },
      );
    const approvalClient = await connectGatewayClient({
      url,
      token: gatewayToken,
      clientDisplayName: "approval identity resolver",
      scopes: [APPROVALS_SCOPE],
      caps: [GATEWAY_CLIENT_CAPS.APPROVALS],
      deviceIdentity: approvalDeviceIdentity,
      timeoutMs: 60_000,
      onEvent: (event) => {
        if (event.event !== "plugin.approval.requested") {
          return;
        }
        const payload = event.payload as
          | { id?: unknown; request?: { pluginId?: unknown; toolName?: unknown } }
          | undefined;
        if (typeof payload?.id !== "string" || typeof payload.request?.toolName !== "string") {
          return;
        }
        const pluginId = payload.request.pluginId;
        if (pluginId !== APPROVAL_PLUGIN_ID && pluginId !== "openclaw-native-hook-relay-codex") {
          return;
        }
        approvalIds.set(payload.request.toolName, payload.id);
        if (collectNativeApprovals) {
          nativeApprovalIds.push(payload.id);
          nativeApprovalRequests.push({ pluginId, toolName: payload.request.toolName });
        }
        approvalResolutions.push(resolveApprovalRequest(payload.id));
      },
    });
    cleanup.push(async () => disconnectGatewayClient(approvalClient!));

    const requestFromComposedTool = async (params: {
      runId: string;
      toolName: string;
      includeCoreTools: boolean;
      toolParams: Record<string, unknown>;
    }) =>
      await executionIdentity.runPrepared({
        prepared: prepared({ cfg: enabledConfig, runId: params.runId }),
        run: async (scopedPrepared) => {
          const scope = getExecutionIdentityAdmissionScope();
          executionIdentity.record({
            agentId: "main",
            cfg: enabledConfig,
            ingress: executionIdentity.localIngress,
            runId: params.runId,
            runtimeKind: "embedded",
          });
          const tools = createOpenClawCodingToolsForRuntime({
            attribution: scopedPrepared.opts.executionAttribution,
            agentId: "main",
            sessionKey: "agent:main:main",
            runSessionKey: "agent:main:main",
            runId: params.runId,
            approvalReviewerDeviceId: approvalDeviceIdentity.deviceId,
            config: enabledConfig,
            cwd: home,
            workspaceDir: home,
            includeCoreTools: params.includeCoreTools,
            runtimeToolAllowlist: params.includeCoreTools ? undefined : [APPROVAL_PLUGIN_TOOL_NAME],
            toolConstructionPlan: {
              includeBaseCodingTools: params.includeCoreTools,
              includeShellTools: false,
              includeChannelTools: false,
              includeOpenClawTools: false,
              includePluginTools: !params.includeCoreTools,
            },
          });
          const tool = tools.find((candidate) => candidate.name === params.toolName);
          if (!tool?.execute) {
            throw new Error(`composed tool missing: ${params.toolName}`);
          }
          await tool.execute(`call-${params.runId}`, params.toolParams);
          return scope?.token;
        },
      });

    const coreToken = await requestFromComposedTool({
      runId: "composed-core-run",
      toolName: "read",
      includeCoreTools: true,
      toolParams: { path: readFixture },
    });
    const pluginToken = await requestFromComposedTool({
      runId: "composed-plugin-run",
      toolName: APPROVAL_PLUGIN_TOOL_NAME,
      includeCoreTools: false,
      toolParams: {},
    });
    await Promise.all(approvalResolutions);
    expect(coreToken).toBeDefined();
    expect(pluginToken).toBeDefined();
    expect(approvalIds.get("read")).toBeDefined();
    expect(approvalIds.get(APPROVAL_PLUGIN_TOOL_NAME)).toBeDefined();

    const nativeAttribution = createAgentExecutionAttribution({
      runId: "composed-plugin-run",
      lifecycleGeneration: "native-deferred-generation",
      agentId: "main",
      sessionKey: "agent:main:main",
      executionIdentityAdmission: { token: pluginToken!, retryOnly: true },
    });
    const nativeAttempt = {
      agentId: "main",
      sessionId: "native-deferred-session",
      sessionKey: "agent:main:main",
      config: enabledConfig,
    } as EmbeddedRunAttemptParams;
    bindEmbeddedAttemptExecutionAttribution(nativeAttempt, nativeAttribution);
    const nativeRelay = createApprovalAuthorityForAgentHarnessAttempt(
      nativeAttempt,
    ).registerNativeHookRelay({
      provider: "codex",
      sessionId: nativeAttempt.sessionId,
      sessionKey: nativeAttempt.sessionKey,
      agentId: nativeAttempt.agentId,
      runId: "composed-plugin-run",
      allowedEvents: ["pre_tool_use"],
      approvalContext: {
        approvalReviewerDeviceId: approvalDeviceIdentity.deviceId,
      },
    });
    collectNativeApprovals = true;
    try {
      await invokeNativeHookRelay({
        provider: "codex",
        relayId: nativeRelay.relayId,
        event: "pre_tool_use",
        rawPayload: {
          hook_event_name: "PreToolUse",
          openclaw_approval_mode: "report",
          tool_name: "exec_command",
          tool_use_id: "native-deferred",
          tool_input: { command: "printf deferred" },
        },
      });
      const deferredOutcome = await resolveNativeHookRelayDeferredToolApproval({
        relayId: nativeRelay.relayId,
        toolUseId: "native-deferred",
      });
      expect(deferredOutcome).toEqual({ handled: true, outcome: "approved-once" });
    } finally {
      nativeRelay.unregister();
    }
    collectNativeApprovals = false;
    await Promise.all(approvalResolutions);
    expect(nativeApprovalIds, JSON.stringify(nativeApprovalRequests)).toHaveLength(1);

    const requestFromRun = async (params: {
      id: string;
      preparedRunId: string;
      requestRunId: string;
      cfg: OpenClawConfig;
      executionAttribution?: AgentExecutionAttribution;
    }) =>
      await executionIdentity.runPrepared({
        prepared: prepared({
          cfg: params.cfg,
          runId: params.preparedRunId,
          executionAttribution: params.executionAttribution,
        }),
        run: async (scopedPrepared) => {
          const scope = getExecutionIdentityAdmissionScope();
          executionIdentity.record({
            agentId: "main",
            cfg: params.cfg,
            ingress: executionIdentity.localIngress,
            runId: params.preparedRunId,
            runtimeKind: "embedded",
          });
          const wrap = createGatewayToolCallerWrapper(
            "main",
            { agentSessionKey: "agent:main:main" },
            {
              attribution: scopedPrepared.opts.executionAttribution,
              executionIdentityEnabled: isExecutionIdentityCollectionEnabled(params.cfg),
            },
          );
          const tool = wrap({
            name: "approval_identity_e2e",
            label: "Approval identity E2E",
            description: "test-only approval request",
            parameters: Type.Object({}),
            execute: async () =>
              await callGatewayTool(
                "exec.approval.request",
                { timeoutMs: 30_000 },
                {
                  id: params.id,
                  command: "printf smoke",
                  cwd: "/tmp",
                  host: "local",
                  ask: "always",
                  runId: params.requestRunId,
                  twoPhase: true,
                  requireDeliveryRoute: false,
                  timeoutMs: 60_000,
                },
              ),
          } as AnyAgentTool);
          await tool.execute?.("approval-call", {});
          return {
            attribution: scopedPrepared.opts.executionAttribution,
            token: scope?.token,
            transported: scope !== undefined,
          };
        },
      });

    const first = await requestFromRun({
      id: "exact-first",
      preparedRunId: "shared-run",
      requestRunId: "shared-run",
      cfg: enabledConfig,
    });
    const second = await requestFromRun({
      id: "exact-second",
      preparedRunId: "shared-run",
      requestRunId: "shared-run",
      cfg: enabledConfig,
      executionAttribution: first.attribution,
    });
    expect(first.token).toBeDefined();
    expect(second.token).toBeDefined();
    expect(second.token).toEqual(first.token);

    const mismatch = await requestFromRun({
      id: "trusted-mismatch",
      preparedRunId: "token-run",
      requestRunId: "different-source-run",
      cfg: enabledConfig,
    });
    expect(mismatch.transported).toBe(true);

    const ordinary = await connectGatewayClient({
      url,
      token: gatewayToken,
      clientDisplayName: "ordinary approval requester",
      scopes: [APPROVALS_SCOPE],
      timeoutMs: 60_000,
    });
    await ordinary.request("exec.approval.request", {
      id: "ordinary-same-run",
      command: "printf ordinary",
      cwd: "/tmp",
      host: "local",
      ask: "always",
      runId: "shared-run",
      twoPhase: true,
      requireDeliveryRoute: false,
      timeoutMs: 60_000,
    });
    await disconnectGatewayClient(ordinary);

    const incidentalToken = createExecutionIdentityAdmissionToken("disabled-run", {
      contextId: "disabled-context",
      executionId: "disabled-execution",
      now: 123,
    });
    const disabledConfig: OpenClawConfig = {
      ...enabledConfig,
      logging: { audit: { enabled: true, executionIdentity: false } },
    };
    const disabledAttribution = createAgentExecutionAttribution({
      runId: "disabled-run",
      lifecycleGeneration: "disabled-generation",
      executionIdentityAdmission: { token: incidentalToken, retryOnly: true },
    });
    setRuntimeConfigSnapshot(disabledConfig, disabledConfig);
    const disabled = await requestFromRun({
      id: "disabled",
      preparedRunId: "disabled-run",
      requestRunId: "disabled-run",
      cfg: disabledConfig,
      executionAttribution: disabledAttribution,
    });
    expect(disabled).toEqual({
      attribution: disabledAttribution,
      token: undefined,
      transported: false,
    });

    await server.close();
    const databaseOptions = { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } };
    const owner = (id: string) => {
      const result = getOperatorApprovalDetailed({ id, databaseOptions });
      expect(result.outcome).toBe("found");
      return result.outcome === "found" ? result.record.source : undefined;
    };
    expect(owner("exact-first")).toMatchObject({
      runId: "shared-run",
      contextId: first.token?.contextId,
      executionId: first.token?.executionId,
    });
    expect(owner("exact-second")).toMatchObject({
      runId: "shared-run",
      contextId: second.token?.contextId,
      executionId: second.token?.executionId,
    });
    expect(owner("trusted-mismatch")).toMatchObject({
      runId: "different-source-run",
      contextId: null,
      executionId: null,
    });
    expect(owner("ordinary-same-run")).toMatchObject({
      runId: "shared-run",
      contextId: null,
      executionId: null,
    });
    expect(owner("disabled")).toMatchObject({
      runId: "disabled-run",
      contextId: null,
      executionId: null,
    });
    expect(owner(approvalIds.get("read")!)).toMatchObject({
      agentId: "main",
      sessionKey: "agent:main:main",
      runId: "composed-core-run",
      contextId: coreToken?.contextId,
      executionId: coreToken?.executionId,
    });
    expect(owner(approvalIds.get(APPROVAL_PLUGIN_TOOL_NAME)!)).toMatchObject({
      agentId: "main",
      sessionKey: "agent:main:main",
      runId: "composed-plugin-run",
      contextId: pluginToken?.contextId,
      executionId: pluginToken?.executionId,
    });
    expect(owner(nativeApprovalIds[0]!)).toMatchObject({
      agentId: "main",
      sessionKey: "agent:main:main",
      runId: "composed-plugin-run",
      contextId: pluginToken?.contextId,
      executionId: pluginToken?.executionId,
    });
    const stateDb = openOpenClawStateDatabase(databaseOptions).db;
    expect(
      stateDb
        .prepare(
          "SELECT COUNT(*) AS count FROM execution_identity_contexts WHERE execution_id = ? OR run_id = ?",
        )
        .get("disabled-execution", "disabled-run"),
    ).toEqual({ count: 0 });
    expect(
      stateDb
        .prepare(
          "SELECT execution_id FROM execution_identity_contexts WHERE run_id = ? ORDER BY execution_id",
        )
        .all("shared-run"),
    ).toEqual([{ execution_id: first.token!.executionId }]);
    expect(
      stateDb
        .prepare(
          "SELECT approval_id, source_execution_id FROM operator_approval_execution_identities ORDER BY approval_id",
        )
        .all(),
    ).toEqual(
      [
        { approval_id: "exact-first", source_execution_id: first.token!.executionId },
        { approval_id: "exact-second", source_execution_id: second.token!.executionId },
        {
          approval_id: approvalIds.get("read")!,
          source_execution_id: coreToken!.executionId,
        },
        {
          approval_id: approvalIds.get(APPROVAL_PLUGIN_TOOL_NAME)!,
          source_execution_id: pluginToken!.executionId,
        },
        ...nativeApprovalIds.map((approvalId) => ({
          approval_id: approvalId,
          source_execution_id: pluginToken!.executionId,
        })),
      ].toSorted((left, right) => left.approval_id.localeCompare(right.approval_id)),
    );

    setRuntimeConfigSnapshot(enabledConfig, enabledConfig);
    server = await startGatewayServer(port, {
      bind: "loopback",
      auth: { mode: "token", token: gatewayToken },
      controlUiEnabled: false,
      sidecarStartup: "defer",
    });
    expect(owner("exact-first")).toMatchObject({
      contextId: first.token?.contextId,
      executionId: first.token?.executionId,
    });
  }, 300_000);
});
