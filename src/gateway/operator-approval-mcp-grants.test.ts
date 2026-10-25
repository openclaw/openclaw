import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { buildCodexUserMcpServersThreadConfigPatchForRuntime } from "../agents/cli-runner/bundle-mcp-codex.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
  resetAgentRunRegistryForTest,
  validateAgentRunDelegatedAuthority,
} from "../infra/agent-run-registry.js";
import { loadExecApprovalsReadOnly } from "../infra/exec-approvals-store.js";
import { registerMcpToolApprovalBinding } from "../infra/mcp-tool-approval-binding.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { createGatewayAuxHandlers } from "./server-aux-handlers.js";
import { createGatewayAuxHandlerTestParams } from "./server-aux-handlers.test-support.js";
import { createPluginApprovalHandlers } from "./server-methods/plugin-approval.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";

const auxiliaries: ReturnType<typeof createGatewayAuxHandlers>[] = [];
let fixture: OpenClawTestState | undefined;
const cfg: OpenClawConfig = {
  agents: { entries: { main: {}, other: {} } },
  mcp: { servers: { "project.docs": { command: "docs-mcp" } } },
};

function gateway() {
  const aux = createGatewayAuxHandlers(
    createGatewayAuxHandlerTestParams({
      validateAgentRuntimeDelegatedAuthority: validateAgentRunDelegatedAuthority,
    }),
  );
  auxiliaries.push(aux);
  return aux;
}

beforeEach(async () => {
  if (fixture) {
    throw new Error("Previous auxiliary owner cleanup did not finish");
  }
  fixture = await createOpenClawTestState({ label: "mcp-tool-grants" });
  setRuntimeConfigSnapshot(cfg);
});
afterEach(async () => {
  for (const aux of auxiliaries) {
    await aux.stopOperatorInteractions();
  }
  auxiliaries.length = 0;
  resetAgentRunRegistryForTest();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  clearRuntimeConfigSnapshot();
  await fixture?.cleanup();
  fixture = undefined;
});

async function requestGrant(
  options: {
    server?: string;
    agentId?: string;
    trusted?: boolean;
    allowedDecisions?: string[];
    isActive?: () => boolean;
    binding?: boolean;
  } = {},
) {
  const aux = gateway();
  const authority = claimAgentRunDelegatedAuthority({
    instanceId: "mcp-instance",
    runId: "mcp-run",
  });
  const request = {
    title: "MCP tool approval",
    description: "Write a note",
    toolName: "codex_mcp_tool_approval",
    toolCallId: "raw-item-1",
    mcpTool: { server: options.server ?? "project.docs", tool: "write_note" },
    agentId: options.agentId ?? "main",
    allowedDecisions: options.allowedDecisions ?? ["allow-once", "allow-always", "deny"],
    twoPhase: true,
  };
  const releaseBinding =
    options.binding === false
      ? undefined
      : registerMcpToolApprovalBinding({
          authority,
          agentId: "main",
          toolCallId: request.toolCallId,
          ...request.mcpTool,
          isActive: options.isActive ?? (() => true),
        });
  const acknowledged = createDeferred();
  const args = {
    req: { method: "plugin.approval.request", params: request, id: "request-1" },
    params: request,
    client: {
      connId: "runtime-1",
      connect: { client: { id: "test-client" } },
      internal:
        options.trusted === false
          ? undefined
          : {
              agentRuntimeIdentity: {
                kind: "agentRuntime",
                agentId: "main",
                operationalRunInstance: authority.operationalRunInstance,
                delegatedAuthority: { ...authority, kind: "local" },
                approvalOwnerPluginId: "codex",
              },
            },
    },
    respond: vi.fn(() => acknowledged.resolve()),
    isWebchatConnect: () => false,
    context: {
      broadcast: vi.fn(),
      getRuntimeConfig: () => cfg,
      logGateway: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
      hasExecApprovalClients: () => true,
      validateAgentRuntimeApprovalAuthority: () => validateAgentRunDelegatedAuthority(authority),
    },
  } as unknown as GatewayRequestHandlerOptions;
  const pending = createPluginApprovalHandlers(aux.pluginApprovalManager)[
    "plugin.approval.request"
  ]!(args);
  try {
    await Promise.race([acknowledged.promise, pending]);
    expect(args.respond).toHaveBeenCalled();
    const record = (await aux.pluginApprovalManager.listPendingRecords())[0];
    if (!record) {
      await pending;
      throw new Error("MCP approval request did not register");
    }
    return { aux, authority, pending, record };
  } finally {
    releaseBinding?.();
  }
}

describe("gateway MCP tool grants", () => {
  it("mints once for the authenticated agent and projects the grant after gateway restart", async () => {
    const { aux, pending, record } = await requestGrant({ agentId: "other" });
    expect(await aux.pluginApprovalManager.resolve(record.id, "allow-always")).toBe(true);
    await pending;
    const expected = {
      server: "project.docs",
      tool: "write_note",
      source: "allow-always",
      addedAt: expect.any(Number),
    };
    expect(loadExecApprovalsReadOnly().agents).toEqual({ main: { mcpTools: [expected] } });
    expect(await aux.pluginApprovalManager.resolve(record.id, "allow-always")).toBe(false);
    await aux.stopOperatorInteractions();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    const restarted = gateway();
    expect(restarted.pluginApprovalManager.runtimeEpoch).not.toBe(
      aux.pluginApprovalManager.runtimeEpoch,
    );
    expect(loadExecApprovalsReadOnly().agents).toEqual({ main: { mcpTools: [expected] } });
    const approvedTool = {
      mcp_servers: { "project.docs": { tools: { write_note: { approval_mode: "approve" } } } },
    };
    expect(
      await buildCodexUserMcpServersThreadConfigPatchForRuntime(cfg, { agentId: "main" }),
    ).toMatchObject(approvedTool);
    expect(
      await buildCodexUserMcpServersThreadConfigPatchForRuntime(cfg, { agentId: "other" }),
    ).not.toMatchObject(approvedTool);
  });

  it.each([
    { name: "unconfigured apps", server: "codex_apps" },
    { name: "unconfigured computer use", server: "computer" },
    { name: "untrusted caller", trusted: false },
    { name: "remote or missing live proof", binding: false },
    { name: "allow once", decision: "allow-once" as const },
    { name: "deny", decision: "deny" as const },
    {
      name: "explicit prompt",
      serverConfig: { codex: { defaultToolsApprovalMode: "prompt" as const } },
    },
    {
      name: "native prompt spelling",
      serverConfig: { default_tools_approval_mode: "prompt" as const },
    },
    { name: "removed server", removed: true },
    { name: "closed authority", closed: true },
  ])("does not mint for $name", async (options) => {
    const { aux, authority, pending, record } = await requestGrant(options);
    if (options.serverConfig || options.removed) {
      setRuntimeConfigSnapshot({
        ...cfg,
        mcp: {
          servers: options.removed
            ? {}
            : { "project.docs": { command: "docs-mcp", ...options.serverConfig } },
        },
      });
    }
    if (options.closed) {
      releaseAgentRunDelegatedAuthority(authority);
    }
    await aux.pluginApprovalManager.resolve(record.id, options.decision ?? "allow-always");
    await pending;
    expect(loadExecApprovalsReadOnly().agents).toEqual({});
  });

  it("keeps one-shot approval when correlation is lost while the prompt is pending", async () => {
    let active = true;
    const { aux, pending, record } = await requestGrant({ isActive: () => active });
    active = false;
    expect(await aux.pluginApprovalManager.resolve(record.id, "allow-always")).toBe(true);
    await pending;
    expect(loadExecApprovalsReadOnly().agents).toEqual({});
    expect(
      (await aux.pluginApprovalManager.getSnapshot(record.id))?.mcpToolApprovalActive,
    ).toBeUndefined();
  });

  it("rejects an unadvertised allow-always without minting", async () => {
    const { aux, pending, record } = await requestGrant({
      allowedDecisions: ["allow-once", "deny"],
    });
    expect(await aux.pluginApprovalManager.resolve(record.id, "allow-always")).toBe(false);
    expect(loadExecApprovalsReadOnly().agents).toEqual({});
    await aux.pluginApprovalManager.resolve(record.id, "deny");
    await pending;
  });
});
