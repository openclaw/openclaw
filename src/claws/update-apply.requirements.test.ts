import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withCurrentConfigPolicyReader } from "../config/io.runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { commitPluginInstallRecordsWithConfig } from "../plugins/install-record-commit.js";
import { PluginInstallRuntimeBatch } from "../plugins/install-runtime-batch.js";
import {
  hasPluginLifecycleLease,
  withPluginLifecycleLease,
} from "../plugins/plugin-lifecycle-lease.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { digestClawValue } from "./digest.js";
import { emptyPluginPlanEvidence } from "./packages.test-support.js";
import { persistClawInstallRecord, readClawInstallRecord } from "./provenance.js";
import type { ClawAddPlan } from "./types.js";
import {
  applyClawUpdatePlan,
  stageClawUpdateHostRequirements,
  type ClawUpdateApplyOptions,
} from "./update-apply.js";
import { addPlan, consent, install, manifest, plan, source } from "./update-apply.test-helpers.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(closeOpenClawStateDatabaseForTest);

it.each(["complete", "partial", "rejected"] as const)(
  "settles unchanged requirements before later update phases: %s",
  async (outcome) => {
    const root = dirs.make("claw-update-resume-");
    const env = {
      OPENCLAW_STATE_DIR: root,
      OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
    };
    await fs.writeFile(env.OPENCLAW_CONFIG_PATH, "{}");
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
            status: outcome === "complete" ? "complete" : "partial",
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
      expect(reloadPlugins).toHaveBeenCalledTimes(outcome === "complete" ? 0 : 1);
      expect(applyPackage).not.toHaveBeenCalled();
    });
  },
);

it.each(["complete", "rejected", "stage-rejected", "workspace-rejected", "stale-agent"] as const)(
  "continues a new plugin requirement after the runtime handoff: %s",
  async (outcome) => {
    const root = dirs.make("claw-update-new-plugin-");
    const env = {
      OPENCLAW_STATE_DIR: root,
      OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
    };
    const initialConfig: OpenClawConfig = {};
    const installedConfig: OpenClawConfig = {
      plugins: { entries: { github: { enabled: true } } },
    };
    await fs.writeFile(env.OPENCLAW_CONFIG_PATH, JSON.stringify(initialConfig));
    await withEnvAsync(env, async () => {
      persistClawInstallRecord({ ...addPlan, claw: install.claw }, { env, status: "complete" });
      const pkg = {
        kind: "plugin" as const,
        source: "clawhub" as const,
        ref: "github",
        version: "1",
      };
      const details = {
        ...pkg,
        integrity: "sha256:github",
        installId: "github",
        ownerAction: "install" as const,
        ...emptyPluginPlanEvidence,
      };
      const updatePlan = plan([
        {
          kind: "package",
          id: "plugin:github",
          action: "add",
          target: "clawhub:github@1",
          blocked: false,
          reason: "new shared plugin",
          desiredDigest: digestClawValue({
            package: pkg,
            integrity: details.integrity,
            installId: details.installId,
            riskWarning: undefined,
            prerequisites: undefined,
            ...emptyPluginPlanEvidence,
            extension: undefined,
          }),
        },
      ]);
      const installedPlan = {
        ...updatePlan,
        readiness: {
          ready: false,
          requirements: [
            {
              kind: "plugin-setup" as const,
              plugin: "github",
              provider: "github",
              envVars: ["GITHUB_TOKEN"],
              authMethods: ["token"],
            },
          ],
        },
      };
      const driftedPlan = {
        ...installedPlan,
        actions: [
          ...installedPlan.actions,
          {
            kind: "agent" as const,
            id: "worker",
            action: "change" as const,
            target: 'agents.entries["worker"]',
            blocked: false,
            reason: "operator changed the agent",
          },
        ],
      };
      const packageAddPlan: ClawAddPlan = {
        ...addPlan,
        actions: [
          {
            kind: "package",
            id: "plugin:github",
            action: "install",
            target: "clawhub:github@1",
            blocked: false,
            details,
          },
        ],
      };
      const applyWorkspace = vi.fn(async () => {
        expect(hasPluginLifecycleLease()).toBe(true);
        if (outcome === "workspace-rejected") {
          throw new Error("workspace unavailable after activation");
        }
        return { appliedPaths: [], rollback: async () => {} };
      });
      const reloadPlugins = vi.fn(async (targets: readonly { pluginId: string }[]) => {
        expect(hasPluginLifecycleLease()).toBe(false);
        expect(targets.map((target) => target.pluginId)).toEqual(["github"]);
        if (outcome === "rejected") {
          throw new Error("Gateway rejected new plugin");
        }
        if (outcome === "stale-agent") {
          await fs.writeFile(
            env.OPENCLAW_CONFIG_PATH,
            JSON.stringify({
              ...installedConfig,
              agents: { entries: { worker: { name: "Changed" } } },
            }),
          );
        }
        return { operationId: "update", generation: 5, pluginIds: ["github"] };
      });
      const batch = new PluginInstallRuntimeBatch({ env }, reloadPlugins);
      const options: ClawUpdateApplyOptions = {
        env,
        config: initialConfig,
        ...consent(updatePlan),
        runtimeBatch: batch,
        rebuildPlan: async ({ config }) =>
          config.agents?.entries?.worker?.name === "Changed"
            ? driftedPlan
            : config.plugins?.entries?.github?.enabled
              ? installedPlan
              : updatePlan,
        readInstall: () => install,
        buildAddPlan: async () => packageAddPlan,
        applyPackage: async (_phase, _addPlan, packageOptions) => {
          expect(hasPluginLifecycleLease()).toBe(true);
          const write = await commitPluginInstallRecordsWithConfig({
            previousInstallRecords: {},
            nextInstallRecords: {
              github: { source: "clawhub", clawhubPackage: "github", version: "1" },
            },
            nextConfig: installedConfig,
            writeOptions: { afterWrite: { mode: "none", reason: "Update new plugin fixture" } },
          });
          packageOptions.runtimeBatch?.install().record({
            operation: "install",
            pluginId: "github",
            sourceDigests: {},
            write,
          });
          if (outcome === "stage-rejected") {
            throw new Error("package staging failed after plugin commit");
          }
          return { appliedIds: ["plugin:github"], rollback: async () => {} };
        },
        applyWorkspace,
        applyMcp: async () => ({ appliedNames: [], rollback: async () => {} }),
        applyCron: async () => ({ appliedIds: [], rollback: async () => {} }),
        persistInstall: () => ({ ...install, status: "complete" }),
      };
      let stageError: unknown;
      const stage = await withPluginLifecycleLease({ env }, (lease) =>
        withCurrentConfigPolicyReader(
          { configPath: env.OPENCLAW_CONFIG_PATH, env, lease },
          async (getCurrentConfig) => {
            let staged: Awaited<ReturnType<typeof stageClawUpdateHostRequirements>> | undefined;
            try {
              staged = await stageClawUpdateHostRequirements(
                updatePlan,
                { targetManifest: { ...manifest, packages: [pkg] }, targetSource: source },
                { ...options, getCurrentConfig },
              );
            } catch (error) {
              stageError = error;
            }
            if (outcome !== "stage-rejected") {
              expect(staged?.needsRuntimeHandoff).toBe(true);
            }
            await batch.prepare(lease);
            return staged;
          },
        ),
      );
      if (outcome === "stage-rejected") {
        await batch.finish(() => {});
        expect(stageError).toMatchObject({
          code: "update_partial",
          message: expect.stringContaining("package staging failed after plugin commit"),
        });
        expect(readClawInstallRecord("worker", { env })?.status).toBe("partial");
        expect(applyWorkspace).not.toHaveBeenCalled();
        expect(reloadPlugins).toHaveBeenCalledOnce();
        return;
      }
      if (!stage) {
        throw new Error("Update plugin stage did not settle");
      }
      if (outcome === "rejected") {
        let activationError: unknown;
        try {
          await batch.finish(() => {});
        } catch (error) {
          activationError = error;
        }
        expect(activationError).toBeInstanceOf(Error);
        await expect(stage.failRuntime(activationError)).rejects.toMatchObject({
          code: "update_partial",
          cause: activationError,
          message: expect.stringContaining("Gateway rejected new plugin"),
        });
        expect(readClawInstallRecord("worker", { env })?.status).toBe("partial");
        expect(applyWorkspace).not.toHaveBeenCalled();
      } else {
        await batch.finish(() => {});
        const continuation = withPluginLifecycleLease({ env }, (lease) =>
          withCurrentConfigPolicyReader(
            { configPath: env.OPENCLAW_CONFIG_PATH, env, lease },
            (getCurrentConfig) => stage.continue({ ...options, getCurrentConfig }),
          ),
        );
        if (outcome === "workspace-rejected" || outcome === "stale-agent") {
          await expect(continuation).rejects.toMatchObject({ code: "update_partial" });
          expect(readClawInstallRecord("worker", { env })?.status).toBe("partial");
          expect(applyWorkspace).toHaveBeenCalledTimes(outcome === "workspace-rejected" ? 1 : 0);
        } else {
          await expect(continuation).resolves.toMatchObject({ status: "complete" });
          expect(applyWorkspace).toHaveBeenCalledOnce();
        }
      }
      expect(reloadPlugins).toHaveBeenCalledOnce();
    });
  },
);
