import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  persistClawInstallRecord,
  persistClawPackageRef,
  readClawPackageRefs,
} from "../claws/provenance.js";
import type { ClawAddPlan } from "../claws/types.js";
import { markClawPackageIndependentlyOwned } from "./claw-package-adoption.js";
import { closeOpenClawStateDatabaseForTest } from "./openclaw-state-db.js";

afterEach(() => closeOpenClawStateDatabaseForTest());

const packageIntegrity = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function plan(agentId: string, workspace: string): ClawAddPlan {
  return {
    schemaVersion: "openclaw.clawAddPlan.v1",
    manifestSchemaVersion: 1,
    stability: "experimental",
    dryRun: true,
    mutationAllowed: false,
    planIntegrity: `sha256:${agentId}`,
    claw: {
      kind: "package",
      name: `@acme/${agentId}`,
      version: "1.0.0",
      packageRoot: "/tmp/claw",
      manifestPath: "/tmp/claw/CLAW.md",
      integrityKind: "artifact",
      integrity: "sha256:claw",
      byteLength: 100,
    },
    agent: {
      requestedId: agentId,
      finalId: agentId,
      workspace,
      config: { id: agentId, workspace },
    },
    summary: {
      totalActions: 0,
      agentActions: 0,
      workspaceActions: 0,
      packageActions: 0,
      mcpServerActions: 0,
      cronJobActions: 0,
      blockedActions: 0,
    },
    actions: [],
    readiness: { ready: true, requirements: [] },
    blockers: [],
    diagnostics: [],
  };
}

describe("Claw package independent adoption", () => {
  it("does not fail an ordinary install when Claw state is unavailable", () => {
    const path = join(mkdtempSync(join(tmpdir(), "claw-adoption-invalid-")), "state.sqlite");
    writeFileSync(path, "not sqlite");

    expect(
      markClawPackageIndependentlyOwned(
        {
          kind: "plugin",
          source: "clawhub",
          ref: "@acme/audit",
          version: "1.0.0",
        },
        { path },
      ),
    ).toBe(0);
  });

  it("marks every shared plugin reference independently owned", () => {
    const env = { OPENCLAW_STATE_DIR: mkdtempSync(join(tmpdir(), "claw-adoption-")) };
    for (const agentId of ["first", "second"]) {
      const current = plan(agentId, `/tmp/${agentId}`);
      persistClawInstallRecord(current, { env });
      persistClawPackageRef(
        current,
        {
          kind: "plugin",
          source: "clawhub",
          ref: "@acme/audit",
          version: "1.0.0",
          integrity: packageIntegrity,
        },
        { env, ownership: "claw-installed" },
      );
    }

    expect(
      markClawPackageIndependentlyOwned(
        {
          kind: "plugin",
          source: "clawhub",
          ref: "@acme/audit",
          version: "1.0.0",
        },
        { env, nowMs: 42 },
      ),
    ).toBe(2);
    expect(readClawPackageRefs({ env })).toMatchObject([
      { ownership: "independently-owned", updatedAtMs: 42 },
      { ownership: "independently-owned", updatedAtMs: 42 },
    ]);
  });

  it("scopes skill adoption to the owning agent workspace", () => {
    const env = { OPENCLAW_STATE_DIR: mkdtempSync(join(tmpdir(), "claw-adoption-")) };
    for (const agentId of ["first", "second"]) {
      const current = plan(agentId, `/tmp/${agentId}`);
      persistClawInstallRecord(current, { env });
      persistClawPackageRef(
        current,
        {
          kind: "skill",
          source: "clawhub",
          ref: "triage",
          version: "1.0.0",
          integrity: packageIntegrity,
        },
        { env, ownership: "claw-installed" },
      );
    }

    expect(
      markClawPackageIndependentlyOwned(
        {
          kind: "skill",
          source: "clawhub",
          ref: "triage",
          version: "1.0.0",
          workspace: "/tmp/first",
        },
        { env },
      ),
    ).toBe(1);
    expect(readClawPackageRefs({ env, agentId: "first" })).toMatchObject([
      { ownership: "independently-owned" },
    ]);
    expect(readClawPackageRefs({ env, agentId: "second" })).toMatchObject([
      { ownership: "claw-installed" },
    ]);
  });
});
