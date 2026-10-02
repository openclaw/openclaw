import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as workerAdmission from "../infra/sqlite-worker-operation-admission.js";
import type { installPluginFromClawHub } from "../plugins/clawhub.js";
import { acquireClawPackageLifecycleLease } from "../state/claw-package-lifecycle-lease.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  persistClawCronPendingRefForAdd,
  persistClawInstallRecordForAdd,
  persistClawMcpPendingRefForAdd,
  persistClawPackageRefForAdd,
  persistClawWorkspaceFileForAdd,
  readClawPackageRefsForAdd,
  readClawMcpServerRefsByNameForAdd,
  readClawWorkspaceFileForAdd,
  updateClawPackageRefStatusForAdd,
  updateClawMcpRefForAdd,
  updateClawCronRefForAdd,
  updateClawWorkspaceFileStatusForAdd,
  updateClawInstallRecordStatusForAdd,
} from "./add-state-write.js";
import { applyClawAddPlan } from "./add.js";
import { installClawMcpServers } from "./mcp.js";
import { installClawPackages } from "./packages.js";
import { emptyPluginCapabilityEvidence, emptyPluginPlanEvidence } from "./packages.test-support.js";
import { readClawInstallRecord } from "./provenance.js";
import { makeProvenancePlan } from "./provenance.test-helpers.js";

let state: OpenClawTestState;
beforeEach(async () => {
  state = await createOpenClawTestState({ layout: "state-only", prefix: "claw-add-state-" });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawStateDatabaseAsync();
  await state.cleanup();
});

it("persists Add ownership through the real worker without main-thread SQL", async () => {
  const { plan } = await makeProvenancePlan(state.root, {
    schemaVersion: 1,
    agent: { id: "worker" },
  });
  const sql = observeMainThreadSql();
  try {
    const persisted = await persistClawInstallRecordForAdd(plan, {
      env: state.env,
      stateMode: "worker",
      status: "pending",
    });
    expect(persisted.status).toBe("pending");
    await updateClawInstallRecordStatusForAdd("worker", "workspace_ready", {
      env: state.env,
      stateMode: "worker",
      expectedStatuses: ["pending"],
    });
    sql.expectIdle();
  } finally {
    sql.restore();
  }
  expect(readClawInstallRecord("worker", { env: state.env })?.status).toBe("workspace_ready");
});

it("completes a basic Claw Add without shared-state SQL on the caller thread", async () => {
  const { plan } = await makeProvenancePlan(state.root, {
    schemaVersion: 1,
    agent: { id: "worker" },
  });
  const sql = observeMainThreadSql();
  try {
    const result = await applyClawAddPlan(plan, {
      env: state.env,
      stateMode: "worker",
      consentPlanIntegrity: plan.planIntegrity,
      commitConfig: async () => undefined,
    });
    expect(result.status).toBe("complete");
    sql.expectIdle();
  } finally {
    sql.restore();
  }
  expect(readClawInstallRecord("worker", { env: state.env })?.status).toBe("complete");
});

it("persists and reads package ownership through the shared worker", async () => {
  const { plan } = await makeProvenancePlan(state.root, {
    schemaVersion: 1,
    agent: { id: "worker" },
  });
  await persistClawInstallRecordForAdd(plan, { env: state.env, stateMode: "worker" });
  const packageRef = {
    kind: "skill" as const,
    source: "clawhub" as const,
    ref: "@openclaw/sample",
    version: "1.0.0",
    integrity: `sha256:${"a".repeat(64)}`,
  };
  const lease = acquireClawPackageLifecycleLease(
    { kind: "skill", source: "clawhub", ref: packageRef.ref, workspace: plan.agent.workspace },
    { env: state.env, required: true },
  );
  if (!lease?.identity) {
    throw new Error("Expected a package lifecycle lease.");
  }
  const sql = observeMainThreadSql();
  try {
    const pending = await persistClawPackageRefForAdd(plan, packageRef, {
      env: state.env,
      stateMode: "worker",
      status: "pending",
      packageLease: lease.identity,
    });
    const complete = await updateClawPackageRefStatusForAdd(pending, "complete", {
      env: state.env,
      stateMode: "worker",
      packageLease: lease.identity,
    });
    expect(complete.status).toBe("complete");
    expect(
      await readClawPackageRefsForAdd({
        env: state.env,
        stateMode: "worker",
        agentId: "worker",
        ref: packageRef.ref,
      }),
    ).toEqual([complete]);
    sql.expectIdle();
  } finally {
    sql.restore();
    lease.release();
  }
});

it("refuses a package reference write after its lifecycle lease is replaced", async () => {
  const { plan } = await makeProvenancePlan(state.root, {
    schemaVersion: 1,
    agent: { id: "worker" },
  });
  await persistClawInstallRecordForAdd(plan, { env: state.env, stateMode: "worker" });
  const pkg = {
    kind: "plugin" as const,
    source: "clawhub" as const,
    ref: "@openclaw/sample",
    version: "1.0.0",
    integrity: `sha256:${"a".repeat(64)}`,
  };
  const artifact = { kind: pkg.kind, source: pkg.source, ref: pkg.ref };
  const original = acquireClawPackageLifecycleLease(artifact, {
    env: state.env,
    required: true,
  });
  if (!original?.identity) {
    throw new Error("Expected an original package lifecycle lease.");
  }
  original.release();
  const successor = acquireClawPackageLifecycleLease(artifact, {
    env: state.env,
    required: true,
  });
  try {
    await expect(
      persistClawPackageRefForAdd(plan, pkg, {
        env: state.env,
        stateMode: "worker",
        status: "pending",
        packageLease: original.identity,
      }),
    ).rejects.toThrow("no longer owns its package lifecycle lease");
    expect(
      await readClawPackageRefsForAdd({ env: state.env, agentId: plan.agent.finalId }),
    ).toEqual([]);
  } finally {
    successor?.release();
  }
});

it("installs a package through the worker while holding its lifecycle lease", async () => {
  const { plan } = await makeProvenancePlan(state.root, {
    schemaVersion: 1,
    agent: { id: "worker" },
  });
  const pkg = {
    kind: "skill" as const,
    source: "clawhub" as const,
    ref: "@openclaw/sample",
    version: "1.0.0",
    integrity: `sha256:${"a".repeat(64)}`,
  };
  const packagePlan = {
    ...plan,
    actions: [
      {
        kind: "package" as const,
        id: `skill:${pkg.ref}`,
        action: "install" as const,
        target: `clawhub:${pkg.ref}@${pkg.version}`,
        details: { ...pkg, ownerAction: "install" as const },
        blocked: false,
      },
    ],
  };
  await persistClawInstallRecordForAdd(packagePlan, { env: state.env, stateMode: "worker" });

  const installed = await installClawPackages(packagePlan, {
    env: state.env,
    stateMode: "worker",
    deps: {
      preflightSkill: vi.fn().mockResolvedValue({
        ok: true,
        action: "install",
        integrity: pkg.integrity,
      }),
      installSkill: vi.fn().mockResolvedValue({
        ok: true,
        slug: "sample",
        version: pkg.version,
        targetDir: join(plan.agent.workspace, "skills", "sample"),
      }),
    },
  });
  expect(installed).toMatchObject([{ ref: pkg.ref, status: "complete" }]);
  expect(
    await readClawPackageRefsForAdd({ env: state.env, agentId: plan.agent.finalId }),
  ).toMatchObject([{ ref: pkg.ref, status: "complete" }]);
});

it("installs a plugin through the worker while holding its lifecycle lease", async () => {
  const { plan } = await makeProvenancePlan(state.root, {
    schemaVersion: 1,
    agent: { id: "worker" },
  });
  const pkg = {
    kind: "plugin" as const,
    source: "clawhub" as const,
    ref: "@openclaw/lease-probe",
    version: "0.1.2-local.2",
    integrity: `sha256:${"a".repeat(64)}`,
  };
  const packagePlan = {
    ...plan,
    actions: [
      {
        kind: "package" as const,
        id: `plugin:${pkg.ref}`,
        action: "install" as const,
        target: `clawhub:${pkg.ref}@${pkg.version}`,
        details: {
          ...pkg,
          ownerAction: "install" as const,
          installId: "lease-probe",
          ...emptyPluginPlanEvidence,
        },
        blocked: false,
      },
    ],
  };
  await persistClawInstallRecordForAdd(packagePlan, { env: state.env, stateMode: "worker" });
  const installPlugin = vi.fn().mockResolvedValue(undefined);
  const probePlugin = vi.fn(async (request: Parameters<typeof installPluginFromClawHub>[0]) => {
    await request.onPluginArtifactInspect?.({
      pluginId: "lease-probe",
      stagedArtifactDir: join(state.root, "staged-lease-probe"),
      mode: "install",
    });
    return {
      ok: true as const,
      pluginId: "lease-probe",
      packageName: pkg.ref,
      targetDir: join(state.root, "extensions", "lease-probe"),
      extensions: [],
      clawhub: {
        source: "clawhub" as const,
        clawhubUrl: "https://clawhub.ai",
        clawhubPackage: pkg.ref,
        clawhubFamily: "code-plugin" as const,
        integrity: pkg.integrity,
      },
    };
  });
  const installed = await installClawPackages(packagePlan, {
    env: state.env,
    stateMode: "worker",
    pluginConsent: {
      onCapabilityConsent: vi.fn(async (review: { reviewToken: string }) => ({
        reviewToken: review.reviewToken,
      })),
      confirmInstall: vi.fn().mockResolvedValue(true),
    },
    deps: {
      preflightPlugin: vi.fn().mockResolvedValue({ ok: true, action: "install" }),
      probePlugin,
      installPlugin,
      inspectPluginCapabilities: vi.fn(() => emptyPluginCapabilityEvidence),
    },
  });
  expect(installPlugin).toHaveBeenCalledOnce();
  expect(installed).toMatchObject([{ ref: pkg.ref, status: "complete" }]);
  expect(
    await readClawPackageRefsForAdd({ env: state.env, agentId: plan.agent.finalId }),
  ).toMatchObject([{ ref: pkg.ref, status: "complete" }]);
});

it("persists and reads workspace-file ownership through the shared worker", async () => {
  const { plan } = await makeProvenancePlan(state.root, {
    schemaVersion: 1,
    agent: { id: "worker" },
  });
  await persistClawInstallRecordForAdd(plan, { env: state.env, stateMode: "worker" });
  const pending = {
    schemaVersion: "openclaw.clawWorkspaceFileRecord.v1" as const,
    agentId: "worker",
    workspace: plan.agent.workspace,
    path: "AGENTS.md",
    sourcePath: "AGENTS.md",
    contentDigest: `sha256:${"b".repeat(64)}`,
    status: "pending" as const,
    createdAtMs: 1_000,
    updatedAtMs: 1_000,
  };
  const sql = observeMainThreadSql();
  try {
    await persistClawWorkspaceFileForAdd(pending, { env: state.env, stateMode: "worker" });
    const complete = { ...pending, status: "complete" as const, updatedAtMs: 1_001 };
    await updateClawWorkspaceFileStatusForAdd(complete, ["pending"], {
      env: state.env,
      stateMode: "worker",
    });
    expect(
      await readClawWorkspaceFileForAdd("worker", "AGENTS.md", {
        env: state.env,
        stateMode: "worker",
      }),
    ).toEqual(complete);
    sql.expectIdle();
  } finally {
    sql.restore();
  }
});

it("persists and reads MCP ownership through the shared worker", async () => {
  const { plan } = await makeProvenancePlan(state.root, {
    schemaVersion: 1,
    agent: { id: "worker" },
  });
  await persistClawInstallRecordForAdd(plan, { env: state.env, stateMode: "worker" });
  const sql = observeMainThreadSql();
  try {
    const pending = await persistClawMcpPendingRefForAdd(
      plan,
      "sample",
      { command: "/usr/bin/printf" },
      { relationship: "managed", origin: "claw-introduced", independentOwner: false },
      { env: state.env, stateMode: "worker", nowMs: 1_000 },
    );
    const complete = await updateClawMcpRefForAdd(
      pending,
      { status: "complete" },
      { env: state.env, stateMode: "worker", nowMs: 1_001 },
    );
    expect(
      await readClawMcpServerRefsByNameForAdd("sample", {
        env: state.env,
        stateMode: "worker",
      }),
    ).toEqual([complete]);
    sql.expectIdle();
  } finally {
    sql.restore();
  }
});

it("persists cron ownership through the shared worker", async () => {
  const { plan } = await makeProvenancePlan(state.root, {
    schemaVersion: 1,
    agent: { id: "worker" },
  });
  await persistClawInstallRecordForAdd(plan, { env: state.env, stateMode: "worker" });
  const sql = observeMainThreadSql();
  try {
    const pending = await persistClawCronPendingRefForAdd(
      plan,
      {
        id: "sample",
        schedule: { cron: "0 9 * * *", timezone: "UTC" },
        session: "main",
        message: "Hello",
      },
      { env: state.env, stateMode: "worker", nowMs: 1_000 },
    );
    const complete = await updateClawCronRefForAdd(
      pending,
      { status: "complete", schedulerJobId: "cron-1" },
      { env: state.env, stateMode: "worker", nowMs: 1_001 },
    );
    expect(complete).toMatchObject({ status: "complete", schedulerJobId: "cron-1" });
    sql.expectIdle();
  } finally {
    sql.restore();
  }
});

it("adds workspace, MCP, and cron resources without caller-thread lifecycle SQL", async () => {
  await writeFile(join(state.root, "policy.md"), "Keep the release small.\n");
  const { plan } = await makeProvenancePlan(state.root, {
    schemaVersion: 1,
    agent: { id: "worker" },
    workspace: { files: [{ source: "policy.md", path: "reference/policy.md" }] },
    mcpServers: { sample: { command: "/usr/bin/printf" } },
    cronJobs: [
      {
        id: "morning",
        schedule: { cron: "0 9 * * *", timezone: "UTC" },
        session: "main",
        message: "Hello",
      },
    ],
  });
  expect(plan.blockers).toEqual([]);
  const sql = observeMainThreadSql();
  try {
    const result = await applyClawAddPlan(plan, {
      env: state.env,
      stateMode: "worker",
      consentPlanIntegrity: plan.planIntegrity,
      commitConfig: async () => undefined,
      installMcpServers: (mcpPlan, options) =>
        installClawMcpServers(mcpPlan, {
          ...options,
          listMcpServers: vi.fn().mockResolvedValue({
            ok: true,
            path: "fixture",
            config: {},
            mcpServers: {},
          }),
          setMcpServer: vi.fn().mockResolvedValue({
            ok: true,
            path: "fixture",
            config: {},
            mcpServers: {},
          }),
        }),
      cronGateway: { add: vi.fn().mockResolvedValue({ id: "cron-1" }) },
    });
    expect(result).toMatchObject({
      status: "complete",
      workspaceFiles: [{ path: "reference/policy.md", status: "complete" }],
      mcpServers: [{ name: "sample", status: "complete" }],
      cronJobs: [{ manifestId: "morning", status: "complete", schedulerJobId: "cron-1" }],
    });
    const [prepare] = sql.calls;
    expect(
      prepare?.mock.calls.filter(
        ([statement]) =>
          /^\s*(?:insert|update|delete|replace)\b/i.test(String(statement)) &&
          /\b(?:claw_installs|claw_package_refs|claw_workspace_files|claw_mcp_server_refs|claw_cron_refs|workspace_setup_state)\b/i.test(
            String(statement),
          ),
      ),
    ).toEqual([]);
  } finally {
    sql.restore();
  }
});

it("seeds a package bootstrap without caller-thread SQLite", async () => {
  await writeFile(join(state.root, "BOOTSTRAP.md"), "Ask for the operator's first goal.\n");
  const { plan } = await makeProvenancePlan(state.root, {
    schemaVersion: 1,
    agent: { id: "worker" },
  });
  expect(plan.blockers).toEqual([]);
  const sql = observeMainThreadSql();
  try {
    const result = await applyClawAddPlan(plan, {
      env: state.env,
      stateMode: "worker",
      consentPlanIntegrity: plan.planIntegrity,
      commitConfig: async () => undefined,
    });
    expect(result.status).toBe("complete");
    sql.expectIdle();
  } finally {
    sql.restore();
  }
});

it("does not commit an agent after authority retires during an awaited bootstrap", async () => {
  const { plan } = await makeProvenancePlan(state.root, {
    schemaVersion: 1,
    agent: { id: "worker" },
  });
  let current = true;
  const commitConfig = vi.fn(async () => undefined);
  const result = await applyClawAddPlan(plan, {
    env: state.env,
    stateMode: "worker",
    consentPlanIntegrity: plan.planIntegrity,
    assertCurrent: () => {
      if (!current) {
        throw new Error("Claw Add authority retired");
      }
    },
    seedPackageBootstrap: async () => {
      await Promise.resolve();
      current = false;
      return undefined;
    },
    commitConfig,
  });
  expect(result.status).toBe("partial");
  expect(result.configCommitted).toBe(false);
  expect(result.error).toMatchObject({
    code: "config_commit_failed",
    message: "Claw Add authority retired",
  });
  expect(commitConfig).not.toHaveBeenCalled();
  expect(readClawInstallRecord("worker", { env: state.env })?.status).toBe("workspace_ready");
});

it.each(["transaction", "commit"] as const)(
  "rolls back Add provenance when authority retires at %s admission",
  async (stage) => {
    const { plan } = await makeProvenancePlan(state.root, {
      schemaVersion: 1,
      agent: { id: "worker" },
    });
    const originalAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
    let retired = false;
    vi.spyOn(workerAdmission, "createSqliteWorkerOperationAdmission").mockImplementation(
      (admit, attachment) =>
        originalAdmission((request, grant) => {
          retired ||= request.stage === stage;
          admit(request, grant);
        }, attachment),
    );
    const error = new Error("Claw Add authority retired");
    await expect(
      persistClawInstallRecordForAdd(plan, {
        env: state.env,
        stateMode: "worker",
        status: "pending",
        assertCurrent: () => {
          if (retired) {
            throw error;
          }
        },
      }),
    ).rejects.toBe(error);
    expect(retired).toBe(true);
    expect(readClawInstallRecord("worker", { env: state.env })).toBeUndefined();
  },
);
