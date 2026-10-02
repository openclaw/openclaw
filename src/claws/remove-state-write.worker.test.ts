import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { sessionChanges } from "../sessions/session-row-changes.js";
import {
  createAgentDatabaseInspectionRefusal,
  readAgentDatabaseAdmissionRefusal,
  recordAgentDatabaseAdmissions,
} from "../state/agent-database-admission.js";
import { readAgentDeletionJournal } from "../state/agent-deletion-journal.js";
import { acquireClawPackageLifecycleLease } from "../state/claw-package-lifecycle-lease.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { withOpenClawStateLease } from "../state/openclaw-state-lease.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  persistClawInstallRecordForAdd,
  persistClawPackageRefForAdd,
  updateClawPackageRefStatusForAdd,
} from "./add-state-write.js";
import { readClawInventory } from "./inventory-read.js";
import { digestClawRemovalInstall } from "./package-remove-plan.js";
import { makeProvenancePlan } from "./provenance.test-helpers.js";
import {
  assertClawRemoveState,
  assertNoAgentDatabaseLeasesForClawMonitor,
  claimClawRemoveState,
  releaseClawRemoveStateRows,
  rollbackClawRemoveState,
} from "./remove-state-write.js";
import { executeClawMutationStateCommand } from "./state-mutation-write.js";

let state: OpenClawTestState;
beforeEach(async () => {
  state = await createOpenClawTestState({ layout: "state-only", prefix: "claw-remove-state-" });
});
afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  await state.cleanup();
});

async function installedClaw() {
  const { plan } = await makeProvenancePlan(state.root, {
    schemaVersion: 1,
    agent: { id: "worker" },
  });
  const install = await persistClawInstallRecordForAdd(plan, {
    env: state.env,
    stateMode: "worker",
  });
  return {
    agentId: "worker",
    expectedInstall: install,
    workspaceDir: plan.agent.workspace,
    agentDir: path.join(state.root, "agents", "worker"),
    sessionsDir: path.join(state.root, "sessions", "worker"),
  };
}

async function withDeletionLease<T>(run: Parameters<typeof withOpenClawStateLease<T>>[1]) {
  return withOpenClawStateLease(
    {
      scope: "core:agent-deletion",
      key: "worker",
      database: { scope: "shared", options: { env: state.env } },
      leaseMs: 60_000,
      waitMs: 0,
      heartbeat: "worker",
      leaseLabel: "agent deletion",
      operationLabel: "agent.deletion.lease",
    },
    run,
  );
}

async function persistPackageRefWithLease(
  plan: Parameters<typeof persistClawPackageRefForAdd>[0],
  pkg: Parameters<typeof persistClawPackageRefForAdd>[1],
) {
  const artifact =
    pkg.kind === "skill"
      ? {
          kind: "skill" as const,
          source: pkg.source,
          ref: pkg.ref,
          workspace: plan.agent.workspace,
        }
      : { kind: "plugin" as const, source: pkg.source, ref: pkg.ref };
  const lease = acquireClawPackageLifecycleLease(artifact, { env: state.env, required: true });
  if (!lease?.identity) {
    throw new Error("Package lifecycle lease identity is unavailable.");
  }
  try {
    return await persistClawPackageRefForAdd(plan, pkg, {
      env: state.env,
      stateMode: "worker",
      status: "complete",
      packageLease: lease.identity,
    });
  } finally {
    lease.release();
  }
}

it.each(["add", "update"])(
  "excludes a concurrent Claw %s mutation while removal owns the agent lease",
  async (operation) => {
    const contender = () =>
      withOpenClawStateLease(
        {
          scope: "core:agent-deletion",
          key: "worker",
          database: { scope: "shared", options: { env: state.env } },
          leaseMs: 60_000,
          waitMs: 0,
          heartbeat: "worker",
          leaseLabel: `Claw ${operation}`,
          operationLabel: `claw.${operation}.lease`,
        },
        async () => true,
      );
    await withDeletionLease(async () => {
      await expect(contender()).rejects.toThrow();
    });
    await expect(contender()).resolves.toBe(true);
  },
);

it("claims and rolls back the exact install under a worker-verified deletion lease", async () => {
  const input = await installedClaw();
  const pending = createAgentDatabaseInspectionRefusal({
    agentId: "worker",
    paths: [input.agentDir],
    reason: "Startup inspection is pending.",
    pending: true,
  });
  recordAgentDatabaseAdmissions([pending], { env: state.env, source: "startup" });
  const publications: string[] = [];
  const unsubscribe = sessionChanges.subscribe((change) => {
    if ("all" in change) {
      publications.push(typeof change.scope === "string" ? change.scope : "topology");
    }
  });
  try {
    await withDeletionLease(async (lease) => {
      const options = { env: state.env, stateMode: "worker" as const, lease };
      const claimed = await claimClawRemoveState(input, options);
      expect(claimed.existingJournal).toBe(false);
      expect(readAgentDatabaseAdmissionRefusal("worker", { env: state.env })?.code).toBe(
        "agent-database-inspection-failed",
      );
      expect(readAgentDeletionJournal("worker", { env: state.env })).toMatchObject({
        operationId: claimed.guard.operationId,
        cleanupCompleted: false,
      });
      await assertClawRemoveState(claimed.guard, options);
      await assertNoAgentDatabaseLeasesForClawMonitor("worker", claimed.guard.operationId, options);
      await expect(
        assertNoAgentDatabaseLeasesForClawMonitor("worker", "wrong-operation", options),
      ).rejects.toThrow("no longer owns monitor cleanup");
      await expect(
        releaseClawRemoveStateRows({ ...claimed.guard, expectedInstall: null }, [], [], options),
      ).rejects.toThrow("no longer owns agent");
      await rollbackClawRemoveState(claimed.guard, options);
      await expect(assertClawRemoveState(claimed.guard, options)).rejects.toThrow(
        "no longer owns cleanup",
      );
    });
  } finally {
    unsubscribe();
  }
  expect(publications).toEqual(["stores", "topology", "stores"]);
  expect(readAgentDeletionJournal("worker", { env: state.env })).toBeUndefined();
});

it("retires install and journal atomically, and rejects an expired owner", async () => {
  const input = await installedClaw();
  let staleGuard: Awaited<ReturnType<typeof claimClawRemoveState>>["guard"] | undefined;
  const publications: string[] = [];
  const unsubscribe = sessionChanges.subscribe((change) => {
    if ("all" in change) {
      publications.push(typeof change.scope === "string" ? change.scope : "topology");
    }
  });
  await withDeletionLease(async (lease) => {
    const options = { env: state.env, stateMode: "worker" as const, lease };
    const claimed = await claimClawRemoveState(input, options);
    staleGuard = claimed.guard;
    const released = await releaseClawRemoveStateRows(claimed.guard, [], [], options);
    expect(released).toEqual({ complete: true, cleanupErrors: [] });
  });
  unsubscribe();
  expect(publications).toEqual(["stores", "topology"]);
  const inventory = await readClawInventory({ env: state.env });
  expect(inventory.installs).toEqual([]);
  expect(readAgentDeletionJournal("worker", { env: state.env })).toMatchObject({
    operationId: staleGuard?.operationId,
    cleanupCompleted: true,
  });
  await expect(
    executeClawMutationStateCommand(
      { env: state.env },
      {
        type: "claws.remove.assert",
        input: staleGuard!,
      },
    ),
  ).rejects.toThrow();
});

it("claims a package ref only while the exact deletion journal and artifact snapshot survive", async () => {
  const { plan } = await makeProvenancePlan(state.root, {
    schemaVersion: 1,
    agent: { id: "worker" },
  });
  const install = await persistClawInstallRecordForAdd(plan, {
    env: state.env,
    stateMode: "worker",
  });
  const ref = await persistPackageRefWithLease(plan, {
    kind: "plugin",
    source: "clawhub",
    ref: "@openclaw/workflow-operator-plugin",
    version: "1.0.0",
    integrity: `sha256:${"a".repeat(64)}`,
  });
  await withDeletionLease(async (lease) => {
    const options = { env: state.env, stateMode: "worker" as const, lease };
    const claimed = await claimClawRemoveState(
      {
        agentId: "worker",
        expectedInstall: install,
        workspaceDir: plan.agent.workspace,
        agentDir: path.join(state.root, "agents", "worker"),
        sessionsDir: path.join(state.root, "sessions", "worker"),
      },
      options,
    );
    const packageLease = acquireClawPackageLifecycleLease(
      { kind: "plugin", source: ref.source, ref: ref.ref },
      { env: state.env, required: true },
    );
    if (!packageLease?.identity) {
      throw new Error("Package lifecycle lease identity is unavailable.");
    }
    try {
      const input = {
        agentId: "worker",
        operationId: claimed.guard.operationId,
        expectedInstallDigest: digestClawRemovalInstall(install),
        packageLease: packageLease.identity,
        expectedRef: ref,
        expectedArtifactRefs: [ref],
        status: "pending" as const,
      };
      const command = { type: "claws.remove.packageRefStatus" as const, input };
      const changed = await executeClawMutationStateCommand({ env: state.env }, command);
      expect(changed.status).toBe("pending");
      expect((await readClawInventory({ env: state.env })).packages[0]?.status).toBe("pending");
      await expect(executeClawMutationStateCommand({ env: state.env }, command)).rejects.toThrow(
        "ownership changed",
      );
      await expect(
        executeClawMutationStateCommand(
          { env: state.env },
          {
            type: "claws.remove.packageRefStatus",
            input: {
              ...input,
              operationId: "wrong-operation",
              expectedRef: changed,
              expectedArtifactRefs: [changed],
            },
          },
        ),
      ).rejects.toThrow("no longer owns monitor cleanup");
      packageLease.release();
      const successor = acquireClawPackageLifecycleLease(
        { kind: "plugin", source: ref.source, ref: ref.ref },
        { env: state.env, required: true },
      );
      if (!successor) {
        throw new Error("Successor package lifecycle lease is unavailable.");
      }
      try {
        await expect(
          executeClawMutationStateCommand(
            { env: state.env },
            {
              type: "claws.remove.packageRefStatus",
              input: {
                ...input,
                expectedRef: changed,
                expectedArtifactRefs: [changed],
                status: "complete",
              },
            },
          ),
        ).rejects.toThrow("no longer owns its package lifecycle lease");
        expect((await readClawInventory({ env: state.env })).packages[0]?.status).toBe("pending");
      } finally {
        successor.release();
      }
      await rollbackClawRemoveState(claimed.guard, options);
    } finally {
      packageLease.release();
    }
  });
});

it("settles a skill ref when an identical skill in another workspace changes", async () => {
  const { plan } = await makeProvenancePlan(state.root, {
    schemaVersion: 1,
    agent: { id: "worker" },
  });
  const { plan: otherPlan } = await makeProvenancePlan(
    state.root,
    {
      schemaVersion: 1,
      agent: { id: "other" },
    },
    { workspace: path.join(state.root, "workspace-other") },
  );
  const install = await persistClawInstallRecordForAdd(plan, {
    env: state.env,
    stateMode: "worker",
  });
  await persistClawInstallRecordForAdd(otherPlan, { env: state.env, stateMode: "worker" });
  const skill = {
    kind: "skill" as const,
    source: "clawhub" as const,
    ref: "shared-skill",
    version: "1.0.0",
    integrity: `sha256:${"b".repeat(64)}`,
  };
  const ref = await persistPackageRefWithLease(plan, skill);
  const otherRef = await persistPackageRefWithLease(otherPlan, skill);
  expect(install.workspace).not.toBe(otherPlan.agent.workspace);
  await withDeletionLease(async (lease) => {
    const options = { env: state.env, stateMode: "worker" as const, lease };
    const claimed = await claimClawRemoveState(
      {
        agentId: "worker",
        expectedInstall: install,
        workspaceDir: plan.agent.workspace,
        agentDir: path.join(state.root, "agents", "worker"),
        sessionsDir: path.join(state.root, "sessions", "worker"),
      },
      options,
    );
    const packageLease = acquireClawPackageLifecycleLease(
      { kind: "skill", source: ref.source, ref: ref.ref, workspace: install.workspace },
      { env: state.env, required: true },
    );
    if (!packageLease?.identity) {
      throw new Error("Package lifecycle lease identity is unavailable.");
    }
    try {
      const input = {
        agentId: "worker",
        operationId: claimed.guard.operationId,
        expectedInstallDigest: digestClawRemovalInstall(install),
        packageLease: packageLease.identity,
        expectedRef: ref,
        expectedArtifactRefs: [ref],
        status: "pending" as const,
      };
      const pending = await executeClawMutationStateCommand(
        { env: state.env },
        { type: "claws.remove.packageRefStatus", input },
      );
      const otherLease = acquireClawPackageLifecycleLease(
        {
          kind: "skill",
          source: otherRef.source,
          ref: otherRef.ref,
          workspace: otherPlan.agent.workspace,
        },
        { env: state.env, required: true },
      );
      if (!otherLease?.identity) {
        throw new Error("Other package lifecycle lease identity is unavailable.");
      }
      try {
        await updateClawPackageRefStatusForAdd(otherRef, "pending", {
          env: state.env,
          stateMode: "worker",
          packageLease: otherLease.identity,
        });
      } finally {
        otherLease.release();
      }
      await expect(
        executeClawMutationStateCommand(
          { env: state.env },
          {
            type: "claws.remove.packageRefStatus",
            input: {
              ...input,
              expectedRef: pending,
              expectedArtifactRefs: [pending],
              status: "complete",
            },
          },
        ),
      ).resolves.toMatchObject({ status: "complete" });
      await rollbackClawRemoveState(claimed.guard, options);
    } finally {
      packageLease.release();
    }
  });
});
