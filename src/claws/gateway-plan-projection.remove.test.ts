import { describe, expect, it } from "vitest";
import { projectClawRemovePlan } from "./gateway-plan-projection.js";
import { buildClawAdoptedRemovePlan } from "./lifecycle-adopted-removal.js";
import type { ClawRemovePlan } from "./lifecycle-remove-contract.js";
import type { ClawStatusRecord } from "./lifecycle-status.js";
import { CLAW_INSTALL_RECORD_ADOPTED_SCHEMA_VERSION } from "./provenance-agent-origin.js";
import { CLAW_WORKSPACE_FILE_RECORD_SCHEMA_VERSION } from "./workspace.js";

describe("Claw Gateway removal projection", () => {
  it("reviews retained files without claiming their recorded digest is current", () => {
    const agentId = "workflow-operator";
    const workspace = "/private/adopted-workspace";
    const record: ClawStatusRecord = {
      install: {
        schemaVersion: CLAW_INSTALL_RECORD_ADOPTED_SCHEMA_VERSION,
        claw: {
          kind: "package",
          name: "@openclaw/workflow-operator",
          version: "1.0.0",
          packageRoot: "/private/generated-package",
          manifestPath: "/private/generated-package/CLAW.md",
          integrityKind: "artifact",
          integrity: "sha256:artifact-a",
          byteLength: 123,
        },
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
