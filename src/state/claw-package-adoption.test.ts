import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { applyClawPackageRemovals, planClawPackageRemovals } from "../claws/package-remove.js";
import {
  persistClawInstallRecord,
  persistClawPackageRef,
  readClawPackageRefs,
} from "../claws/provenance.js";
import type { ClawAddPlan } from "../claws/types.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { markClawPackageIndependentlyOwned } from "./claw-package-adoption.js";
import { withClawPackageLifecycleLease } from "./claw-package-lifecycle-lease.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    await closeStateDatabaseForTest();
    cleanup();
  });
});

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
      capabilityEscalations: 0,
    },
    actions: [],
    capabilityChanges: [],
    readiness: { ready: true, requirements: [] },
    blockers: [],
    diagnostics: [],
  };
}

describe("Claw package independent adoption", () => {
  it("does not fail an ordinary install when Claw state is unavailable", async () => {
    const path = join(tempDirs.make("claw-adoption-invalid-"), "state.sqlite");
    writeFileSync(path, "not sqlite");

    expect(
      await markClawPackageIndependentlyOwned(
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

  it("marks every shared plugin reference independently owned", async () => {
    const env = { OPENCLAW_STATE_DIR: tempDirs.make("claw-adoption-") };
    for (const agentId of ["first", "second"]) {
      const current = plan(agentId, `/tmp/${agentId}`);
      persistClawInstallRecord(current, { env });
      for (const version of ["1.0.0", "2.0.0"]) {
        persistClawPackageRef(
          current,
          {
            kind: "plugin",
            source: "clawhub",
            ref: "@acme/audit",
            version,
            integrity: packageIntegrity,
          },
          {
            env,
            nowMs: 10,
            relationship: "referenced",
            origin: "claw-introduced",
            independentOwner: false,
          },
        );
      }
    }

    const artifact = {
      kind: "plugin",
      source: "clawhub",
      ref: "@acme/audit",
      version: "1.0.0",
    } as const;
    expect(await markClawPackageIndependentlyOwned(artifact, { env, nowMs: 42 })).toBe(2);
    expect(await markClawPackageIndependentlyOwned(artifact, { env, nowMs: 99 })).toBe(0);
    const refs = readClawPackageRefs({ env }).toSorted(
      (left, right) =>
        left.agentId.localeCompare(right.agentId) || left.version.localeCompare(right.version),
    );
    expect(refs).toMatchObject([
      { version: "1.0.0", independentOwner: true, updatedAtMs: 42 },
      { version: "2.0.0", independentOwner: false, updatedAtMs: 10 },
      { version: "1.0.0", independentOwner: true, updatedAtMs: 42 },
      { version: "2.0.0", independentOwner: false, updatedAtMs: 10 },
    ]);
    expect(refs.every((ref) => ref.origin === "claw-introduced")).toBe(true);
  });

  it("scopes skill adoption to the owning agent workspace", async () => {
    const env = { OPENCLAW_STATE_DIR: tempDirs.make("claw-adoption-") };
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
        {
          env,
          relationship: "managed",
          origin: "claw-introduced",
          independentOwner: false,
        },
      );
    }

    expect(
      await markClawPackageIndependentlyOwned(
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
      { origin: "claw-introduced", independentOwner: true },
    ]);
    expect(readClawPackageRefs({ env, agentId: "second" })).toMatchObject([
      { origin: "claw-introduced", independentOwner: false },
    ]);
  });

  it("retains global plugins and releases their Claw references", async () => {
    const env = { OPENCLAW_STATE_DIR: tempDirs.make("claw-adoption-race-") };
    const current = plan("worker", "/tmp/worker");
    const install = persistClawInstallRecord(current, { env });
    const ref = persistClawPackageRef(
      current,
      {
        kind: "plugin",
        source: "clawhub",
        ref: "@acme/audit",
        version: "1.0.0",
        integrity: packageIntegrity,
      },
      {
        env,
        relationship: "referenced",
        origin: "claw-introduced",
        independentOwner: false,
      },
    );
    const decisions = await planClawPackageRemovals(install, [ref], { env });

    const results = await applyClawPackageRemovals(decisions, { env });

    expect(results).toMatchObject({ packages: [{ action: "retained" }] });
    await expect(
      withClawPackageLifecycleLease(
        { kind: "plugin", source: "clawhub", ref: "@acme/audit" },
        async () => "direct operation admitted",
        { env },
      ),
    ).resolves.toBe("direct operation admitted");
  });

  it("serializes all skill mutations that share a workspace lockfile", async () => {
    const env = { OPENCLAW_STATE_DIR: tempDirs.make("claw-skill-lease-") };
    let competingEntered = false;
    await withClawPackageLifecycleLease(
      { kind: "skill", source: "clawhub", ref: "triage", workspace: "/tmp/worker" },
      async () => {
        await expect(
          withClawPackageLifecycleLease(
            { kind: "skill", source: "clawhub", ref: "summarize", workspace: "/tmp/worker" },
            async () => {
              competingEntered = true;
            },
            { env },
          ),
        ).rejects.toMatchObject({ code: "OPENCLAW_STATE_LEASE_HELD" });
        await expect(
          withClawPackageLifecycleLease(
            { kind: "skill", source: "clawhub", ref: "triage", workspace: "/tmp/other" },
            async () => "other workspace admitted",
            { env },
          ),
        ).resolves.toBe("other workspace admitted");
      },
      { env },
    );
    expect(competingEntered).toBe(false);
  });

  it("leases a direct operation before the first Claw package reference exists", async () => {
    const env = { OPENCLAW_STATE_DIR: tempDirs.make("claw-first-lease-") };
    const artifact = { kind: "plugin", source: "clawhub", ref: "@acme/audit" } as const;
    const entered = createDeferred();
    const finish = createDeferred();
    let competingEntered = false;
    const directOperation = withClawPackageLifecycleLease(
      artifact,
      async () => {
        entered.resolve();
        await finish.promise;
      },
      { env },
    );
    try {
      await awaitGateBeforeSettlement(
        entered.promise,
        directOperation,
        "Package operation settled before acquiring its lease",
      );
      await expect(
        withClawPackageLifecycleLease(
          artifact,
          async () => {
            competingEntered = true;
          },
          { env },
        ),
      ).rejects.toMatchObject({ code: "OPENCLAW_STATE_LEASE_HELD" });
      expect(competingEntered).toBe(false);
      await expect(
        withClawPackageLifecycleLease(
          { kind: "plugin", source: "clawhub", ref: "@acme/other" },
          async () => "other package admitted",
          { env },
        ),
      ).resolves.toBe("other package admitted");
    } finally {
      finish.resolve();
      await directOperation;
    }
    await expect(
      withClawPackageLifecycleLease(artifact, async () => "successor admitted", { env }),
    ).resolves.toBe("successor admitted");
  });

  it("refuses package mutation when lifecycle state is unavailable", async () => {
    const invalidDatabasePath = tempDirs.make("claw-invalid-db-path-");
    const artifact = { kind: "plugin", source: "clawhub", ref: "@acme/audit" } as const;
    let entered = false;
    await expect(
      withClawPackageLifecycleLease(
        artifact,
        async () => {
          entered = true;
        },
        { path: invalidDatabasePath },
      ),
    ).rejects.toThrow();
    expect(entered).toBe(false);
  });
});
