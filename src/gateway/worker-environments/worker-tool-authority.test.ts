import { afterEach, describe, expect, it, vi } from "vitest";
import "../../agents/test-helpers/fast-bash-tools.js";
import "../../agents/test-helpers/fast-coding-tools.js";
import { finalizeAgentToolAvailability } from "../../agents/agent-tool-availability.js";
import { createOpenClawCodingToolsInternal } from "../../agents/agent-tools.js";
import type { AnyAgentTool } from "../../agents/agent-tools.types.js";
import { resolveNodeExecutionTarget } from "../../agents/bash-tools.exec-host-node-phases.js";
import type { ExecuteNodeHostCommandParams } from "../../agents/bash-tools.exec-host-node.types.js";
import { applyEmbeddedAttemptToolsAllow } from "../../agents/embedded-agent-runner/run/attempt-tool-construction-plan.js";
import type { SessionPlacementTurnParams } from "../../agents/session-placement-admission.js";
import { createInstalledSkillTools } from "../../agents/tools/installed-skill-tools.js";
import { createFixtureSkillEntry } from "../../skills/test-support/test-helpers.js";
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
    placement: { agentId: "main", sessionKey: "agent:main:cron:job:run:session" },
    assertCurrent: () => {},
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
  it("retains installed skill discovery and read authority across placement", async () => {
    const skill = {
      ...createFixtureSkillEntry("deployment-guide").skill,
      readContent: "# Deployment guide\nUse the canary, then verify the rollback target.\n",
    };
    let current = true;
    const resolved = resolveWorkerToolAuthority({
      modelRef: { provider: "openai", model: "gpt-test" },
      placement: { agentId: "main", sessionKey: "agent:main:worker-skills" },
      turn: turn({
        skillsSnapshot: { prompt: "", skills: [{ name: skill.name }], discoverySkills: [skill] },
      }),
      assertCurrent: () => {
        if (!current) {
          throw new Error("worker skill source authority closed");
        }
      },
    });
    expect(resolved.presentation.skills).toEqual([
      {
        name: skill.name,
        description: skill.description,
        location: skill.filePath,
      },
    ]);
    const tools = createInstalledSkillTools(resolved.installedSkills);
    finalizeAgentToolAvailability(tools);
    const search = tools.find((tool) => tool.name === "skills_search")!;
    const read = tools.find((tool) => tool.name === "skills_read")!;
    expect((await search.execute("search", { query: "canary" })).details).toMatchObject({
      skills: [{ name: skill.name }],
    });
    expect((await read.execute("read", { name: skill.name })).details).toEqual({
      name: skill.name,
      content: skill.readContent,
    });
    current = false;
    await expect(read.execute("read-closed", { name: skill.name })).rejects.toThrow(
      "source authority closed",
    );
    await expect(search.execute("search-closed", { query: "canary" })).rejects.toThrow(
      "source authority closed",
    );
  });

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
      expected: ["read"],
    },
    {
      name: "explicit sandbox deny",
      tools: { sandbox: { tools: { deny: ["computer"] } } },
      allowed: false,
    },
    { name: "global deny", tools: { deny: ["computer"] }, allowed: false },
    { name: "coding profile", tools: { profile: "coding" as const }, allowed: false },
  ])("respects $name policy for a prepared sandbox-contained desktop", (scenario) => {
    const { tools, allowed } = scenario;
    const overrides = {
      sessionKey: "agent:main:worker-sandboxed",
      config: { agents: { defaults: { sandbox: { mode: "all" as const } } }, tools },
    };
    const unprepared = authority(overrides);
    expect(unprepared).not.toContain("computer");
    expect(authority(overrides, true).includes("computer")).toBe(allowed);
    if ("expected" in scenario) {
      expect(unprepared).toEqual(scenario.expected);
    }
  });

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
      name: "configured deny",
      overrides: { config: { tools: { exec: { security: "deny", ask: "off" } } } },
      expected: { security: "deny", ask: "off" },
      exact: false,
    },
    {
      name: "configured allowlist",
      overrides: { config: { tools: { exec: { mode: "allowlist" } } } },
      expected: { security: "allowlist", ask: "off" },
      exact: false,
    },
    {
      name: "session deny",
      overrides: { execSession: { permissionMode: "read-only" } },
      expected: { host: "gateway", security: "deny", ask: "off" },
      exact: true,
    },
    {
      name: "session approval",
      overrides: { execSession: { permissionMode: "guarded" } },
      expected: { host: "gateway", security: "allowlist", ask: "on-miss" },
      exact: true,
    },
    {
      name: "session node binding",
      overrides: {
        execSession: {
          execHost: "node",
          execNode: "session-node",
          execCwd: " /remote/session/workspace ",
        },
      },
      expected: {
        host: "node",
        security: "full",
        ask: "off",
        node: "session-node",
      },
      exact: true,
    },
  ] satisfies Array<{
    name: string;
    overrides: Partial<SessionPlacementTurnParams>;
    expected: Partial<ReturnType<typeof resolvedAuthority>["exec"]>;
    exact: boolean;
  }>)("preserves effective exec authority for $name", ({ overrides, expected, exact }) => {
    const { exec } = resolvedAuthority({
      config: { tools: { exec: { host: "gateway", mode: "full" } } },
      toolsAllow: ["exec", "process"],
      ...overrides,
    });
    if (exact) {
      expect(exec).toEqual({ ...expected, safeBins: [] });
    } else {
      expect(exec).toMatchObject(expected);
    }
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

  it("applies current owner policy and the appropriate sender overlays", () => {
    const config: NonNullable<SessionPlacementTurnParams["config"]> = {
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
    };
    const scheduledToolPolicy: NonNullable<SessionPlacementTurnParams["scheduledToolPolicy"]> = {
      version: 1,
      mode: "account",
      ownerSessionKey: "agent:main:whatsapp:group:team",
      ownerAccountId: "default",
    };
    const scenarios: Array<{
      name: string;
      overrides: Partial<SessionPlacementTurnParams>;
      expected: string[];
    }> = [
      {
        name: "scheduled owner without fresh sender overlays",
        overrides: {
          config,
          senderId: "guest",
          toolsAllow: ["read", "write", "exec"],
          scheduledToolPolicy,
        },
        expected: ["read", "write", "apply_patch"],
      },
      {
        name: "fresh sender overlays",
        overrides: { config, senderId: "guest", toolsAllow: ["read", "write", "exec"] },
        expected: ["read"],
      },
      {
        name: "current owner-group restrictions",
        overrides: {
          config: {
            channels: {
              whatsapp: {
                groups: { team: { tools: { deny: ["write", "apply_patch"] } } },
              },
            },
          },
          toolsAllow: ["write"],
          scheduledToolPolicy,
        },
        expected: [],
      },
    ];
    for (const { name, overrides, expected } of scenarios) {
      expect(authority({ messageProvider: "whatsapp", ...overrides }), name).toEqual(expected);
    }
  });
});
