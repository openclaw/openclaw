import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as memorySearch from "../agents/memory-search.js";
import {
  SecretSurfaceUnavailableError,
  setActiveDegradedSecretOwners,
} from "../secrets/runtime-degraded-state.js";
import { runtimeMemorySecretOwnerId } from "../secrets/runtime-memory-secret-owner.js";
import { digestClawValue } from "./digest.js";
import {
  bindClawLifecycleTrust,
  projectClawAddPlan,
  projectClawRemovePlan,
  projectClawUpdatePlan,
  plansMatchAcrossSourceRoots,
} from "./gateway-plan-projection.js";
import { buildClawAdoptedRemovePlan } from "./lifecycle-adopted-removal.js";
import type { ClawRemovePlan } from "./lifecycle-remove-contract.js";
import type { ClawStatusRecord } from "./lifecycle-status.js";
import { digestClawMcpServer } from "./mcp.js";
import { CLAW_INSTALL_RECORD_ADOPTED_SCHEMA_VERSION } from "./provenance-agent-origin.js";
import type { ClawAddPlan } from "./types.js";
import { makeEmptyClawUpdatePlan } from "./update-plan-empty.js";
import { CLAW_WORKSPACE_FILE_RECORD_SCHEMA_VERSION } from "./workspace.js";

const config = { agents: { list: [] } };

function addPlan(sourceRoot: string, integrity = "sha256:artifact-a"): ClawAddPlan {
  return {
    schemaVersion: "openclaw.clawAddPlan.v1",
    manifestSchemaVersion: 1,
    stability: "experimental",
    dryRun: true,
    mutationAllowed: false,
    planIntegrity: `sha256:root-specific-${sourceRoot}`,
    claw: {
      kind: "package",
      name: "@openclaw/workflow-operator",
      version: "1.0.0",
      packageRoot: sourceRoot,
      manifestPath: path.join(sourceRoot, "CLAW.md"),
      integrityKind: "artifact",
      integrity,
      byteLength: 123,
    },
    agent: {
      requestedId: "workflow-operator",
      finalId: "workflow-operator",
      workspace: "/operator/workspace-workflow-operator",
      config: { id: "workflow-operator", workspace: "/operator/workspace-workflow-operator" },
    },
    summary: {
      totalActions: 1,
      agentActions: 0,
      workspaceActions: 1,
      packageActions: 0,
      mcpServerActions: 0,
      cronJobActions: 0,
      blockedActions: 0,
      capabilityEscalations: 0,
    },
    actions: [
      {
        kind: "workspaceFile",
        id: "SOUL.md",
        action: "write",
        target: "/operator/workspace-workflow-operator/SOUL.md",
        source: path.join(sourceRoot, "SOUL.md"),
        digest: "sha256:file-content",
        blocked: false,
      },
    ],
    capabilityChanges: [],
    readiness: { ready: true, requirements: [] },
    blockers: [],
    diagnostics: [],
  };
}

describe("Claw Gateway plan consent", () => {
  it("accepts the same archive across extraction roots but refuses changed artifact bytes", () => {
    const previewRoot = "/tmp/claw-preview";
    const applyRoot = "/tmp/claw-apply";
    const preview = addPlan(previewRoot);
    const applied = addPlan(applyRoot);

    expect(projectClawAddPlan(preview, previewRoot, [], config).planIntegrity).toBe(
      projectClawAddPlan(applied, applyRoot, [], config).planIntegrity,
    );
    expect(
      plansMatchAcrossSourceRoots({
        preview,
        previewRoot,
        persisted: applied,
        persistedRoot: applyRoot,
      }),
    ).toBe(true);
    expect(
      projectClawAddPlan(addPlan(applyRoot, "sha256:artifact-b"), applyRoot, [], config)
        .planIntegrity,
    ).not.toBe(projectClawAddPlan(preview, previewRoot, [], config).planIntegrity);
  });

  it("exposes only review facts and binds a trust warning into consent", () => {
    const root = "/tmp/private-claw-source";
    const plan = addPlan(root);
    plan.diagnostics.push({
      level: "warning",
      code: "example",
      phase: "plan",
      path: "source",
      message: "secret setup answer",
    });

    const projected = projectClawAddPlan(plan, root, [], config);
    expect(JSON.stringify(projected)).not.toContain(root);
    expect(JSON.stringify(projected)).not.toContain("secret setup answer");
    expect(projected.actions).toEqual([
      {
        kind: "workspaceFile",
        id: "SOUL.md",
        action: "write",
        blocked: false,
        effect: {
          type: "workspace-file",
          destination: "workspace/SOUL.md",
          source: "package/SOUL.md",
          desiredDigest: "sha256:file-content",
        },
      },
    ]);

    const warned = bindClawLifecycleTrust(projected, {
      trustWarning: "ClawHub risk review required.",
      riskAcknowledgementRequired: true,
    });
    expect(warned.planIntegrity).not.toBe(projected.planIntegrity);
    expect(warned.riskAcknowledgementRequired).toBe(true);
  });

  it("discloses an MCP process without leaking resolved environment values", () => {
    const root = "/tmp/private-claw-source";
    const plan = addPlan(root);
    plan.actions.push({
      kind: "mcpServer",
      id: "research",
      action: "configure",
      target: "mcp.servers.research",
      blocked: false,
      details: {
        command: "npx",
        args: ["-y", "@openclaw/research-mcp@1.0.0"],
        env: { RESEARCH_TOKEN: "${RESEARCH_API_KEY}" },
        toolFilter: { include: ["search"] },
        expectedState: "absent",
      },
    });

    const projected = projectClawAddPlan(plan, root, [], config);
    expect(projected.blockers).toEqual([]);
    expect(projected.actions[1]?.effect).toMatchObject({
      type: "mcp-server",
      proposed: {
        transport: "stdio",
        command: "npx",
        arguments: ["-y", "@openclaw/research-mcp@1.0.0"],
        environment: [{ name: "RESEARCH_TOKEN", sourceName: "RESEARCH_API_KEY" }],
        authentication: "none",
        toolFilter: { include: ["search"] },
      },
    });
    expect(JSON.stringify(projected)).not.toContain("/tmp/private-claw-source");
  });

  it("redacts remote MCP URL query values while binding them into consent", () => {
    const root = "/tmp/private-claw-source";
    const plan = addPlan(root);
    plan.actions.push({
      kind: "mcpServer",
      id: "remote-search",
      action: "configure",
      target: "mcp.servers.remote-search",
      blocked: false,
      details: {
        transport: "streamable-http",
        url: "https://mcp.example.test/search?token=private-token&workspace=example",
      },
    });
    const projected = projectClawAddPlan(plan, root, [], config);
    expect(projected.blockers).toEqual([]);
    expect(projected.actions[1]?.effect).toMatchObject({
      type: "mcp-server",
      proposed: {
        transport: "streamable-http",
        url: "https://mcp.example.test/search",
        queryParameterNames: ["token", "workspace"],
        urlDigest: expect.stringMatching(/^sha256:/u),
      },
    });
    expect(JSON.stringify(projected)).not.toContain("private-token");
    const changed = structuredClone(plan);
    changed.actions[1]!.details!.url =
      "https://mcp.example.test/search?token=another-token&workspace=example";
    expect(projectClawAddPlan(changed, root, [], config).planIntegrity).not.toBe(
      projected.planIntegrity,
    );
  });

  it("blocks Add when a required file or MCP effect cannot be disclosed", () => {
    const root = "/tmp/private-claw-source";
    const plan = addPlan(root);
    plan.actions[0]!.digest = undefined;
    plan.actions.push({
      kind: "mcpServer",
      id: "uninspectable",
      action: "configure",
      target: "mcp.servers.uninspectable",
      details: { command: "npx", env: { TOKEN: "resolved-private-value" } },
      blocked: false,
    });
    const projected = projectClawAddPlan(plan, root, [], config);
    expect(projected.blockers.map((blocker) => blocker.code)).toEqual([
      "effect_disclosure_unavailable",
      "effect_disclosure_unavailable",
    ]);
    expect(JSON.stringify(projected)).not.toContain("resolved-private-value");
  });

  it("discloses exact file and MCP changes on Update without current private config", () => {
    const root = "/tmp/private-update-source";
    const server = { command: "node", args: ["server.js"] };
    const plan = makeEmptyClawUpdatePlan({
      agentId: "workflow-operator",
      source: addPlan(root).claw,
      found: true,
      blockers: [],
    });
    plan.actions.push(
      {
        kind: "workspaceFile",
        id: "SOUL.md",
        action: "change",
        target: "/private/workspace:SOUL.md",
        blocked: false,
        reason: "File changes.",
        currentDigest: "sha256:old",
        desiredDigest: "sha256:new",
      },
      {
        kind: "mcpServer",
        id: "research",
        action: "add",
        target: "mcp.servers.research",
        blocked: false,
        reason: "MCP server added.",
        desiredDigest: digestClawMcpServer(server),
      },
    );
    const projected = projectClawUpdatePlan(plan, root, {
      config: { agents: { list: [{ id: "workflow-operator" }] } },
      desiredAgent: { id: "workflow-operator" },
      currentJobs: [],
      targetJobs: [],
      targetActions: [
        {
          kind: "workspaceFile",
          id: "SOUL.md",
          action: "write",
          target: "/private/workspace/SOUL.md",
          source: `${root}/SOUL.md`,
          digest: "sha256:new",
          blocked: false,
        },
        {
          kind: "mcpServer",
          id: "research",
          action: "configure",
          target: "mcp.servers.research",
          details: { ...server, expectedState: "absent" },
          blocked: false,
        },
      ],
    });
    expect(projected.blockers).toEqual([]);
    expect(projected.actions.map((action) => action.effect)).toMatchObject([
      {
        type: "workspace-file",
        destination: "workspace/SOUL.md",
        source: "package/SOUL.md",
        currentDigest: "sha256:old",
        desiredDigest: "sha256:new",
      },
      {
        type: "mcp-server",
        desiredDigest: digestClawMcpServer(server),
        proposed: { transport: "stdio", command: "node", arguments: ["server.js"] },
      },
    ]);
    expect(JSON.stringify(projected)).not.toContain("/private/workspace");
  });

  it("does not project an installable plugin without its capability review", () => {
    const root = "/tmp/private-claw-source";
    const plan = addPlan(root);
    plan.actions.push({
      kind: "package",
      id: "plugin:lobster",
      action: "install",
      target: "lobster",
      source: "clawhub:lobster@1.0.0",
      blocked: false,
      details: { kind: "plugin" },
    } as ClawAddPlan["actions"][number]);
    expect(() => projectClawAddPlan(plan, root, [], config)).toThrow(
      "plugin capability review is incomplete",
    );
  });

  it("binds a skill trust warning and exact artifact to the Add review", () => {
    const root = "/tmp/private-claw-source";
    const plan = addPlan(root);
    plan.actions.push({
      kind: "package",
      id: "skill:@community/triage",
      action: "install",
      target: "clawhub:@community/triage@1.0.0",
      digest: `sha256:${"a".repeat(64)}`,
      blocked: false,
      details: {
        kind: "skill",
        source: "clawhub",
        ref: "@community/triage",
        version: "1.0.0",
        integrity: `sha256:${"a".repeat(64)}`,
        ownerAction: "install",
        riskWarning: "Review this community skill before installation.",
      },
    });

    const projected = projectClawAddPlan(plan, root, [], config);
    expect(projected.skillReviews).toMatchObject([
      {
        actionId: "skill:@community/triage",
        integrity: `sha256:${"a".repeat(64)}`,
        riskWarning: "Review this community skill before installation.",
      },
    ]);
    expect(projected.skillReviews[0]?.reviewToken).toMatch(/^sha256:/);
    expect(projected.blockers).toEqual([]);
    expect(JSON.stringify(projected)).not.toContain(root);

    const changed = structuredClone(plan);
    changed.actions.at(-1)!.details!.riskWarning = "Trust state changed.";
    const changedProjection = projectClawAddPlan(changed, root, [], config);
    expect(changedProjection.planIntegrity).not.toBe(projected.planIntegrity);
    expect(changedProjection.skillReviews[0]?.reviewToken).not.toBe(
      projected.skillReviews[0]?.reviewToken,
    );
  });

  it("discloses configured spawn targets inherited from the host", () => {
    const root = "/tmp/private-claw-source";
    const projected = projectClawAddPlan(addPlan(root), root, [], {
      agents: {
        defaults: { subagents: { allowAgents: ["reviewer", "missing"], requireAgentId: true } },
        list: [{ id: "reviewer" }],
      },
    });

    expect(projected.configuredAccess?.desired?.subagentTargets).toEqual({
      allowedAgentIds: ["reviewer"],
      allowAnyConfiguredAgent: false,
      implicitSelfAllowed: false,
      requireAgentId: true,
    });
    expect(projected.configuredAccess?.unresolved).toContain("subagent-runtime");
    expect(JSON.stringify(projected)).not.toContain("missing");
    const changed = projectClawAddPlan(addPlan(root), root, [], {
      agents: {
        defaults: { subagents: { allowAgents: [], requireAgentId: true } },
        list: [{ id: "reviewer" }],
      },
    });
    expect(changed.planIntegrity).not.toBe(projected.planIntegrity);
  });

  it("keeps Add review available when this agent's memory secret owner is degraded", () => {
    setActiveDegradedSecretOwners([
      {
        ownerKind: "capability",
        ownerId: runtimeMemorySecretOwnerId("workflow-operator"),
        state: "unavailable",
        paths: ["/private/memory-provider"],
        refKeys: ["private-memory-ref"],
        reason: "private-provider-failure",
      },
    ]);
    try {
      const root = "/tmp/private-claw-source";
      const projected = projectClawAddPlan(addPlan(root), root, [], config);

      expect(projected.configuredAccess?.desired?.memorySearch).toEqual({ state: "unresolved" });
      expect(projected.blockers).toEqual([]);
      expect(JSON.stringify(projected)).not.toMatch(
        /private-memory|private-provider|SecretSurface/u,
      );
    } finally {
      setActiveDegradedSecretOwners([]);
    }
  });

  it("blocks Add when the Claw itself requests unresolved memory access", () => {
    setActiveDegradedSecretOwners([
      {
        ownerKind: "capability",
        ownerId: runtimeMemorySecretOwnerId("workflow-operator"),
        state: "unavailable",
        paths: ["/private/memory-provider"],
        refKeys: ["private-memory-ref"],
        reason: "private-provider-failure",
      },
    ]);
    try {
      const root = "/tmp/private-claw-source";
      const plan = addPlan(root);
      plan.agent.config.memory = { search: { enabled: true } };
      const projected = projectClawAddPlan(plan, root, [], config);
      expect(projected.configuredAccess?.desired?.memorySearch).toEqual({ state: "unresolved" });
      expect(projected.blockers).toContainEqual(
        expect.objectContaining({ code: "claw_memory_policy_unresolved" }),
      );
      expect(JSON.stringify(projected)).not.toMatch(/private-memory|private-provider/u);
    } finally {
      setActiveDegradedSecretOwners([]);
    }
  });

  it("does not hide forged or different-owner memory failures", () => {
    const forged = new Error("unrelated failure");
    forged.name = "SecretSurfaceUnavailableError";
    const otherOwner = new SecretSurfaceUnavailableError({
      ownerKind: "capability",
      ownerId: runtimeMemorySecretOwnerId("another-agent"),
      state: "unavailable",
      paths: [],
      refKeys: [],
      reason: "unavailable",
    });
    const root = "/tmp/private-claw-source";
    for (const error of [forged, otherOwner]) {
      const spy = vi
        .spyOn(memorySearch, "resolveMemorySearchIndexConfig")
        .mockImplementationOnce(() => {
          throw error;
        });
      try {
        expect(() => projectClawAddPlan(addPlan(root), root, [], config)).toThrow(error);
      } finally {
        spy.mockRestore();
      }
    }
  });

  it("shows unresolved current memory and disabled target memory on Update", () => {
    setActiveDegradedSecretOwners([
      {
        ownerKind: "capability",
        ownerId: runtimeMemorySecretOwnerId("workflow-operator"),
        state: "unavailable",
        paths: ["/private/memory-provider"],
        refKeys: ["private-memory-ref"],
        reason: "private-provider-failure",
      },
    ]);
    try {
      const root = "/tmp/private-update-source";
      const plan = makeEmptyClawUpdatePlan({
        agentId: "workflow-operator",
        source: addPlan(root).claw,
        found: true,
        blockers: [],
      });
      const projected = projectClawUpdatePlan(plan, root, {
        config: { agents: { list: [{ id: "workflow-operator" }] } },
        desiredAgent: { id: "workflow-operator", memory: { search: { enabled: false } } },
        currentJobs: [],
        targetJobs: [],
      });

      expect(projected.configuredAccess?.current?.memorySearch).toEqual({ state: "unresolved" });
      expect(projected.configuredAccess?.desired?.memorySearch).toEqual({ state: "disabled" });
      expect(projected.blockers).toEqual([]);
      expect(JSON.stringify(projected)).not.toMatch(/private-memory|private-provider/u);
    } finally {
      setActiveDegradedSecretOwners([]);
    }
  });

  it("blocks Update when the target Claw still requests unresolved memory access", () => {
    setActiveDegradedSecretOwners([
      {
        ownerKind: "capability",
        ownerId: runtimeMemorySecretOwnerId("workflow-operator"),
        state: "unavailable",
        paths: ["/private/memory-provider"],
        refKeys: ["private-memory-ref"],
        reason: "private-provider-failure",
      },
    ]);
    try {
      const root = "/tmp/private-update-source";
      const plan = makeEmptyClawUpdatePlan({
        agentId: "workflow-operator",
        source: addPlan(root).claw,
        found: true,
        blockers: [],
      });
      const projected = projectClawUpdatePlan(plan, root, {
        config: { agents: { list: [{ id: "workflow-operator" }] } },
        desiredAgent: { id: "workflow-operator", memory: { search: { enabled: true } } },
        currentJobs: [],
        targetJobs: [],
      });
      expect(projected.blockers).toContainEqual(
        expect.objectContaining({ code: "claw_memory_policy_unresolved" }),
      );
    } finally {
      setActiveDegradedSecretOwners([]);
    }
  });

  it("preserves operator-owned spawn policy in the Update preview", () => {
    const root = "/tmp/private-update-source";
    const plan = makeEmptyClawUpdatePlan({
      agentId: "workflow-operator",
      source: addPlan(root).claw,
      found: true,
      blockers: [],
    });
    const projected = projectClawUpdatePlan(plan, root, {
      config: {
        agents: {
          defaults: { subagents: { allowAgents: ["reviewer"], requireAgentId: true } },
          list: [
            {
              id: "workflow-operator",
              subagents: { allowAgents: ["*"], requireAgentId: false },
            },
            { id: "reviewer" },
          ],
        },
      },
      desiredAgent: { id: "workflow-operator" },
      currentJobs: [],
      targetJobs: [],
    });

    const expected = {
      allowedAgentIds: ["reviewer", "workflow-operator"],
      allowAnyConfiguredAgent: true,
      implicitSelfAllowed: true,
      requireAgentId: false,
    };
    expect(projected.configuredAccess?.current?.subagentTargets).toEqual(expected);
    expect(projected.configuredAccess?.desired?.subagentTargets).toEqual(expected);
  });

  it("redacts update diagnostics and requires capability review for plugin changes", () => {
    const root = "/tmp/private-update-source";
    const source = addPlan(root).claw;
    const plan = makeEmptyClawUpdatePlan({
      agentId: "workflow-operator",
      source,
      found: true,
      blockers: [
        {
          level: "error",
          code: "mcp_config_unavailable",
          phase: "plan",
          path: "$.mcpServers",
          message: "secret config value",
        },
      ],
    });
    plan.actions.push({
      kind: "package",
      id: "plugin:workflow-operator",
      action: "change",
      target: `${root}/plugin-token`,
      blocked: false,
      reason: "secret plugin preflight",
    });

    const projected = projectClawUpdatePlan(plan, root, {
      config: { agents: { list: [{ id: "workflow-operator" }] } },
      desiredAgent: { id: "workflow-operator" },
      currentJobs: [],
      targetJobs: [],
    });
    expect(projected.operation).toBe("update");
    expect(projected.pluginReviews).toEqual([]);
    expect(projected.blockers.map((blocker) => blocker.code)).toEqual([
      "mcp_config_unavailable",
      "plugin_consent_unavailable",
    ]);
    expect(JSON.stringify(projected)).not.toContain(root);
    expect(JSON.stringify(projected)).not.toContain("secret config value");
    expect(JSON.stringify(projected)).not.toContain("secret plugin preflight");

    const pluginReview = {
      actionId: "plugin:workflow-operator",
      pluginId: "workflow-operator",
      ref: "@openclaw/workflow-operator-plugin",
      version: "1.2.0",
      ownerAction: "install" as const,
      integrity: `sha256-${Buffer.from("a".repeat(64), "hex").toString("base64")}`,
      declaredCapabilities: {
        channels: [],
        providers: [],
        tools: ["workflow.run"],
        contracts: [],
        hooks: [],
        mcpServers: [],
        cliCommands: [],
        cliBackends: [],
        skills: [],
        dangerousConfigFlags: [],
      },
      capabilityGrants: {
        hooks: {
          allowPromptInjection: { effective: false },
          allowConversationAccess: { effective: false },
        },
      },
      reviewToken: "sha256:reviewed-plugin",
    };
    const reviewed = projectClawUpdatePlan(plan, root, {
      config: { agents: { list: [{ id: "workflow-operator" }] } },
      desiredAgent: { id: "workflow-operator" },
      currentJobs: [],
      targetJobs: [],
      pluginReviews: [pluginReview],
    });
    expect(reviewed.pluginReviews).toEqual([pluginReview]);
    expect(reviewed.blockers.map((blocker) => blocker.code)).toEqual(["mcp_config_unavailable"]);
    expect(reviewed.planIntegrity).not.toBe(projected.planIntegrity);
  });

  it("seals redacted access and schedule facts into Update consent", () => {
    const root = "/tmp/private-update-source";
    const source = addPlan(root).claw;
    const installedConfig = {
      agents: { list: [{ id: "workflow-operator", tools: { allow: ["read"] } }] },
    };
    const desiredAgent = { id: "workflow-operator", tools: { allow: ["read", "web_fetch"] } };
    const targetJob = {
      id: "daily-brief",
      schedule: { cron: "0 8 * * *", timezone: "UTC" },
      session: "isolated" as const,
      message: "Prepare a daily incident brief",
      delivery: { mode: "announce" as const, channel: "last" as const },
    };
    const plan = makeEmptyClawUpdatePlan({
      agentId: "workflow-operator",
      source,
      found: true,
      blockers: [],
    });
    plan.actions.push({
      kind: "cronJob",
      id: targetJob.id,
      action: "add",
      target: `${root}/secret-scheduler-id`,
      blocked: false,
      reason: "private schedule details",
      desiredDigest: digestClawValue(targetJob),
    });

    const projected = projectClawUpdatePlan(plan, root, {
      config: installedConfig,
      desiredAgent,
      currentJobs: [],
      targetJobs: [targetJob],
    });
    expect(projected.configuredAccess).toMatchObject({
      coverage: "configuration-only",
      current: { tools: { allowed: expect.arrayContaining(["read"]), explicitAllow: ["read"] } },
      desired: {
        tools: {
          allowed: expect.arrayContaining(["read", "web_fetch"]),
          explicitAllow: ["read", "web_fetch"],
        },
      },
    });
    expect(projected.scheduledJobs).toEqual({
      coverage: "package-declarations",
      jobs: [
        {
          id: "daily-brief",
          action: "add",
          blocked: false,
          proposed: {
            schedule: { cron: "0 8 * * *", timezone: "UTC" },
            session: "isolated",
            delivery: "last-channel",
            message: targetJob.message,
            messageDigest: digestClawValue(targetJob.message),
          },
        },
      ],
    });
    expect(JSON.stringify(projected)).toContain(targetJob.message);
    expect(JSON.stringify(projected)).not.toContain("secret-scheduler-id");

    const changed = projectClawUpdatePlan(plan, root, {
      config: { ...installedConfig, tools: { deny: ["web_fetch"] } },
      desiredAgent,
      currentJobs: [],
      targetJobs: [targetJob],
    });
    expect(changed.planIntegrity).not.toBe(projected.planIntegrity);

    const scheduleAction = plan.actions[0];
    if (!scheduleAction) {
      throw new Error("Expected a scheduled Update action.");
    }
    scheduleAction.desiredDigest = "sha256:wrong";
    const mismatched = projectClawUpdatePlan(plan, root, {
      config: installedConfig,
      desiredAgent,
      currentJobs: [],
      targetJobs: [targetJob],
    });
    expect(mismatched.scheduledJobs).toBeUndefined();
    expect(mismatched.blockers).toContainEqual(
      expect.objectContaining({ code: "configured_access_unavailable" }),
    );
  });

  it("shows nonsecret current and proposed schedule metadata for changes and removals", () => {
    const root = "/tmp/private-update-source";
    const source = addPlan(root).claw;
    const currentChange = {
      id: "daily-brief",
      schedule: { cron: "0 8 * * *", timezone: "UTC" },
      session: "main" as const,
      message: "SECRET: old task text",
      delivery: { mode: "none" as const },
    };
    const targetChange = {
      ...currentChange,
      schedule: { cron: "0 9 * * *", timezone: "America/Los_Angeles" },
      session: "isolated" as const,
      message: "Prepare the new brief",
      delivery: { mode: "announce" as const, channel: "last" as const },
    };
    const currentRemove = {
      ...currentChange,
      id: "weekly-review",
      schedule: { cron: "0 10 * * 1", timezone: "UTC" },
    };
    const plan = makeEmptyClawUpdatePlan({
      agentId: "workflow-operator",
      source,
      found: true,
      blockers: [],
    });
    plan.actions.push(
      {
        kind: "cronJob",
        id: currentChange.id,
        action: "change",
        target: "secret-scheduler-id",
        blocked: false,
        reason: "Schedule changes",
        currentDigest: digestClawValue(currentChange),
        desiredDigest: digestClawValue(targetChange),
      },
      {
        kind: "cronJob",
        id: currentRemove.id,
        action: "remove",
        target: "secret-scheduler-id-2",
        blocked: false,
        reason: "Schedule removed",
        currentDigest: digestClawValue(currentRemove),
      },
    );
    const review = {
      config: { agents: { list: [{ id: "workflow-operator" }] } },
      desiredAgent: { id: "workflow-operator" },
      currentJobs: [currentChange, currentRemove],
      targetJobs: [targetChange],
    };
    const projected = projectClawUpdatePlan(plan, root, review);
    expect(projected.scheduledJobs).toEqual({
      coverage: "package-declarations",
      jobs: [
        {
          id: "daily-brief",
          action: "change",
          blocked: false,
          current: {
            schedule: currentChange.schedule,
            session: "main",
            delivery: "none",
            messageDigest: digestClawValue(currentChange.message),
          },
          proposed: {
            schedule: targetChange.schedule,
            session: "isolated",
            delivery: "last-channel",
            message: targetChange.message,
            messageDigest: digestClawValue(targetChange.message),
          },
        },
        {
          id: "weekly-review",
          action: "remove",
          blocked: false,
          current: {
            schedule: currentRemove.schedule,
            session: "main",
            delivery: "none",
            messageDigest: digestClawValue(currentRemove.message),
          },
        },
      ],
    });
    expect(JSON.stringify(projected)).not.toContain(currentChange.message);
    expect(JSON.stringify(projected)).not.toContain(currentRemove.message);
    expect(JSON.stringify(projected)).toContain(targetChange.message);
    expect(JSON.stringify(projected)).not.toContain("secret-scheduler-id");

    const stale = projectClawUpdatePlan(plan, root, {
      ...review,
      currentJobs: [
        { ...currentChange, schedule: { cron: "0 7 * * *", timezone: "UTC" } },
        currentRemove,
      ],
    });
    expect(stale.scheduledJobs).toBeUndefined();
    expect(stale.blockers).toContainEqual(
      expect.objectContaining({ code: "configured_access_unavailable" }),
    );
  });

  it("blocks an Update if its desired access was not available for review", () => {
    const root = "/tmp/private-update-source";
    const plan = makeEmptyClawUpdatePlan({
      agentId: "workflow-operator",
      source: addPlan(root).claw,
      found: true,
      blockers: [],
    });
    const projected = projectClawUpdatePlan(plan, root, {
      config: { agents: { list: [{ id: "workflow-operator" }] } },
      currentJobs: [],
      targetJobs: [],
    });
    expect(projected.configuredAccess).toBeUndefined();
    expect(projected.blockers).toContainEqual(
      expect.objectContaining({ code: "configured_access_unavailable" }),
    );
  });

  it("redacts removal targets, reasons, and blocker details", () => {
    const plan: ClawRemovePlan = {
      schemaVersion: "openclaw.clawRemovePlan.v1",
      stability: "experimental",
      dryRun: true,
      mutationAllowed: false,
      planIntegrity: "sha256:canonical",
      target: "workflow-operator",
      agentId: "workflow-operator",
      actions: [
        {
          kind: "workspace",
          id: "workflow-operator",
          action: "trash",
          target: "/private/secret/workspace",
          blocked: false,
          details: { token: "secret" },
        },
      ],
      blockers: [{ code: "shared_session_store_owner", message: "secret owner" }],
    };
    const projected = projectClawRemovePlan(plan, {
      name: "@openclaw/workflow-operator",
      version: "1.0.0",
    });
    expect(projected.target).toMatchObject({
      agentId: "workflow-operator",
      currentVersion: "1.0.0",
    });
    expect(projected.actions).toEqual([
      { kind: "workspace", id: "workflow-operator", action: "trash", blocked: false },
    ]);
    expect(JSON.stringify(projected)).not.toContain("secret");
  });

  it("reviews retained files without claiming their recorded digest is current", () => {
    const agentId = "workflow-operator";
    const workspace = "/private/adopted-workspace";
    const record: ClawStatusRecord = {
      install: {
        schemaVersion: CLAW_INSTALL_RECORD_ADOPTED_SCHEMA_VERSION,
        claw: addPlan("/private/generated-package").claw,
        manifestSchemaVersion: 1,
        planIntegrity: "sha256:adopted-plan",
        agentId,
        workspace,
        agentConfigDigest: "sha256:adopted-config",
        agentOrigin: "adopted",
        agentOwnedPaths: [],
        status: "complete",
        addedAtMs: 1,
        updatedAtMs: 2,
      },
      agentState: "present",
      bootstrapState: "complete",
      bootstrap: { state: "complete", workspace, path: "SOUL.md" },
      workspaceFiles: [
        {
          schemaVersion: CLAW_WORKSPACE_FILE_RECORD_SCHEMA_VERSION,
          agentId,
          workspace,
          path: "SOUL.md",
          sourcePath: "SOUL.md",
          contentDigest: "sha256:existing-file",
          status: "complete",
          state: "unchanged",
          createdAtMs: 1,
          updatedAtMs: 2,
        },
      ],
      packages: [],
      mcpServers: [],
      cronJobs: [],
    };
    const projected = projectClawRemovePlan(buildClawAdoptedRemovePlan(agentId, record, []));

    expect(projected.blockers).toEqual([]);
    expect(projected.actions).toContainEqual({
      kind: "workspaceFile",
      id: "SOUL.md",
      action: "retain",
      blocked: false,
    });
    expect(JSON.stringify(projected)).not.toContain(workspace);
  });

  it("does not project an old digest as current for a modified retained file", () => {
    const plan: ClawRemovePlan = {
      schemaVersion: "openclaw.clawRemovePlan.v1",
      stability: "experimental",
      dryRun: true,
      mutationAllowed: false,
      planIntegrity: "sha256:modified-file-plan",
      target: "workflow-operator",
      agentId: "workflow-operator",
      blockers: [],
      actions: [
        {
          kind: "workspaceFile",
          id: "SOUL.md",
          action: "retain",
          target: "/private/adopted-workspace:SOUL.md",
          blocked: false,
          details: { expectedState: "modified", contentDigest: "sha256:old-recorded-file" },
        },
      ],
    };

    const projected = projectClawRemovePlan(plan);
    expect(projected.blockers).toEqual([]);
    expect(projected.actions).toEqual([
      { kind: "workspaceFile", id: "SOUL.md", action: "retain", blocked: false },
    ]);
    expect(JSON.stringify(projected)).not.toContain("sha256:old-recorded-file");
  });

  it("distinguishes released shared resources from removed owned resources", () => {
    const plan: ClawRemovePlan = {
      schemaVersion: "openclaw.clawRemovePlan.v1",
      stability: "experimental",
      dryRun: true,
      mutationAllowed: false,
      planIntegrity: "sha256:canonical",
      target: "workflow-operator",
      agentId: "workflow-operator",
      blockers: [],
      actions: [
        {
          kind: "packageRef",
          id: "plugin:@openclaw/shared@1.0.0",
          action: "release",
          target: "clawhub:@openclaw/shared@1.0.0",
          blocked: false,
          details: {
            relationship: "referenced",
            origin: "pre-existing",
            independentOwner: true,
            affectedClawAgentIds: ["another-agent"],
          },
        },
        {
          kind: "mcpServer",
          id: "private-owned",
          action: "remove",
          target: "mcp.servers.private-owned",
          blocked: false,
          details: {
            relationship: "managed",
            origin: "claw-introduced",
            independentOwner: false,
            configDigest: "sha256:owned",
            affectedClawAgentIds: [],
          },
        },
      ],
    };
    const projected = projectClawRemovePlan(plan);
    expect(projected.blockers).toEqual([]);
    expect(projected.actions.map((action) => action.effect)).toMatchObject([
      {
        type: "ownership",
        relationship: "referenced",
        origin: "pre-existing",
        independentOwner: true,
        affectedClawCount: 1,
      },
      {
        type: "mcp-server",
        currentDigest: "sha256:owned",
        ownership: {
          relationship: "managed",
          origin: "claw-introduced",
          independentOwner: false,
          affectedClawCount: 0,
        },
      },
    ]);
    expect(JSON.stringify(projected)).not.toContain("another-agent");
  });
});
