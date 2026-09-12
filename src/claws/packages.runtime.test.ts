import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { commitPluginInstallRecordsWithConfig } from "../plugins/install-record-commit.js";
import type { PluginInstallBatchReload } from "../plugins/install-runtime-batch.js";
import { preflightPluginInstall } from "../plugins/plugin-install-preflight.js";
import { hasPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { installClawPackages } from "./packages.js";
import { packageInstallPlan } from "./packages.test-support.js";

const installOwner = vi.hoisted(() => ({
  install: vi.fn(),
  failure: new Error("artifact owner rejected the installation"),
}));
vi.mock("../plugins/management-mutations.js", () => ({
  installManagedPlugin: installOwner.install,
}));

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => closeOpenClawStateDatabaseForTest());
const integrity = `sha256:${"a".repeat(64)}`;

describe("Claw committed plugin requirement handoff", () => {
  it("preserves the install owner's failure instead of a nested CLI exit", async () => {
    const root = dirs.make("openclaw-claw-install-error-");
    const env = {
      OPENCLAW_STATE_DIR: root,
      OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
    };
    await fs.writeFile(env.OPENCLAW_CONFIG_PATH, "{}");
    installOwner.install.mockReset().mockRejectedValue(installOwner.failure);
    await withEnvAsync(env, async () => {
      const result = await installClawPackages(
        packageInstallPlan([
          { kind: "plugin", source: "clawhub", ref: "@owner/demo", version: "1.0.0", integrity },
        ]),
        {
          env,
          runtime: {
            log: () => {},
            error: () => {},
            exit: () => {
              throw new Error("unexpected outer exit");
            },
          },
          deps: {
            acquirePackageLease: () => ({ heartbeat: () => {}, release: () => {} }),
            preflightPlugin: (params) =>
              preflightPluginInstall({ ...params, loadInstallRecords: async () => ({}) }),
            probePlugin: async () => ({
              ok: true,
              pluginId: "demo",
              packageName: "@owner/demo",
              targetDir: root,
              extensions: [],
              clawhub: {
                source: "clawhub",
                clawhubFamily: "code-plugin",
                clawhubUrl: "https://clawhub.ai",
                clawhubPackage: "@owner/demo",
                integrity,
              },
            }),
            persistPackageRef: () => ({
              schemaVersion: "openclaw.clawPackageRef.v1",
              agentId: "incident-2",
              clawName: "incident-claw",
              kind: "plugin",
              source: "clawhub",
              ref: "@owner/demo",
              version: "1.0.0",
              integrity,
              status: "pending",
              relationship: "referenced",
              origin: "claw-introduced",
              independentOwner: false,
              installedAtMs: 1,
              updatedAtMs: 1,
            }),
            completePackageRef: (ref, status) => ({ ...ref, status }),
          },
        },
      ).catch((error: unknown) => error);
      expect(installOwner.install).toHaveBeenCalledOnce();
      expect(result).toMatchObject({
        code: "package_install_failed",
        message: installOwner.failure.message,
        cause: installOwner.failure,
      });
    });
  });
  it.each([false, true])(
    "applies retained writes once after lease release (late failure=%s)",
    async (lateFailure) => {
      const root = dirs.make("openclaw-claw-runtime-");
      const env = {
        OPENCLAW_STATE_DIR: root,
        OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
        OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(root, "bundled"),
      };
      await fs.writeFile(env.OPENCLAW_CONFIG_PATH, "{}");
      await withEnvAsync(env, async () => {
        let records: Record<string, PluginInstallRecord> = {};
        let heldPackages = 0;
        const cleanup = vi.fn();
        const log = vi.fn();
        const reloadPlugins = vi.fn<PluginInstallBatchReload>(async (targets) => {
          expect(hasPluginLifecycleLease()).toBe(false);
          expect(heldPackages).toBe(0);
          expect(cleanup).not.toHaveBeenCalled();
          expect(targets.map((target: { pluginId: string }) => target.pluginId)).toEqual(
            lateFailure ? ["first"] : ["first", "second"],
          );
          return {
            operationId: "batch",
            generation: 2,
            pluginIds: targets.map((target: { pluginId: string }) => target.pluginId),
            warnings: ["Previous plugin cleanup did not finish."],
          };
        });
        const options: NonNullable<Parameters<typeof installClawPackages>[1]> = {
          env,
          runtime: {
            log,
            error: () => {},
            exit: () => {
              throw new Error("unexpected exit");
            },
          },
          reloadPlugins,
          deps: {
            acquirePackageLease: () => {
              heldPackages++;
              return {
                heartbeat: () => true,
                release: () => {
                  heldPackages--;
                },
              };
            },
            preflightPlugin: (params) =>
              preflightPluginInstall({ ...params, loadInstallRecords: async () => records }),
            probePlugin: async ({ spec }) => ({
              ok: true,
              packageName: spec,
              pluginId: spec.includes("first") ? "first" : "second",
              targetDir: root,
              extensions: [],
              clawhub: {
                source: "clawhub",
                clawhubFamily: "code-plugin",
                clawhubUrl: "https://clawhub.ai",
                clawhubPackage: spec,
                integrity,
              },
            }),
            persistPackageRef: (plan, pkg, persistOptions) => ({
              schemaVersion: "openclaw.clawPackageRef.v1",
              agentId: plan.agent.finalId,
              clawName: plan.claw.name,
              kind: pkg.kind,
              source: pkg.source,
              ref: pkg.ref,
              version: pkg.version!,
              integrity: pkg.integrity!,
              status: persistOptions?.status ?? "pending",
              relationship: "referenced",
              origin: "claw-introduced",
              independentOwner: false,
              installedAtMs: 1,
              updatedAtMs: 1,
            }),
            completePackageRef: (ref, status) => ({ ...ref, status }),
            installPlugin: async (params) => {
              if (params.request.source !== "clawhub" || !params.request.expectedPluginId) {
                throw new Error("Expected a pinned ClawHub plugin request");
              }
              const pluginId = params.request.expectedPluginId;
              const next = {
                ...records,
                [pluginId]: {
                  source: "clawhub" as const,
                  clawhubPackage: `@owner/${pluginId}`,
                  version: "1.0.0",
                  integrity,
                  installPath: path.join(root, "plugins", pluginId),
                },
              };
              const write = await commitPluginInstallRecordsWithConfig({
                previousInstallRecords: records,
                nextInstallRecords: next,
                nextConfig: {},
                writeOptions: { afterWrite: { mode: "none", reason: "batch fixture" } },
              });
              records = next;
              params.deferRuntime?.record({
                operation: "install",
                pluginId,
                sourceDigests: {},
                write,
              });
              params.deferRuntime?.deferCleanup(
                async (assertOwned, warn) => {
                  assertOwned();
                  cleanup(pluginId);
                  warn(`Source cleanup warning for ${pluginId}`);
                },
                path.join(root, "retired", pluginId),
              );
              if (lateFailure) {
                throw new Error("postcommit metadata failure");
              }
            },
          },
        };
        const pending = installClawPackages(
          packageInstallPlan(
            ["first", "second"].map((id) => ({
              kind: "plugin",
              source: "clawhub",
              ref: `@owner/${id}`,
              version: "1.0.0",
              integrity,
            })),
          ),
          options,
        );
        let completed: Awaited<typeof pending> | undefined;
        if (lateFailure) {
          await expect(pending).rejects.toMatchObject({
            code: "package_install_failed",
            message: "postcommit metadata failure",
          });
        } else {
          completed = await pending;
          expect(completed).toHaveLength(2);
        }
        expect(reloadPlugins).toHaveBeenCalledOnce();
        expect(log).toHaveBeenCalledWith("Previous plugin cleanup did not finish.");
        expect(cleanup).toHaveBeenCalledTimes(lateFailure ? 1 : 2);
        expect(log).toHaveBeenCalledWith("Source cleanup warning for first");
        if (completed) {
          const installedRefs = completed;
          cleanup.mockClear();
          const installPlugin = vi.fn(async () => {
            throw new Error("resumed requirement was reinstalled");
          });
          const resumedOptions = {
            ...options,
            deps: {
              ...options.deps,
              installPlugin,
              readPackageRefs: () => installedRefs,
            },
          };
          const resumedPlan = packageInstallPlan(
            ["first", "second"].map((id) => ({
              kind: "plugin",
              source: "clawhub",
              ref: `@owner/${id}`,
              version: "1.0.0",
              integrity,
            })),
          );
          reloadPlugins.mockRejectedValueOnce(new Error("runtime reply lost"));
          await expect(installClawPackages(resumedPlan, resumedOptions)).rejects.toMatchObject({
            code: "package_runtime_failed",
            message: expect.stringContaining("Runtime activation was not confirmed"),
          });
          await expect(installClawPackages(resumedPlan, resumedOptions)).resolves.toHaveLength(2);
          expect(installPlugin).not.toHaveBeenCalled();
          expect(cleanup).not.toHaveBeenCalled();
          expect(reloadPlugins).toHaveBeenCalledTimes(3);
        }
      });
    },
  );
});
