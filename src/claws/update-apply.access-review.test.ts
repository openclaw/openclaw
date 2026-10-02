import { createHash } from "node:crypto";
import { stableStringify } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyConfigOverrides,
  resetConfigOverrides,
  setConfigOverride,
} from "../config/runtime-overrides.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { applyClawCronUpdate } from "./cron-update.js";
import { emptyPluginPlanEvidence } from "./packages.test-support.js";
import type { ClawAddPlan, ClawCronJob } from "./types.js";
import { applyClawUpdatePlan, ClawUpdateMutationError } from "./update-apply.js";
import { addPlan, consent, install, manifest, plan, source } from "./update-apply.test-helpers.js";

afterEach(async () => {
  resetConfigOverrides();
  await closeOpenClawStateDatabaseForTest();
});

describe("applyClawUpdatePlan reviewed access", () => {
  it("compares the runtime-shaped snapshot while writing source config", async () => {
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
    const sourceConfig: OpenClawConfig = {
      agents: { entries: { worker: { name: "Worker" } } },
    };
    const runtimeConfig: OpenClawConfig = {
      ...sourceConfig,
      agents: {
        ...sourceConfig.agents,
        entries: { worker: { name: "Worker", heartbeat: { every: "30m" } } },
      },
    };
    const assertReviewedConfig = vi.fn((current: OpenClawConfig) => {
      if (current.agents?.entries?.worker?.heartbeat?.every !== "30m") {
        throw new ClawUpdateMutationError(
          "reviewed_access_changed",
          "The effective Claw access changed since review. Preview it again.",
        );
      }
    });
    let writtenConfig: OpenClawConfig | undefined;

    await expect(
      applyClawUpdatePlan(
        updatePlan,
        { targetManifest: manifest, targetSource: source },
        {
          config: runtimeConfig,
          ...consent(updatePlan),
          getCurrentConfig: () => runtimeConfig,
          assertReviewedConfig,
          rebuildPlan: vi.fn(async () => updatePlan),
          buildAddPlan: vi.fn(async () => addPlan),
          readInstall: vi.fn(() => install),
          applyWorkspace: vi.fn(async () => ({ appliedPaths: [], rollback: vi.fn() })),
          applyMcp: vi.fn(async () => ({ appliedNames: [], rollback: vi.fn() })),
          commitConfig: async (transform) => {
            writtenConfig = transform(sourceConfig, runtimeConfig);
          },
          persistInstall: vi.fn(() => ({ ...install, claw: source })),
        },
      ),
    ).resolves.toMatchObject({ status: "complete" });

    expect(assertReviewedConfig).toHaveBeenCalledWith(runtimeConfig, addPlan.agent.config);
    expect(writtenConfig?.agents?.entries?.worker?.heartbeat).toBeUndefined();
  });

  it("compares active runtime overrides without persisting them", async () => {
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
    const sourceConfig: OpenClawConfig = {
      agents: { entries: { worker: { name: "Worker" } } },
    };
    expect(setConfigOverride("tools.deny", ["web_fetch"]).ok).toBe(true);
    const effectiveRuntimeConfig = applyConfigOverrides(sourceConfig);
    const assertReviewedConfig = vi.fn((current: OpenClawConfig) => {
      if (!current.tools?.deny?.includes("web_fetch")) {
        throw new ClawUpdateMutationError(
          "reviewed_access_changed",
          "The effective Claw access changed since review. Preview it again.",
        );
      }
    });
    let writtenConfig: OpenClawConfig | undefined;

    await expect(
      applyClawUpdatePlan(
        updatePlan,
        { targetManifest: manifest, targetSource: source },
        {
          config: effectiveRuntimeConfig,
          ...consent(updatePlan),
          getCurrentConfig: () => effectiveRuntimeConfig,
          assertReviewedConfig,
          rebuildPlan: vi.fn(async () => updatePlan),
          buildAddPlan: vi.fn(async () => addPlan),
          readInstall: vi.fn(() => install),
          applyWorkspace: vi.fn(async () => ({ appliedPaths: [], rollback: vi.fn() })),
          applyMcp: vi.fn(async () => ({ appliedNames: [], rollback: vi.fn() })),
          commitConfig: async (transform) => {
            writtenConfig = transform(sourceConfig, sourceConfig);
          },
          persistInstall: vi.fn(() => ({ ...install, claw: source })),
        },
      ),
    ).resolves.toMatchObject({ status: "complete" });

    expect(assertReviewedConfig).toHaveBeenCalledWith(effectiveRuntimeConfig, addPlan.agent.config);
    expect(writtenConfig?.tools).toBeUndefined();
  });

  it("rejects access drift after the agent commit before activating schedules", async () => {
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
    const applyCron = vi.fn(async () => ({ appliedIds: [], rollback: vi.fn() }));
    const persistInstall = vi.fn(() => ({ ...install, claw: source }));
    const assertReviewedConfig = vi.fn(
      (current: OpenClawConfig, _desired: unknown, phase?: string) => {
        if (phase === "after-agent-commit" && current.tools?.deny?.includes("web_fetch")) {
          throw new ClawUpdateMutationError(
            "reviewed_access_changed",
            "The effective Claw access changed since review. Preview it again.",
          );
        }
      },
    );

    await expect(
      applyClawUpdatePlan(
        updatePlan,
        { targetManifest: manifest, targetSource: source },
        {
          config,
          ...consent(updatePlan),
          getCurrentConfig: () => config,
          assertReviewedConfig,
          rebuildPlan: vi.fn(async () => updatePlan),
          buildAddPlan: vi.fn(async () => addPlan),
          readInstall: vi.fn(() => install),
          applyWorkspace: vi.fn(async () => ({ appliedPaths: [], rollback: vi.fn() })),
          applyMcp: vi.fn(async () => ({ appliedNames: [], rollback: vi.fn() })),
          commitConfig: async (transform) => {
            config = transform(config, config);
            if (config.agents?.entries?.worker?.name === "Worker v2") {
              config = { ...config, tools: { deny: ["web_fetch"] } };
            }
          },
          applyCron,
          persistInstall,
        },
      ),
    ).rejects.toMatchObject({ code: "reviewed_access_changed" });

    expect(applyCron).not.toHaveBeenCalled();
    expect(persistInstall).not.toHaveBeenCalled();
    expect(config.agents?.entries?.worker).toEqual({ name: "Worker" });
  });

  it("rechecks access after async schedule preparation before activating a job", async () => {
    const job: ClawCronJob = {
      id: "daily",
      schedule: { cron: "0 9 * * *", timezone: "UTC" },
      session: "main",
      message: "Daily update",
    };
    const updatePlan = plan([
      {
        kind: "cronJob",
        id: job.id,
        action: "add",
        target: "claw:worker:daily",
        blocked: false,
        reason: "target declaration",
      },
    ]);
    let config: OpenClawConfig = { agents: { entries: { worker: { name: "Worker" } } } };
    const add = vi.fn(async () => ({ id: "scheduler-daily" }));
    const remove = vi.fn(async () => ({ removed: true }));
    const upsertRef = vi.fn(async () => undefined);
    const persistInstall = vi.fn(() => ({ ...install, claw: source }));

    await expect(
      applyClawUpdatePlan(
        updatePlan,
        { targetManifest: { ...manifest, cronJobs: [job] }, targetSource: source },
        {
          config,
          ...consent(updatePlan),
          getCurrentConfig: () => config,
          assertReviewedConfig: (current) => {
            if (!current.tools?.deny?.includes("web_fetch")) {
              return;
            }
            throw new ClawUpdateMutationError(
              "reviewed_access_changed",
              "The effective Claw access changed since review. Preview it again.",
            );
          },
          rebuildPlan: vi.fn(async () => updatePlan),
          buildAddPlan: vi.fn(async () => addPlan),
          readInstall: vi.fn(() => install),
          applyWorkspace: vi.fn(async () => ({ appliedPaths: [], rollback: vi.fn() })),
          applyMcp: vi.fn(async () => ({ appliedNames: [], rollback: vi.fn() })),
          applyCron: (fresh, target, options) =>
            applyClawCronUpdate(fresh, target, {
              ...options,
              readRefs: async () => {
                config = { ...config, tools: { deny: ["web_fetch"] } };
                return [];
              },
              upsertRef,
              deleteRef: vi.fn(async () => undefined),
              cronGateway: { add, remove, get: vi.fn(async () => undefined) },
            }),
          persistInstall,
        },
      ),
    ).rejects.toMatchObject({ code: "cron_update_failed" });

    expect(upsertRef).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(persistInstall).not.toHaveBeenCalled();
  });

  it("rejects effective access drift at the final config write and rolls back earlier work", async () => {
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
    const workspaceRollback = vi.fn(async () => undefined);
    const mcpRollback = vi.fn(async () => undefined);
    const persistInstall = vi.fn(() => ({ ...install, claw: source }));
    const assertReviewedConfig = vi.fn((current: OpenClawConfig) => {
      if (current.tools?.deny?.includes("web_fetch")) {
        throw new ClawUpdateMutationError(
          "reviewed_access_changed",
          "The effective Claw access changed since review. Preview it again.",
        );
      }
    });

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
          applyWorkspace: vi.fn(async () => {
            config = { ...config, tools: { deny: ["web_fetch"] } };
            return { appliedPaths: [], rollback: workspaceRollback };
          }),
          applyMcp: vi.fn(async () => ({ appliedNames: [], rollback: mcpRollback })),
          commitConfig: async (transform) => {
            config = transform(config, config);
          },
          assertReviewedConfig,
          persistInstall,
        },
      ),
    ).rejects.toMatchObject({ code: "reviewed_access_changed" });

    expect(assertReviewedConfig).toHaveBeenCalledWith(
      expect.objectContaining({ tools: { deny: ["web_fetch"] } }),
      addPlan.agent.config,
    );
    expect(config.agents?.entries?.worker).toEqual({ name: "Worker" });
    expect(mcpRollback).toHaveBeenCalledOnce();
    expect(workspaceRollback).toHaveBeenCalledOnce();
    expect(persistInstall).not.toHaveBeenCalled();
  });

  it("rejects access drift at the agent config pre-rename boundary", async () => {
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
    let sourceConfig: OpenClawConfig = {
      agents: { entries: { worker: { name: "Worker" } } },
    };
    let runtimeConfig: OpenClawConfig = sourceConfig;
    let wroteAgent = false;
    const workspaceRollback = vi.fn(async () => undefined);
    const mcpRollback = vi.fn(async () => undefined);
    const persistInstall = vi.fn(() => ({ ...install, claw: source }));

    await expect(
      applyClawUpdatePlan(
        updatePlan,
        { targetManifest: manifest, targetSource: source },
        {
          config: runtimeConfig,
          ...consent(updatePlan),
          getCurrentConfig: () => runtimeConfig,
          assertReviewedConfig: (current) => {
            if (current.tools?.deny?.includes("web_fetch")) {
              throw new ClawUpdateMutationError(
                "reviewed_access_changed",
                "The effective Claw access changed since review. Preview it again.",
              );
            }
          },
          rebuildPlan: vi.fn(async () => updatePlan),
          buildAddPlan: vi.fn(async () => addPlan),
          readInstall: vi.fn(() => install),
          applyWorkspace: vi.fn(async () => ({ appliedPaths: [], rollback: workspaceRollback })),
          applyMcp: vi.fn(async () => ({ appliedNames: [], rollback: mcpRollback })),
          commitConfig: async (transform, beforeCommit?: () => void) => {
            const nextConfig = transform(sourceConfig, runtimeConfig);
            runtimeConfig = { ...runtimeConfig, tools: { deny: ["web_fetch"] } };
            beforeCommit?.();
            sourceConfig = nextConfig;
            wroteAgent = true;
          },
          persistInstall,
        },
      ),
    ).rejects.toMatchObject({ code: "reviewed_access_changed" });

    expect(wroteAgent).toBe(false);
    expect(sourceConfig.agents?.entries?.worker).toEqual({ name: "Worker" });
    expect(mcpRollback).toHaveBeenCalledOnce();
    expect(workspaceRollback).toHaveBeenCalledOnce();
    expect(persistInstall).not.toHaveBeenCalled();
  });

  it("rejects access drift during a workspace-only update before the next effect", async () => {
    const updatePlan = plan([
      {
        kind: "workspaceFile",
        id: "SOUL.md",
        action: "change",
        target: "/tmp/workspace-worker/SOUL.md",
        blocked: false,
        reason: "target changed",
      },
    ]);
    let config: OpenClawConfig = { agents: { entries: { worker: { name: "Worker" } } } };
    const workspaceRollback = vi.fn(async () => undefined);
    const applyMcp = vi.fn(async () => ({ appliedNames: [], rollback: async () => undefined }));
    const persistInstall = vi.fn(() => ({ ...install, claw: source }));

    await expect(
      applyClawUpdatePlan(
        updatePlan,
        { targetManifest: manifest, targetSource: source },
        {
          config,
          ...consent(updatePlan),
          getCurrentConfig: () => config,
          assertReviewedConfig: (current) => {
            if (current.tools?.deny?.includes("web_fetch")) {
              throw new ClawUpdateMutationError(
                "reviewed_access_changed",
                "The effective Claw access changed since review. Preview it again.",
              );
            }
          },
          rebuildPlan: vi.fn(async () => updatePlan),
          buildAddPlan: vi.fn(async () => addPlan),
          readInstall: vi.fn(() => install),
          applyWorkspace: vi.fn(async () => {
            config = { ...config, tools: { deny: ["web_fetch"] } };
            return { appliedPaths: ["SOUL.md"], rollback: workspaceRollback };
          }),
          applyMcp,
          persistInstall,
        },
      ),
    ).rejects.toMatchObject({ code: "reviewed_access_changed" });

    expect(applyMcp).not.toHaveBeenCalled();
    expect(workspaceRollback).toHaveBeenCalledOnce();
    expect(persistInstall).not.toHaveBeenCalled();
  });

  it("passes the reviewed guard into a nested forward mutation", async () => {
    const updatePlan = plan([
      {
        kind: "workspaceFile",
        id: "SOUL.md",
        action: "change",
        target: "/tmp/workspace-worker/SOUL.md",
        blocked: false,
        reason: "target changed",
      },
    ]);
    let config: OpenClawConfig = { agents: { entries: { worker: { name: "Worker" } } } };
    const forwardMutation = vi.fn();
    const applyMcp = vi.fn(async () => ({ appliedNames: [], rollback: vi.fn() }));

    await expect(
      applyClawUpdatePlan(
        updatePlan,
        { targetManifest: manifest, targetSource: source },
        {
          config,
          ...consent(updatePlan),
          getCurrentConfig: () => config,
          assertReviewedConfig: (current) => {
            if (current.tools?.deny?.includes("web_fetch")) {
              throw new ClawUpdateMutationError(
                "reviewed_access_changed",
                "The effective Claw access changed since review. Preview it again.",
              );
            }
          },
          rebuildPlan: vi.fn(async () => updatePlan),
          buildAddPlan: vi.fn(async () => addPlan),
          readInstall: vi.fn(() => install),
          applyWorkspace: vi.fn(async (_fresh, _target, stageOptions) => {
            config = { ...config, tools: { deny: ["web_fetch"] } };
            stageOptions.assertForwardCurrent?.();
            forwardMutation();
            return { appliedPaths: ["SOUL.md"], rollback: vi.fn() };
          }),
          applyMcp,
        },
      ),
    ).rejects.toMatchObject({ code: "reviewed_access_changed" });

    expect(forwardMutation).not.toHaveBeenCalled();
    expect(applyMcp).not.toHaveBeenCalled();
  });

  it("rejects access drift after MCP work when the agent profile is unchanged", async () => {
    const updatePlan = plan([
      {
        kind: "workspaceFile",
        id: "SOUL.md",
        action: "change",
        target: "/tmp/workspace-worker/SOUL.md",
        blocked: false,
        reason: "target changed",
      },
    ]);
    let config: OpenClawConfig = { agents: { entries: { worker: { name: "Worker" } } } };
    const workspaceRollback = vi.fn(async () => undefined);
    const mcpRollback = vi.fn(async () => undefined);
    const applyCron = vi.fn(async () => ({ appliedIds: [], rollback: async () => undefined }));
    const persistInstall = vi.fn(() => ({ ...install, claw: source }));

    await expect(
      applyClawUpdatePlan(
        updatePlan,
        { targetManifest: manifest, targetSource: source },
        {
          config,
          ...consent(updatePlan),
          getCurrentConfig: () => config,
          assertReviewedConfig: (current) => {
            if (current.tools?.deny?.includes("web_fetch")) {
              throw new ClawUpdateMutationError(
                "reviewed_access_changed",
                "The effective Claw access changed since review. Preview it again.",
              );
            }
          },
          rebuildPlan: vi.fn(async () => updatePlan),
          buildAddPlan: vi.fn(async () => addPlan),
          readInstall: vi.fn(() => install),
          applyWorkspace: vi.fn(async () => ({
            appliedPaths: ["SOUL.md"],
            rollback: workspaceRollback,
          })),
          applyMcp: vi.fn(async () => {
            config = { ...config, tools: { deny: ["web_fetch"] } };
            return { appliedNames: [], rollback: mcpRollback };
          }),
          applyCron,
          persistInstall,
        },
      ),
    ).rejects.toMatchObject({ code: "reviewed_access_changed" });

    expect(applyCron).not.toHaveBeenCalled();
    expect(mcpRollback).toHaveBeenCalledOnce();
    expect(workspaceRollback).toHaveBeenCalledOnce();
    expect(persistInstall).not.toHaveBeenCalled();
  });

  it("rejects access drift before installing an updated Claw's plugin", async () => {
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
      ...emptyPluginPlanEvidence,
    };
    const desiredDigest = `sha256:${createHash("sha256")
      .update(
        stableStringify({
          package: targetPackage,
          integrity: packageDetails.integrity,
          installId: packageDetails.installId,
          riskWarning: undefined,
          prerequisites: undefined,
          ...emptyPluginPlanEvidence,
          extension: undefined,
        }),
      )
      .digest("hex")}`;
    const updatePlan = plan([
      {
        kind: "agent",
        id: "worker",
        action: "change",
        target: 'agents.entries["worker"]',
        blocked: false,
        reason: "target changed",
      },
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
    let config: OpenClawConfig = { agents: { entries: { worker: { name: "Worker" } } } };
    const applyPackage = vi.fn(async () => ({ appliedIds: ["plugin:github"], rollback: vi.fn() }));
    const applyWorkspace = vi.fn(async () => ({ appliedPaths: [], rollback: vi.fn() }));
    const persistInstall = vi.fn(() => ({ ...install, claw: source }));

    await expect(
      applyClawUpdatePlan(
        updatePlan,
        { targetManifest: { ...manifest, packages: [targetPackage] }, targetSource: source },
        {
          config,
          ...consent(updatePlan),
          getCurrentConfig: () => config,
          assertReviewedConfig: (current) => {
            if (current.tools?.deny?.includes("web_fetch")) {
              throw new ClawUpdateMutationError(
                "reviewed_access_changed",
                "The effective Claw access changed since review. Preview it again.",
              );
            }
          },
          rebuildPlan: vi.fn(async () => updatePlan),
          buildAddPlan: vi.fn(async () => {
            config = { ...config, tools: { deny: ["web_fetch"] } };
            return packageAddPlan;
          }),
          readInstall: vi.fn(() => install),
          applyPackage,
          applyWorkspace,
          persistInstall,
        },
      ),
    ).rejects.toMatchObject({ code: "reviewed_access_changed" });

    expect(applyPackage).not.toHaveBeenCalled();
    expect(applyWorkspace).not.toHaveBeenCalled();
    expect(persistInstall).not.toHaveBeenCalled();
  });
});
