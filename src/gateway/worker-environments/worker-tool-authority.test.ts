import { afterEach, describe, expect, it, vi } from "vitest";
import "../../agents/test-helpers/fast-bash-tools.js";
import "../../agents/test-helpers/fast-coding-tools.js";
import { createOpenClawCodingToolsInternal } from "../../agents/agent-tools.js";
import type { AnyAgentTool } from "../../agents/agent-tools.types.js";
import { resolveNodeExecutionTarget } from "../../agents/bash-tools.exec-host-node-phases.js";
import type { ExecuteNodeHostCommandParams } from "../../agents/bash-tools.exec-host-node.types.js";
import { applyEmbeddedAttemptToolsAllow } from "../../agents/embedded-agent-runner/run/attempt-tool-construction-plan.js";
import type { SessionPlacementTurnParams } from "../../agents/session-placement-admission.js";
import { createWorkerPlacementTools } from "../../worker/worker-placement-tools.js";
import { resolveWorkerToolAuthority } from "./worker-tool-authority.js";

const gatewayMocks = vi.hoisted(() => ({ callGatewayTool: vi.fn() }));

vi.mock("../../agents/tools/gateway.js", () => ({
  callGatewayTool: gatewayMocks.callGatewayTool,
}));

function turn(overrides: Partial<SessionPlacementTurnParams> = {}): SessionPlacementTurnParams {
  return {
    sessionId: "session-worker-authority",
    sessionKey: "agent:main:cron:job:run:session",
    sessionFile: "/tmp/session.jsonl",
    workspaceDir: "/tmp/workspace",
    prompt: "run",
    timeoutMs: 1_000,
    runId: "run-worker-authority",
    provider: "openai",
    model: "gpt-test",
    agentId: "main",
    ...overrides,
  } as SessionPlacementTurnParams;
}

function resolvedAuthority(
  overrides: Partial<SessionPlacementTurnParams> = {},
  computerAvailable = false,
) {
  return resolveWorkerToolAuthority({
    modelRef: { provider: "openai", model: "gpt-test" },
    turn: turn(overrides),
    computerAvailable,
  });
}

function authority(overrides: Partial<SessionPlacementTurnParams> = {}, computerAvailable = false) {
  const input = turn(overrides);
  const { policy, capabilityProfile, exec, execUnavailable } = resolvedAuthority(
    overrides,
    computerAvailable,
  );
  const tools: AnyAgentTool[] = createWorkerPlacementTools({
    policy,
    cwd: input.workspaceDir,
    containmentRoot: input.workspaceDir,
    execAuthority: execUnavailable ? undefined : exec,
    permissionMode: input.permissionMode,
    agentId: "main",
    sessionKey: "agent:main:cron:job:run:session",
    sessionId: input.sessionId,
    runId: input.runId,
  });
  if (computerAvailable) {
    tools.push({
      name: "computer",
      label: "Computer",
      description: "Synthetic prepared desktop",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ content: [], details: {} }),
    });
  }
  return applyEmbeddedAttemptToolsAllow(
    createOpenClawCodingToolsInternal(
      {
        ...input,
        cronCreatorAuthorityUnavailableReason: undefined,
        conversationCapabilityProfile: capabilityProfile,
        wrapBeforeToolCallHook: false,
        toolConstructionPlan: {
          includeBaseCodingTools: false,
          includeShellTools: false,
          includeChannelTools: false,
          includeOpenClawTools: false,
          includePluginTools: false,
        },
      },
      undefined,
      undefined,
      { tools, policy },
    ),
    input.toolsAllow,
  ).map((tool) => tool.name);
}

afterEach(() => {
  gatewayMocks.callGatewayTool.mockReset();
});

describe("resolveWorkerToolAuthority", () => {
  it.each([
    { name: "default", tools: {}, allowed: true },
    {
      name: "additive sandbox tools",
      tools: { sandbox: { tools: { alsoAllow: ["web_fetch"] } } },
      allowed: true,
    },
    {
      name: "explicit sandbox allow",
      tools: { sandbox: { tools: { allow: ["read"] } } },
      allowed: false,
    },
    {
      name: "explicit sandbox deny",
      tools: { sandbox: { tools: { deny: ["computer"] } } },
      allowed: false,
    },
    { name: "global deny", tools: { deny: ["computer"] }, allowed: false },
    { name: "coding profile", tools: { profile: "coding" as const }, allowed: false },
  ])("respects $name policy for a prepared sandbox-contained desktop", ({ tools, allowed }) => {
    const overrides = {
      sessionKey: "agent:main:worker-sandboxed",
      config: { agents: { defaults: { sandbox: { mode: "all" as const } } }, tools },
    };
    expect(authority(overrides)).not.toContain("computer");
    expect(authority(overrides, true).includes("computer")).toBe(allowed);
  });

  it.each([
    {
      name: "explicit deny",
      exec: { security: "deny" as const, ask: "off" as const },
      expected: { security: "deny", ask: "off" },
    },
    {
      name: "allowlist mode",
      exec: { mode: "allowlist" as const },
      expected: { security: "allowlist", ask: "off" },
    },
  ])(
    "carries effective exec authority for $name instead of only the tool name",
    ({ exec, expected }) => {
      const resolved = resolvedAuthority({
        config: { tools: { exec } },
        toolsAllow: ["exec", "process"],
      });

      expect(resolved.exec).toMatchObject(expected);
    },
  );

  it.each(["sandbox", "node"] as const)(
    "withholds exec and process when the captured host is %s",
    (host) => {
      expect(
        resolvedAuthority({
          config: { tools: { exec: { host, mode: "full" } } },
          toolsAllow: ["exec", "process"],
        }),
      ).toMatchObject({
        exec: { host, security: "full", ask: "off" },
      });
      const tools = authority({ config: { tools: { exec: { host, mode: "full" } } } });
      expect(tools).not.toContain("exec");
      expect(tools).not.toContain("process");
    },
  );

  it.each([
    {
      name: "deny",
      execSession: { permissionMode: "read-only" as const },
      expected: { host: "gateway", security: "deny", ask: "off" },
    },
    {
      name: "approval",
      execSession: { permissionMode: "guarded" as const },
      expected: { host: "gateway", security: "allowlist", ask: "on-miss" },
    },
    {
      name: "node binding",
      execSession: {
        execHost: "node" as const,
        execNode: "session-node",
        execCwd: " /remote/session/workspace ",
      },
      expected: {
        host: "node",
        security: "full",
        ask: "off",
        node: "session-node",
      },
    },
  ])("preserves session-owned exec $name at the worker boundary", ({ execSession, expected }) => {
    expect(
      resolvedAuthority({
        config: { tools: { exec: { host: "gateway", mode: "full" } } },
        execSession,
        toolsAllow: ["exec", "process"],
      }).exec,
    ).toEqual({ ...expected, safeBins: [] });
  });

  it.each([
    {
      name: "resolved node differs from the session binding",
      execOverrides: { host: "node" as const, node: "other-node" },
      expectedHost: "node",
    },
    {
      name: "resolved host is not node",
      execOverrides: { host: "gateway" as const },
      expectedHost: "gateway",
    },
  ])("omits the session node cwd when $name", ({ execOverrides, expectedHost }) => {
    const exec = resolvedAuthority({
      execSession: {
        execHost: "node",
        execNode: "session-node",
        execCwd: "/remote/session/workspace",
      },
      execOverrides,
    }).exec;

    expect(exec?.host).toBe(expectedHost);
    expect(exec).not.toHaveProperty("nodeCwd");
  });

  it("keeps the resolved node binding authoritative when a worker request names another node", async () => {
    gatewayMocks.callGatewayTool.mockResolvedValue({
      nodes: [
        {
          nodeId: "bound-node",
          displayName: "Bound Node",
          platform: process.platform,
          commands: ["system.run"],
        },
        {
          nodeId: "other-node",
          displayName: "Other Node",
          platform: process.platform,
          commands: ["system.run"],
        },
      ],
    });
    const resolved = resolvedAuthority({
      config: { tools: { exec: { host: "node", mode: "full", node: "bound-node" } } },
      toolsAllow: ["exec", "process"],
    });
    if (resolved.exec?.host !== "node") {
      throw new Error("expected node-host worker authority");
    }
    const request = {
      command: "echo worker-node-binding",
      workdir: undefined,
      env: {},
      requestedNode: "other-node",
      boundNode: resolved.exec.node,
      security: "full",
      ask: "off",
      defaultTimeoutSec: 30,
      approvalRunningNoticeMs: 0,
      warnings: [],
    } satisfies ExecuteNodeHostCommandParams;

    await expect(resolveNodeExecutionTarget(request)).rejects.toThrow(
      "exec node not allowed (bound to bound-node, requested resolved to other-node)",
    );
  });

  it("projects runtime caps with canonical write-to-apply_patch semantics", () => {
    expect(authority({ toolsAllow: ["write"] })).toEqual(["write", "apply_patch"]);
    expect(authority({ toolsAllow: [] })).toEqual([]);
  });

  it("uses scheduled owner group policy without reapplying fresh sender overlays", () => {
    const config = {
      tools: {
        deny: ["exec"],
        toolsBySender: { "*": { deny: ["write", "apply_patch"] } },
      },
      channels: {
        whatsapp: {
          groups: {
            team: {
              tools: { allow: ["read", "write", "exec"] },
              toolsBySender: { "*": { deny: ["write", "apply_patch"] } },
            },
          },
        },
      },
    } as SessionPlacementTurnParams["config"];

    expect(
      authority({
        config,
        messageProvider: "whatsapp",
        senderId: "guest",
        toolsAllow: ["read", "write", "exec"],
        scheduledToolPolicy: {
          version: 1,
          mode: "account",
          ownerSessionKey: "agent:main:whatsapp:group:team",
          ownerAccountId: "default",
        },
      }),
    ).toEqual(["read", "write", "apply_patch"]);
    expect(
      authority({
        config,
        messageProvider: "whatsapp",
        senderId: "guest",
        toolsAllow: ["read", "write", "exec"],
      }),
    ).toEqual(["read"]);
  });

  it("re-resolves current owner-group restrictions for every scheduled turn", () => {
    expect(
      authority({
        config: {
          channels: {
            whatsapp: {
              groups: { team: { tools: { deny: ["write", "apply_patch"] } } },
            },
          },
        },
        messageProvider: "whatsapp",
        toolsAllow: ["write"],
        scheduledToolPolicy: {
          version: 1,
          mode: "account",
          ownerSessionKey: "agent:main:whatsapp:group:team",
          ownerAccountId: "default",
        },
      }),
    ).toEqual([]);
  });

  it("applies sandbox tool policy when the session is configured for sandboxing", () => {
    expect(
      authority({
        sessionKey: "agent:main:worker-sandboxed",
        config: {
          agents: { defaults: { sandbox: { mode: "all" } } },
          tools: { sandbox: { tools: { allow: ["read"] } } },
        },
      }),
    ).toEqual(["read"]);
  });
});
