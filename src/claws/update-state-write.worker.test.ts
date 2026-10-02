import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as workerAdmission from "../infra/sqlite-worker-operation-admission.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { persistClawInstallRecordForAdd } from "./add-state-write.js";
import { applyClawAddPlan } from "./add.js";
import { bindClawPluginInstallConsent } from "./gateway-plugin-consent.js";
import { readClawInventory } from "./inventory-read.js";
import { applyClawPackageUpdate } from "./package-update.js";
import type { installClawPackages } from "./packages.js";
import { projectClawPluginCapabilityReviews } from "./plugin-capability-review.js";
import { persistClawPackageRef } from "./provenance.js";
import { makeProvenancePlan } from "./provenance.test-helpers.js";
import { parseClawManifest } from "./schema.js";
import type { ResolvedClawPackage } from "./types.js";
import { applyClawUpdatePlan } from "./update-apply.js";
import { plan as updatePlan } from "./update-apply.test-helpers.js";
import { buildClawUpdatePlan } from "./update-plan.js";
import {
  deleteClawCronRefForUpdate,
  deleteClawMcpRefForUpdate,
  deleteClawWorkspaceFileForUpdate,
  persistClawInstallRecordForUpdate,
  readClawCronRefsForUpdate,
  readClawInstallRecordForUpdate,
  readClawMcpRefsForUpdate,
  readClawPackageRefsForUpdate,
  readClawWorkspaceFilesForUpdate,
  replaceClawPackageRefForUpdate,
  upsertClawCronRefForUpdate,
  upsertClawMcpRefForUpdate,
  upsertClawWorkspaceFileForUpdate,
} from "./update-state-write.js";

let state: OpenClawTestState;
beforeEach(async () => {
  state = await createOpenClawTestState({ layout: "state-only", prefix: "claw-update-state-" });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawStateDatabaseAsync();
  await state.cleanup();
});

it("advances the install record through the worker without caller-thread SQL", async () => {
  const { plan } = await makeProvenancePlan(state.root, {
    schemaVersion: 1,
    agent: { id: "worker" },
  });
  await persistClawInstallRecordForAdd(plan, { env: state.env, stateMode: "worker" });
  const target = {
    ...plan,
    claw: { ...plan.claw, version: "2.0.0", integrity: "sha256:target" },
  };
  const sql = observeMainThreadSql();
  try {
    const updated = await persistClawInstallRecordForUpdate(target, {
      env: state.env,
      stateMode: "worker",
      expectedClaw: { version: "1.0.0", integrity: "sha256:manifest" },
    });
    expect(updated).toMatchObject({ claw: { version: "2.0.0" }, status: "complete" });
    expect(
      await readClawInstallRecordForUpdate("worker", {
        env: state.env,
        stateMode: "worker",
      }),
    ).toEqual(updated);
    sql.expectIdle();
  } finally {
    sql.restore();
  }
});

it("applies a real Update plan through the worker without caller-thread lifecycle SQL", async () => {
  await writeFile(join(state.root, "policy.md"), "Original policy.\n");
  await writeFile(join(state.root, "policy-v2.md"), "Updated policy.\n");
  const { plan: addPlan } = await makeProvenancePlan(state.root, {
    schemaVersion: 1,
    agent: { id: "worker", name: "Worker" },
    workspace: { files: [{ source: "policy.md", path: "policy.md" }] },
  });
  let config: OpenClawConfig = {};
  const commitConfig = async (transform: (current: OpenClawConfig) => OpenClawConfig) => {
    config = transform(config);
  };
  expect(
    await applyClawAddPlan(addPlan, {
      env: state.env,
      stateMode: "worker",
      consentPlanIntegrity: addPlan.planIntegrity,
      config,
      commitConfig,
    }),
  ).toMatchObject({ status: "complete" });
  config.agents!.entries!.worker!.model = { primary: "acme/operator" };
  const parsed = parseClawManifest({
    schemaVersion: 1,
    agent: { id: "worker", name: "Worker v2" },
    workspace: { files: [{ source: "policy-v2.md", path: "policy.md" }] },
  });
  if (!parsed.ok) {
    throw new Error(JSON.stringify(parsed.diagnostics));
  }
  const targetSource = {
    ...addPlan.claw,
    version: "2.0.0",
    integrity: "sha256:target",
  };
  const plan = await buildClawUpdatePlan({
    agentId: "worker",
    targetManifest: parsed.manifest,
    targetSource,
    config,
    sourceMcpServers: {},
    inventory: await readClawInventory({ env: state.env }),
    exactAgentId: true,
    stateOptions: { env: state.env, readOnly: true },
  });
  expect(plan.blockers).toEqual([]);

  const sql = observeMainThreadSql();
  try {
    const result = await applyClawUpdatePlan(
      plan,
      { targetManifest: parsed.manifest, targetSource },
      {
        env: state.env,
        stateMode: "worker",
        config,
        sourceMcpServers: {},
        consentPlanIntegrity: plan.planIntegrity,
        commitConfig,
      },
    );
    expect(result).toMatchObject({
      status: "complete",
      targetClaw: { version: "2.0.0" },
      installRecord: { claw: { version: "2.0.0" }, status: "complete" },
    });
    expect(config.agents?.entries?.worker).toMatchObject({
      name: "Worker v2",
      model: { primary: "acme/operator" },
    });
    expect(await readFile(join(addPlan.agent.workspace, "policy.md"), "utf8")).toBe(
      "Updated policy.\n",
    );
    sql.expectIdle();
  } finally {
    sql.restore();
  }
});

it("changes package, workspace, MCP, and cron references on the shared worker", async () => {
  const { plan } = await makeProvenancePlan(state.root, {
    schemaVersion: 1,
    agent: { id: "worker" },
  });
  await persistClawInstallRecordForAdd(plan, { env: state.env, stateMode: "worker" });
  const options = { env: state.env, stateMode: "worker" as const };
  const previous = persistClawPackageRef(
    plan,
    {
      kind: "skill",
      source: "clawhub",
      ref: "@openclaw/sample",
      version: "1.0.0",
      integrity: `sha256:${"a".repeat(64)}`,
    },
    { env: state.env, status: "complete" },
  );
  const next = { ...previous, version: "2.0.0", updatedAtMs: previous.updatedAtMs + 1 };
  const workspace = {
    schemaVersion: "openclaw.clawWorkspaceFileRecord.v1" as const,
    agentId: "worker",
    workspace: plan.agent.workspace,
    path: "AGENTS.md",
    sourcePath: "AGENTS.md",
    contentDigest: `sha256:${"b".repeat(64)}`,
    status: "complete" as const,
    createdAtMs: 1_000,
    updatedAtMs: 1_000,
  };
  const mcp = {
    schemaVersion: "openclaw.clawMcpServerRef.v1" as const,
    agentId: "worker",
    name: "sample",
    configDigest: `sha256:${"c".repeat(64)}`,
    relationship: "managed" as const,
    origin: "claw-introduced" as const,
    independentOwner: false,
    status: "complete" as const,
    createdAtMs: 1_000,
    updatedAtMs: 1_000,
  };
  const cron = {
    schemaVersion: "openclaw.clawCronRef.v1" as const,
    agentId: "worker",
    manifestId: "daily",
    declarationKey: "claw:worker:daily",
    schedulerJobId: "cron-1",
    status: "complete" as const,
    job: {
      id: "daily",
      schedule: { cron: "0 9 * * *", timezone: "UTC" },
      session: "main" as const,
      message: "Hi",
    },
    createdAtMs: 1_000,
    updatedAtMs: 1_000,
  };
  const sql = observeMainThreadSql();
  try {
    await replaceClawPackageRefForUpdate(previous, next, options);
    await upsertClawWorkspaceFileForUpdate(workspace, options);
    await upsertClawMcpRefForUpdate(mcp, options);
    await upsertClawCronRefForUpdate(cron, options);
    expect(await readClawPackageRefsForUpdate({ ...options, agentId: "worker" })).toEqual([next]);
    expect(await readClawWorkspaceFilesForUpdate("worker", options)).toEqual([workspace]);
    expect(await readClawMcpRefsForUpdate("worker", options)).toEqual([mcp]);
    expect(await readClawCronRefsForUpdate("worker", options)).toEqual([cron]);
    await deleteClawWorkspaceFileForUpdate("worker", "AGENTS.md", options);
    await deleteClawMcpRefForUpdate("worker", "sample", options);
    await deleteClawCronRefForUpdate("worker", "daily", options);
    expect(await readClawWorkspaceFilesForUpdate("worker", options)).toEqual([]);
    expect(await readClawMcpRefsForUpdate("worker", options)).toEqual([]);
    expect(await readClawCronRefsForUpdate("worker", options)).toEqual([]);
    sql.expectIdle();
  } finally {
    sql.restore();
  }
});

it("uses async installer callbacks to complete a package Update through the worker", async () => {
  const { plan: addPlan } = await makeProvenancePlan(state.root, {
    schemaVersion: 1,
    agent: { id: "worker" },
  });
  await persistClawInstallRecordForAdd(addPlan, { env: state.env, stateMode: "worker" });
  const resolvedPackage: ResolvedClawPackage & { ownerAction: "install" } = {
    kind: "skill",
    source: "clawhub",
    ref: "@openclaw/triage",
    version: "1.0.0",
    integrity: `sha256:${"a".repeat(64)}`,
    ownerAction: "install",
  };
  const packageAction = {
    kind: "package" as const,
    id: "skill:@openclaw/triage",
    action: "install" as const,
    target: "clawhub:@openclaw/triage@1.0.0",
    details: resolvedPackage,
    blocked: false,
  };
  const installPackages = vi.fn(
    async (
      plan: Parameters<typeof installClawPackages>[0],
      options: Parameters<typeof installClawPackages>[1],
    ) => {
      const pending = await options?.deps?.persistPackageRef?.(plan, resolvedPackage, {
        status: "pending",
      });
      if (!pending) {
        throw new Error("missing package provenance adapter");
      }
      const complete = await options?.deps?.completePackageRef?.(pending, "complete");
      if (!complete) {
        throw new Error("missing package completion adapter");
      }
      return [complete];
    },
  );
  const sql = observeMainThreadSql();
  try {
    const execution = await applyClawPackageUpdate(
      updatePlan([
        {
          kind: "package",
          id: packageAction.id,
          action: "add",
          target: packageAction.target,
          blocked: false,
          reason: "target adds skill",
        },
      ]),
      { ...addPlan, actions: [packageAction] },
      { env: state.env, stateMode: "worker", installPackages },
    );
    expect(execution.appliedIds).toEqual([packageAction.id]);
    expect(installPackages).toHaveBeenCalledOnce();
    expect(
      await readClawPackageRefsForUpdate({
        env: state.env,
        stateMode: "worker",
        agentId: "worker",
      }),
    ).toMatchObject([{ ref: "@openclaw/triage", status: "complete" }]);
    sql.expectIdle();
  } finally {
    sql.restore();
  }
});

it("binds reviewed plugin grants during a worker-backed package Update", async () => {
  const { plan: addPlan } = await makeProvenancePlan(state.root, {
    schemaVersion: 1,
    agent: { id: "worker" },
  });
  await persistClawInstallRecordForAdd(addPlan, { env: state.env, stateMode: "worker" });
  const declaredCapabilities = {
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
  };
  const capabilityGrants = {
    hooks: {
      allowPromptInjection: { effective: false },
      allowConversationAccess: { effective: false },
    },
  };
  const resolvedPackage = {
    kind: "plugin" as const,
    source: "clawhub" as const,
    ref: "@openclaw/workflow-operator-plugin",
    version: "1.0.0",
    integrity: `sha256:${"a".repeat(64)}`,
    installId: "workflow-operator-plugin",
    ownerAction: "install" as const,
    declaredCapabilities,
    capabilityGrants,
  };
  const packageAction = {
    kind: "package" as const,
    id: "plugin:@openclaw/workflow-operator-plugin",
    action: "install" as const,
    target: "clawhub:@openclaw/workflow-operator-plugin@1.0.0",
    details: resolvedPackage,
    blocked: false,
  };
  const targetAddPlan = { ...addPlan, actions: [packageAction] };
  const [review] = projectClawPluginCapabilityReviews(targetAddPlan);
  if (!review) {
    throw new Error("Expected the plugin capability review.");
  }
  let authorized = true;
  const pluginConsent = bindClawPluginInstallConsent(
    [review],
    [
      {
        actionId: review.actionId,
        pluginId: review.pluginId,
        reviewToken: review.reviewToken,
        capabilityGrants: review.capabilityGrants,
      },
    ],
    () => {
      if (!authorized) {
        throw new Error("Claw Update authority expired.");
      }
    },
  );
  const installPackages = vi.fn(
    async (
      plan: Parameters<typeof installClawPackages>[0],
      options: Parameters<typeof installClawPackages>[1],
    ) => {
      expect(options?.pluginInstallMode).toBe("install");
      expect(await options?.pluginConsent?.confirmInstall?.()).toBe(true);
      const acknowledged = await options?.pluginConsent?.onCapabilityConsent({
        pluginId: review.pluginId,
        reviewToken: review.reviewToken,
        grants: review.capabilityGrants,
      } as Parameters<NonNullable<typeof pluginConsent>["onCapabilityConsent"]>[0]);
      expect(acknowledged).toEqual({ reviewToken: review.reviewToken });
      const pending = await options?.deps?.persistPackageRef?.(plan, resolvedPackage, {
        status: "pending",
      });
      if (!pending) {
        throw new Error("missing plugin provenance adapter");
      }
      const complete = await options?.deps?.completePackageRef?.(pending, "complete");
      if (!complete) {
        throw new Error("missing plugin completion adapter");
      }
      return [complete];
    },
  );
  const sql = observeMainThreadSql();
  try {
    const execution = await applyClawPackageUpdate(
      updatePlan([
        {
          kind: "package",
          id: packageAction.id,
          action: "add",
          target: packageAction.target,
          blocked: false,
          reason: "target adds plugin",
        },
      ]),
      targetAddPlan,
      { env: state.env, stateMode: "worker", installPackages, pluginConsent },
    );
    expect(execution.appliedIds).toEqual([packageAction.id]);
    expect(
      await readClawPackageRefsForUpdate({
        env: state.env,
        stateMode: "worker",
        agentId: "worker",
      }),
    ).toMatchObject([{ kind: "plugin", ref: resolvedPackage.ref, status: "complete" }]);
    sql.expectIdle();
  } finally {
    sql.restore();
  }
  authorized = false;
  await expect(pluginConsent?.confirmInstall?.()).rejects.toThrow("authority expired");
});

it.each(["transaction", "commit"] as const)(
  "rolls back an Update reference write when authority retires at %s admission",
  async (stage) => {
    const { plan } = await makeProvenancePlan(state.root, {
      schemaVersion: 1,
      agent: { id: "worker" },
    });
    await persistClawInstallRecordForAdd(plan, { env: state.env, stateMode: "worker" });
    const originalAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
    let retired = false;
    vi.spyOn(workerAdmission, "createSqliteWorkerOperationAdmission").mockImplementation(
      (listener) =>
        originalAdmission((request, grant) => {
          if (request.stage === stage) {
            retired = true;
          }
          listener(request, grant);
        }),
    );
    const ref = {
      schemaVersion: "openclaw.clawWorkspaceFileRecord.v1" as const,
      agentId: "worker",
      workspace: plan.agent.workspace,
      path: "AGENTS.md",
      sourcePath: "AGENTS.md",
      contentDigest: `sha256:${"b".repeat(64)}`,
      status: "complete" as const,
      createdAtMs: 1_000,
      updatedAtMs: 1_000,
    };
    await expect(
      upsertClawWorkspaceFileForUpdate(ref, {
        env: state.env,
        stateMode: "worker",
        assertCurrent: () => {
          if (retired) {
            throw new Error("Claw Update authority retired");
          }
        },
      }),
    ).rejects.toThrow("Claw Update authority retired");
    expect(
      await readClawWorkspaceFilesForUpdate("worker", {
        env: state.env,
        stateMode: "worker",
      }),
    ).toEqual([]);
  },
);
