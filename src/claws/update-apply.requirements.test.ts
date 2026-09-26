import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { commitPluginInstallRecordsWithConfig } from "../plugins/install-record-commit.js";
import { hasPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { applyClawUpdatePlan } from "./update-apply.js";
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
