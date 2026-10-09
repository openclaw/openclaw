import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stableStringify } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { commitPluginInstallRecordsWithConfig } from "../plugins/install-record-commit.js";
import { hasPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { readClawCronRefs } from "./cron.js";
import { readClawStatus } from "./lifecycle-status.js";
import { applyClawMigrationPlan, buildClawMigrationPlan } from "./migrate.js";
import { ClawPackageUpdateError } from "./package-update.js";
import { persistClawInstallRecord, readClawInstallRecord } from "./provenance.js";
import type { ClawAddPlan, ClawManifest, ClawOpenClawProfile } from "./types.js";
import { applyClawUpdatePlan } from "./update-apply.js";
import { addPlan, consent, install, manifest, plan, source } from "./update-apply.test-helpers.js";
import { buildClawUpdatePlan, type ClawUpdatePlan } from "./update-plan.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(closeOpenClawStateDatabaseForTest);

describe("applyClawUpdatePlan", () => {
  it("rejects consent that does not match the preview before rebuilding", async () => {
    const updatePlan = plan([]);
    const rebuildPlan = vi.fn();

    await expect(
      applyClawUpdatePlan(
        updatePlan,
        { targetManifest: manifest, targetSource: source },
        {
          config: {},
          sourceMcpServers: {},
          consentPlanIntegrity: "sha256:different-plan",
          rebuildPlan,
        },
      ),
    ).rejects.toMatchObject({ code: "plan_integrity_mismatch" });
    expect(rebuildPlan).not.toHaveBeenCalled();
  });

  it("activates cron only after owned state and agent updates succeed", async () => {
    const env = {
      OPENCLAW_STATE_DIR: join(tempDirs.make("openclaw-claw-update-roster-"), "state"),
    };
    const job: ClawManifest["cronJobs"][number] = {
      id: "daily",
      schedule: { cron: "0 9 * * *", timezone: "UTC" },
      session: "main",
      message: "Daily report",
    };
    const updatePlan = plan([
      {
        kind: "agent",
        id: "worker",
        action: "change",
        target: 'agents.entries["worker"]',
        blocked: false,
        reason: "restore agent",
      },
      {
        kind: "cronJob",
        id: job.id,
        action: "add",
        target: "claw:worker:daily",
        blocked: false,
        reason: "target adds cron job",
      },
    ]);
    const order: string[] = [];
    let config: OpenClawConfig = { agents: { entries: {} } };
    let runtimeConfig = config;
    const runtimeApplied = createDeferred();

    const update = applyClawUpdatePlan(
      updatePlan,
      { targetManifest: { ...manifest, cronJobs: [job] }, targetSource: source },
      {
        config,
        env,
        ...consent(updatePlan),
        rebuildPlan: vi.fn(async () => updatePlan),
        buildAddPlan: vi.fn(async () => addPlan),
        readInstall: vi.fn(() => install),
        applyWorkspace: vi.fn(async () => {
          order.push("workspace");
          return { appliedPaths: [], rollback: vi.fn(async () => undefined) };
        }),
        applyMcp: vi.fn(async () => {
          order.push("mcp");
          return { appliedNames: [], rollback: vi.fn(async () => undefined) };
        }),
        commitConfig: async (transform) => {
          order.push("agent");
          config = transform(config);
          setImmediate(() => {
            runtimeConfig = config;
            order.push("runtime");
            runtimeApplied.resolve();
          });
        },
        cronGateway: {
          waitUntilAgentAvailable: async (agentId) => {
            expect(agentId).toBe("worker");
            order.push("wait");
            await runtimeApplied.promise;
          },
          add: async () => {
            if (!runtimeConfig.agents?.entries?.worker) {
              throw new Error("cron job agent is unavailable: worker");
            }
            order.push("cron");
            return { id: "scheduler-daily" };
          },
          get: vi.fn(),
          remove: vi.fn(),
        },
        persistInstall: vi.fn(() => {
          order.push("provenance");
          return { ...install, claw: source };
        }),
      },
    );

    try {
      await expect(update).resolves.toMatchObject({ status: "complete" });
    } finally {
      await runtimeApplied.promise;
    }
    expect(order).toEqual(["workspace", "mcp", "agent", "wait", "runtime", "cron", "provenance"]);
    expect(readClawCronRefs("worker", { env })).toMatchObject([
      { manifestId: job.id, schedulerJobId: "scheduler-daily", status: "complete" },
    ]);
  });

  it("realizes new plugin requirements before workspace mutation and retains them on failure", async () => {
    const targetPackage = {
      kind: "plugin" as const,
      source: "clawhub" as const,
      ref: "github",
      version: "1.0.0",
    };
    const packageDetails = {
      ...targetPackage,
      integrity: "sha256:github",
      installId: "github",
      ownerAction: "install" as const,
    };
    const desiredDigest = `sha256:${createHash("sha256")
      .update(
        stableStringify({
          package: targetPackage,
          integrity: packageDetails.integrity,
          installId: packageDetails.installId,
          riskWarning: undefined,
          prerequisites: undefined,
          extension: undefined,
        }),
      )
      .digest("hex")}`;
    const updatePlan = plan([
      {
        kind: "package",
        id: "plugin:github",
        action: "add",
        target: "packages.plugin:github",
        blocked: false,
        reason: "target adds a shared plugin requirement",
        desiredDigest,
      },
    ]);
    const packageAddPlan: ClawAddPlan = {
      ...addPlan,
      actions: [
        {
          kind: "package",
          id: "plugin:github",
          action: "install",
          target: "clawhub:github@1.0.0",
          details: packageDetails,
          blocked: false,
        },
      ],
    };
    const order: string[] = [];
    const requirementRollback = vi.fn(async () => undefined);

    await expect(
      applyClawUpdatePlan(
        updatePlan,
        {
          targetManifest: { ...manifest, packages: [targetPackage] },
          targetSource: source,
        },
        {
          config: {},
          ...consent(updatePlan),
          rebuildPlan: vi.fn(async () => updatePlan),
          buildAddPlan: vi.fn(async () => packageAddPlan),
          readInstall: vi.fn(() => install),
          applyPackage: vi.fn(async (phase) => {
            order.push("requirement");
            expect(
              phase.actions.map((action: ClawAddPlan["actions"][number]) => action.id),
            ).toEqual(["plugin:github"]);
            return { appliedIds: ["plugin:github"], rollback: requirementRollback };
          }),
          applyWorkspace: vi.fn(async () => {
            order.push("workspace");
            throw new Error("workspace unavailable");
          }),
        },
      ),
    ).rejects.toMatchObject({
      code: "update_partial",
      message: expect.stringContaining("shared requirements were retained"),
    });

    expect(order).toEqual(["requirement", "workspace"]);
    expect(requirementRollback).not.toHaveBeenCalled();
  });

  it.each(["readiness", "mutation"] as const)(
    "rolls back known failures and preserves uncertain cron prerequisites: %s",
    async (failure) => {
      const root = tempDirs.make("openclaw-claw-update-apply-");
      const env = { OPENCLAW_STATE_DIR: join(root, "state") };
      const currentAddPlan: ClawAddPlan = {
        ...addPlan,
        claw: install.claw,
        planIntegrity: install.planIntegrity,
        agent: {
          ...addPlan.agent,
          config: { id: "worker", name: "Worker", workspace: addPlan.agent.workspace },
        },
      };
      const currentRecord = persistClawInstallRecord(currentAddPlan, { env, nowMs: 1 });
      const updatePlan = plan([
        {
          kind: "agent",
          id: "worker",
          action: "change",
          target: 'agents.entries["worker"]',
          blocked: false,
          reason: "restore agent",
        },
        {
          kind: "cronJob",
          id: "heartbeat",
          action: "add",
          target: "cronJobs.heartbeat",
          blocked: false,
          reason: "target adds cron job",
        },
      ]);
      let config: OpenClawConfig = { agents: { entries: {} } };
      const workspaceRollback = vi.fn(async () => undefined);
      const mcpRollback = vi.fn(async () => undefined);

      const add = vi.fn(async () => {
        throw new Error("cron transport closed");
      });
      const job: ClawManifest["cronJobs"][number] = {
        id: "heartbeat",
        schedule: { cron: "0 9 * * *", timezone: "UTC" },
        session: "main",
        message: "Heartbeat",
      };
      await expect(
        applyClawUpdatePlan(
          updatePlan,
          { targetManifest: { ...manifest, cronJobs: [job] }, targetSource: source },
          {
            config,
            env,
            ...consent(updatePlan),
            rebuildPlan: vi.fn(async () => updatePlan),
            buildAddPlan: vi.fn(async () => addPlan),
            applyWorkspace: vi.fn(async () => ({
              appliedPaths: [],
              rollback: workspaceRollback,
            })),
            applyMcp: vi.fn(async () => ({ appliedNames: [], rollback: mcpRollback })),
            commitConfig: async (transform) => {
              config = transform(config);
            },
            cronGateway: {
              add,
              get: vi.fn(),
              remove: vi.fn(),
              waitUntilAgentAvailable: async () => {
                expect(readClawCronRefs("worker", { env })).toEqual([]);
                if (failure === "readiness") {
                  throw new Error("agent not ready");
                }
              },
            },
          },
        ),
      ).rejects.toMatchObject({
        code: failure === "mutation" ? "update_partial" : "cron_update_failed",
      });

      if (failure === "readiness") {
        expect(readClawCronRefs("worker", { env })).toEqual([]);
        expect(add).not.toHaveBeenCalled();
        expect(config.agents?.entries?.worker).toBeUndefined();
        expect(readClawInstallRecord("worker", { env })).toEqual(currentRecord);
        expect(mcpRollback).toHaveBeenCalledOnce();
        expect(workspaceRollback).toHaveBeenCalledOnce();
        return;
      }
      expect(readClawCronRefs("worker", { env })).toMatchObject([
        { status: "pending", manifestId: "heartbeat" },
      ]);
      expect(add).toHaveBeenCalledOnce();

      const partialRecord = readClawInstallRecord("worker", { env });
      expect(config.agents?.entries?.worker).toEqual({
        name: "Worker v2",
        workspace: "/tmp/workspace-worker",
      });
      expect(partialRecord).toMatchObject({
        claw: { version: "2.0.0", integrity: "sha256:target" },
        planIntegrity: addPlan.planIntegrity,
        status: "partial",
      });
      expect(partialRecord?.agentConfigDigest).not.toBe(currentRecord.agentConfigDigest);
      expect(mcpRollback).not.toHaveBeenCalled();
      expect(workspaceRollback).not.toHaveBeenCalled();
    },
  );

  it("validates and applies profile extension package updates", async () => {
    const packageRoot = tempDirs.make("openclaw-claw-extension-update-");
    const targetSource = {
      ...source,
      packageRoot,
      manifestPath: join(packageRoot, "openclaw.claw.json"),
    };
    const extension = {
      id: "github-tools",
      kind: "plugin" as const,
      format: "claude" as const,
      source: "clawhub" as const,
      ref: "github",
      version: "2.0.0",
    };
    const extensionProvenance = {
      id: extension.id,
      format: extension.format,
      detectedFormat: "claude" as const,
      mapped: ["commands", "skills"],
      unavailable: ["agents"],
      adapterIdentity: "openclaw/current",
    };
    const targetPackage = {
      kind: extension.kind,
      source: extension.source,
      ref: extension.ref,
      version: extension.version,
    };
    const packageDetails = {
      ...targetPackage,
      integrity: `sha256:${"a".repeat(64)}`,
      installId: "github",
      riskWarning: "Review @acme/github before installation.",
      extension: extensionProvenance,
    };
    const desiredDigest = `sha256:${createHash("sha256")
      .update(
        stableStringify({
          package: targetPackage,
          integrity: packageDetails.integrity,
          installId: packageDetails.installId,
          riskWarning: packageDetails.riskWarning,
          prerequisites: undefined,
          extension: extensionProvenance,
        }),
      )
      .digest("hex")}`;
    const updatePlan = plan([
      {
        kind: "package",
        id: "plugin:github",
        action: "change",
        target: "clawhub:github@2.0.0",
        blocked: false,
        reason: "target profile changes the extension package",
        desiredDigest,
      },
    ]);
    const targetManifest: ClawManifest = {
      ...manifest,
      schemaVersion: 1,
      packages: [],
    };
    const targetOpenClawProfile: ClawOpenClawProfile = {
      schemaVersion: 1,
      agent: {},
      extensions: [extension],
    };
    const conflictPreflight = {
      ok: false as const,
      code: "plugin_version_conflict",
      message: "The Claw owns the installed previous version.",
      installedVersion: "1.0.0",
      integrity: packageDetails.integrity,
      installId: packageDetails.installId,
      warning: packageDetails.riskWarning,
      detectedFormat: extensionProvenance.detectedFormat,
      mapped: extensionProvenance.mapped,
      unavailable: extensionProvenance.unavailable,
      adapterIdentity: extensionProvenance.adapterIdentity,
    };
    const applyPackage = vi.fn(async (_update: ClawUpdatePlan, materialized: ClawAddPlan) => {
      expect(materialized.actions).toContainEqual(
        expect.objectContaining({
          kind: "package",
          id: "plugin:github",
          action: "install",
          blocked: false,
          details: expect.objectContaining({ ...packageDetails, ownerAction: "install" }),
        }),
      );
      return { appliedIds: ["plugin:github"], rollback: vi.fn(async () => undefined) };
    });

    await applyClawUpdatePlan(
      updatePlan,
      { targetManifest, targetOpenClawProfile, targetSource },
      {
        config: {},
        ...consent(updatePlan),
        rebuildPlan: vi.fn(async () => updatePlan),
        packagePreflight: vi.fn(async () => conflictPreflight),
        readInstall: vi.fn(() => install),
        persistInstall: vi.fn(() => ({ ...install, claw: source })),
        applyWorkspace: vi.fn(async () => ({
          appliedPaths: [],
          rollback: vi.fn(async () => undefined),
        })),
        applyMcp: vi.fn(async () => ({
          appliedNames: [],
          rollback: vi.fn(async () => undefined),
        })),
        applyCron: vi.fn(async () => ({
          appliedIds: [],
          rollback: vi.fn(async () => undefined),
        })),
        applyPackage,
      },
    );

    expect(applyPackage).toHaveBeenCalledOnce();
  });

  it.each([
    [
      "package",
      [
        "package artifact rollback is unavailable",
        "MCP rollback failed: MCP",
        "workspace rollback failed: workspace",
      ],
    ],
    [
      "provenance",
      [
        "agent rollback failed: agent",
        "package rollback incomplete: package",
        "cron rollback failed: cron",
        "MCP rollback failed: MCP",
        "workspace rollback failed: workspace",
      ],
    ],
  ] as const)("attempts every rollback after %s failure", async (stage, failures) => {
    const actions: ClawUpdatePlan["actions"] = [
      {
        kind: "workspaceFile",
        id: "SOUL.md",
        action: "change",
        target: "/tmp/workspace-worker/SOUL.md",
        blocked: false,
        reason: "target changed",
      },
      {
        kind: "package",
        id: "skill:legacy",
        action: "release",
        target: "packages.skill:legacy",
        blocked: false,
        reason: "target releases package ownership",
      },
      {
        kind: "agent",
        id: "worker",
        action: "change",
        target: 'agents.entries["worker"]',
        blocked: false,
        reason: "target changed",
      },
    ];
    const updatePlan = plan(actions);
    const env = { OPENCLAW_STATE_DIR: join(tempDirs.make("openclaw-claw-rollback-"), "state") };
    const failure =
      stage === "package"
        ? new ClawPackageUpdateError("package failed", true)
        : new Error("provenance race");
    const rollback = (name: string) => vi.fn<() => Promise<void>>().mockRejectedValue(name)();
    let mcpFinished = false;
    const mcpRollback = vi.fn(async () => {
      await Promise.resolve();
      mcpFinished = true;
      await rollback("MCP");
    });
    const workspaceRollback = vi.fn(async function (this: unknown) {
      expect(this).toBe(workspaceExecution);
      await rollback("workspace");
    });
    const workspaceExecution = {
      appliedPaths: ["SOUL.md"],
      get rollback() {
        expect(mcpFinished).toBe(true);
        return workspaceRollback;
      },
    };
    let config: OpenClawConfig = {};
    let commits = 0;

    await expect(
      applyClawUpdatePlan(
        updatePlan,
        { targetManifest: manifest, targetSource: source },
        {
          config,
          env,
          ...consent(updatePlan),
          rebuildPlan: vi.fn(async () => updatePlan),
          buildAddPlan: vi.fn(async () => addPlan),
          readInstall: vi.fn(() => install),
          applyWorkspace: vi.fn(async () => workspaceExecution),
          applyMcp: vi.fn(async () => ({ appliedNames: [], rollback: mcpRollback })),
          applyPackage: vi.fn(async () => {
            if (stage === "package") {
              throw failure;
            }
            return { appliedIds: ["skill:legacy"], rollback: () => rollback("package") };
          }),
          commitConfig: async (transform) => {
            config = transform(config);
            if (++commits > 1) {
              await rollback("agent");
            }
          },
          applyCron: vi.fn(async () => {
            return { appliedIds: [], rollback: () => rollback("cron") };
          }),
          persistInstall: vi.fn(() => {
            throw failure;
          }),
        },
      ),
    ).rejects.toMatchObject({
      code: "update_partial",
      message: [failure.message, ...failures].join("; "),
    });
    expect(commits).toBe(stage === "package" ? 0 : 2);
    expect(mcpRollback).toHaveBeenCalledOnce();
    expect(workspaceRollback).toHaveBeenCalledOnce();
  });

  it("restores the agent when the config commit throws after transforming state", async () => {
    const currentAgent = { id: "worker", name: "Worker" };
    const currentDigest = `sha256:${createHash("sha256").update(stableStringify(currentAgent)).digest("hex")}`;
    const updatePlan = plan([
      {
        kind: "agent",
        id: "worker",
        action: "change",
        target: 'agents.entries["worker"]',
        blocked: false,
        reason: "target changed",
        currentDigest,
      },
    ]);
    let config: OpenClawConfig = { agents: { entries: { worker: { name: "Worker" } } } };
    let commits = 0;

    await expect(
      applyClawUpdatePlan(
        updatePlan,
        { targetManifest: manifest, targetSource: source },
        {
          config,
          ...consent(updatePlan),
          rebuildPlan: vi.fn(async () => updatePlan),
          buildAddPlan: vi.fn(async () => addPlan),
          readInstall: vi.fn(() => install),
          commitConfig: async (transform) => {
            config = transform(config);
            commits += 1;
            if (commits === 1) {
              throw new Error("post-write failure");
            }
          },
        },
      ),
    ).rejects.toMatchObject({ code: "agent_update_failed" });
    expect(config.agents?.entries?.worker).toEqual({ name: "Worker" });
    expect(commits).toBe(2);
  });

  it("does not recreate an agent removed after planning", async () => {
    const currentAgent = { id: "worker", name: "Worker" };
    const currentDigest = `sha256:${createHash("sha256").update(stableStringify(currentAgent)).digest("hex")}`;
    const updatePlan = plan([
      {
        kind: "agent",
        id: "worker",
        action: "change",
        target: 'agents.entries["worker"]',
        blocked: false,
        reason: "target changed",
        currentDigest,
      },
    ]);
    let config: OpenClawConfig = { agents: { entries: {} } };

    await expect(
      applyClawUpdatePlan(
        updatePlan,
        { targetManifest: manifest, targetSource: source },
        {
          config,
          ...consent(updatePlan),
          rebuildPlan: vi.fn(async () => updatePlan),
          buildAddPlan: vi.fn(async () => addPlan),
          readInstall: vi.fn(() => install),
          commitConfig: async (transform) => {
            config = transform(config);
          },
        },
      ),
    ).rejects.toMatchObject({ code: "agent_changed" });
    expect(config.agents?.entries?.worker).toBeUndefined();
  });

  it("rejects setup requirements that changed after consent", async () => {
    const updatePlan = plan([]);
    const changed = {
      ...updatePlan,
      readiness: {
        ready: false,
        requirements: [
          {
            kind: "plugin-setup" as const,
            plugin: "market-data",
            provider: "market-data",
            envVars: ["MARKET_DATA_TOKEN"],
            authMethods: ["token"],
          },
        ],
      },
    };

    const readInstall = vi.fn(() => install);
    await expect(
      applyClawUpdatePlan(
        updatePlan,
        { targetManifest: manifest, targetSource: source },
        {
          config: {},
          ...consent(updatePlan),
          rebuildPlan: async () => changed,
          readInstall,
        },
      ),
    ).rejects.toMatchObject({ code: "update_changed" });
    expect(readInstall).not.toHaveBeenCalled();
  });

  it("rejects changed capability consent or a manually blocked plan", async () => {
    const updatePlan = plan([]);
    const changed = {
      ...updatePlan,
      capabilityChanges: [
        {
          kind: "mcpServer" as const,
          id: "search",
          path: "mcpServers.search",
          action: "add" as const,
          classification: "escalation" as const,
          requiresDistinctConsent: true,
          reason: "target adds an MCP execution surface",
          effect: { transport: "stdio", command: "npx", args: ["search-server"] },
          desired: { summary: "stdio:npx search-server", digest: "sha256:capability" },
        },
      ],
    };
    const readInstall = vi.fn(() => install);
    await expect(
      applyClawUpdatePlan(
        updatePlan,
        { targetManifest: manifest, targetSource: source },
        {
          config: {},
          ...consent(updatePlan),
          rebuildPlan: vi.fn(async () => changed),
          readInstall,
        },
      ),
    ).rejects.toMatchObject({ code: "update_changed" });
    expect(readInstall).not.toHaveBeenCalled();

    await expect(
      applyClawUpdatePlan(
        {
          ...updatePlan,
          actions: [
            {
              kind: "agent",
              id: "worker",
              action: "manual",
              target: "agent",
              blocked: true,
              reason: "drift",
            },
          ],
        },
        { targetManifest: manifest, targetSource: source },
        { config: {}, ...consent(updatePlan), readInstall },
      ),
    ).rejects.toMatchObject({ code: "update_blocked" });
  });
});

async function adoptedFixture() {
  const root = tempDirs.make("openclaw-adopted-update-");
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const env = { OPENCLAW_STATE_DIR: join(root, "state") };
  const config: OpenClawConfig = {
    agents: {
      defaults: { model: "provider/inherited" },
      entries: { worker: { name: "Worker", workspace: `${workspace}/.` } },
    },
  };
  const migration = await buildClawMigrationPlan({
    agentId: "worker",
    config,
    options: { env },
  });
  await applyClawMigrationPlan({ migration, config, options: { env } });
  const target = {
    targetManifest: {
      ...migration.manifest,
      agent: { ...migration.manifest.agent, name: "Worker v2" },
    },
    // The updated package continues to inherit the host model.
    targetOpenClawProfile: { schemaVersion: 1 as const, agent: {} },
    targetSource: { ...migration.addPlan.claw, version: "2.0.0", integrity: "sha256:updated" },
  };
  const updatePlan = await buildClawUpdatePlan({
    agentId: "worker",
    ...target,
    config,
    sourceMcpServers: {},
    stateOptions: { env },
  });
  expect(updatePlan.blockers).toEqual([]);
  expect(updatePlan.actions).toContainEqual(
    expect.objectContaining({ kind: "agent", action: "change", blocked: false }),
  );
  return { config, env, plan: updatePlan, target, workspace: migration.plan.workspace };
}

describe("updating an adopted agent", () => {
  it("updates a present agent with inherited settings and keeps status consistent", async () => {
    const current = await adoptedFixture();
    let config = current.config;

    await expect(
      applyClawUpdatePlan(current.plan, current.target, {
        config,
        env: current.env,
        sourceMcpServers: {},
        consentPlanIntegrity: current.plan.planIntegrity,
        commitConfig: async (transform) => {
          config = transform(config);
        },
      }),
    ).resolves.toMatchObject({ status: "complete", installRecord: { agentOrigin: "adopted" } });

    expect(config.agents?.entries?.worker).toEqual({
      name: "Worker v2",
      workspace: current.workspace,
    });
    expect(config.agents?.defaults).toEqual(current.config.agents?.defaults);
    await expect(
      readClawStatus("worker", { config, env: current.env, sourceMcpServers: {} }),
    ).resolves.toMatchObject({ records: [{ agentState: "present" }] });
  });

  it("preserves operator changes made before adopted-agent rollback", async () => {
    const current = await adoptedFixture();
    let config = current.config;
    let reachedCron = false;
    await expect(
      applyClawUpdatePlan(current.plan, current.target, {
        config,
        env: current.env,
        sourceMcpServers: {},
        consentPlanIntegrity: current.plan.planIntegrity,
        commitConfig: async (transform) => {
          config = transform(config);
        },
        applyCron: async () => {
          reachedCron = true;
          expect(config.agents?.entries?.worker?.name).toBe("Worker v2");
          config = {
            ...config,
            agents: { ...config.agents, defaults: { model: "provider/operator-change" } },
          };
          throw new Error("cron unavailable");
        },
      }),
    ).rejects.toMatchObject({ code: "update_partial" });
    expect(reachedCron).toBe(true);
    expect(config.agents?.defaults?.model).toBe("provider/operator-change");
    expect(config.agents?.entries?.worker?.name).toBe("Worker v2");
    expect(readClawInstallRecord("worker", { env: current.env })?.status).toBe("partial");
  });
});

it.each(["partial", "rejected"] as const)(
  "settles unchanged requirements before later update phases: %s",
  async (outcome) => {
    const root = tempDirs.make("claw-update-resume-");
    const env = {
      OPENCLAW_STATE_DIR: root,
      OPENCLAW_CONFIG_PATH: join(root, "openclaw.json"),
    };
    await writeFile(env.OPENCLAW_CONFIG_PATH, "{}");
    await withEnvAsync(env, async () => {
      await commitPluginInstallRecordsWithConfig({
        previousInstallRecords: {},
        nextInstallRecords: {
          fixture: { source: "clawhub", clawhubPackage: "fixture", version: "1" },
        },
        nextConfig: {},
        writeOptions: { afterWrite: { mode: "none", reason: "resume fixture" } },
      });
      const pkg = {
        kind: "plugin" as const,
        source: "clawhub" as const,
        ref: "fixture",
        version: "1",
      };
      const updatePlan = plan([
        {
          kind: "package",
          id: "plugin:fixture",
          action: "unchanged",
          target: "clawhub:fixture@1",
          blocked: false,
          reason: "same requirement",
        },
      ]);
      const applyWorkspace = vi.fn(async () => ({ appliedPaths: [], rollback: async () => {} }));
      const applyPackage = vi.fn();
      const reloadPlugins = vi.fn(async (targets: readonly { pluginId: string }[]) => {
        expect(hasPluginLifecycleLease()).toBe(false);
        expect(applyWorkspace).not.toHaveBeenCalled();
        expect(targets.map((target) => target.pluginId)).toEqual(["fixture"]);
        if (outcome === "rejected") {
          throw new Error("Gateway unavailable");
        }
        return { operationId: "resume", generation: 3, pluginIds: ["fixture"] };
      });
      const pending = applyClawUpdatePlan(
        updatePlan,
        { targetManifest: { ...manifest, packages: [pkg] }, targetSource: source },
        {
          env,
          config: {},
          ...consent(updatePlan),
          reloadPlugins,
          runtime: {
            log: () => {},
            error: () => {},
            exit: () => {
              throw new Error("unexpected exit");
            },
          },
          rebuildPlan: async () => updatePlan,
          readInstall: () => ({
            ...install,
            status: "partial",
          }),
          buildAddPlan: async () => ({
            ...addPlan,
            actions: [
              {
                kind: "package",
                id: "plugin:fixture",
                action: "install",
                target: "clawhub:fixture@1",
                blocked: false,
                details: { ...pkg, installId: "fixture", ownerAction: "reuse" },
              },
            ],
          }),
          applyWorkspace,
          applyPackage,
          applyMcp: async () => ({ appliedNames: [], rollback: async () => {} }),
          applyCron: async () => ({ appliedIds: [], rollback: async () => {} }),
          persistInstall: () => ({ ...install, status: "complete" }),
        },
      );
      if (outcome === "rejected") {
        await expect(pending).rejects.toMatchObject({
          code: "update_partial",
          message: expect.stringContaining("Runtime activation was not confirmed"),
        });
        expect(applyWorkspace).not.toHaveBeenCalled();
      } else {
        await expect(pending).resolves.toMatchObject({ status: "complete" });
        expect(applyWorkspace).toHaveBeenCalledOnce();
      }
      expect(reloadPlugins).toHaveBeenCalledOnce();
      expect(applyPackage).not.toHaveBeenCalled();
    });
  },
);
