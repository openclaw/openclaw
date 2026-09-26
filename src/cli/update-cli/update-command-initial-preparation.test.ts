import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import * as launchd from "../../daemon/launchd.js";
import * as supervision from "../../infra/gateway-supervision.js";
import * as updateKind from "../../infra/update-check.js";
import * as sentinel from "../../infra/update-control-plane-sentinel.js";
import * as pkgOwner from "../../infra/update-freebsd-pkg-ownership.js";
import { withUpdateInitialStoreInvocation } from "../../infra/update-initial-store-invocation.js";
import * as handoffCleanup from "../../infra/update-managed-service-handoff-cleanup.js";
import * as pluginIndex from "../../plugins/installed-plugin-index-records.js";
import * as stateOwner from "../../state/openclaw-state-ownership.js";
import * as shared from "./shared.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import * as foreground from "./update-command-handoff.js";
import { withInitialStoreFixture } from "./update-command-initial-store.test-support.js";
import { prepareMutableUpdateRuntime } from "./update-command-mutable-runtime.js";
import { prepareUpdateCommand } from "./update-command-run.js";
import * as servicePlan from "./update-command-service-plan.js";

it.each(["stable", "discovery", "ownership", "service-plan"] as const)(
  "revalidates real preparation before state ownership admission (%s)",
  async (phase) => {
    await withInitialStoreFixture(
      async ({ root, installation, input, prepared }) => {
        const other = path.join(root, "unselected-state");
        fs.mkdirSync(other, { mode: 0o700 });
        const drift = async (at: typeof phase) => {
          await Promise.resolve();
          if (at === phase && phase !== "stable") {
            process.env.OPENCLAW_STATE_DIR = other;
          }
        };
        // Control external discovery/service inspection only, not the real preparation function.
        vi.spyOn(supervision, "isGatewayExternallySupervised").mockReturnValue(false);
        vi.spyOn(shared, "resolveUpdateRoot").mockImplementation(async () => {
          await drift("discovery");
          return installation;
        });
        vi.spyOn(updateKind, "resolveUpdateInstallKind").mockResolvedValue(
          phase === "service-plan" ? "package" : "git",
        );
        vi.spyOn(sentinel, "readControlPlaneUpdateSentinelMeta").mockResolvedValue(null);
        vi.spyOn(foreground, "resolveForegroundUpdateAdmission").mockResolvedValue(false);
        vi.spyOn(pkgOwner, "createFreeBsdPkgOwnershipInspection").mockReturnValue({
          ...prepared.pkgOwnership,
          assertUnowned: () => drift("ownership"),
        });
        vi.spyOn(servicePlan, "resolveManagedServicePackageUpdatePlan").mockImplementation(
          async () => {
            await drift("service-plan");
            return { rootRedirect: null };
          },
        );
        // The real state ownership implementation runs on success; refusal must not reach it.
        const ownership = vi.spyOn(stateOwner, "assertOpenClawStateWriteAllowedAtPath");
        const before = fs.readFileSync(input.selection.state.databasePath);
        const operation = withUpdateInitialStoreInvocation(input, () =>
          prepareUpdateCommand({ json: true, restart: false }),
        );
        if (phase === "stable") {
          await expect(operation).resolves.toMatchObject({ discoveredRoot: installation });
          expect(ownership).toHaveBeenCalledWith(
            expect.objectContaining({ databasePath: input.selection.state.databasePath }),
          );
        } else {
          await expect(operation).rejects.toThrow(
            "effective installation or store selectors diverged",
          );
          expect(ownership).not.toHaveBeenCalled();
        }
        expect(fs.readdirSync(other)).toEqual([]);
        expect(fs.readFileSync(input.selection.state.databasePath)).toEqual(before);
      },
      { applicationState: true },
    );
  },
);

it.each(["stable", "initial-selector", "cleanup-selector"] as const)(
  "revalidates mutable preparation within an existing native executor (%s)",
  async (phase) => {
    await withInitialStoreFixture(
      async ({ root, installation, env, input }) => {
        const other = path.join(root, "unselected-runtime");
        fs.mkdirSync(other, { mode: 0o700 });
        const cleanup = vi
          .spyOn(handoffCleanup, "cleanupStaleManagedServiceUpdateHandoffs")
          .mockImplementation(async () => {
            await Promise.resolve();
            if (phase === "cleanup-selector") {
              process.env.OPENCLAW_STATE_DIR = other;
            }
            return 0;
          });
        const disable = vi
          .spyOn(launchd, "disableCurrentOpenClawUpdateLaunchdJob")
          .mockResolvedValue(false);
        const inventory = vi
          .spyOn(pluginIndex, "loadInstalledPluginIndexInstallRecords")
          .mockResolvedValue({});
        const ownership = vi.spyOn(stateOwner, "assertOpenClawStateWriteAllowedAtPath");
        const before = fs.readFileSync(input.selection.state.databasePath);
        const runId = env.OPENCLAW_UPDATE_RUN_ID;
        if (!runId) {
          throw new Error("Native executor fixture requires its admitted run ID");
        }
        // Reuse a genuinely admitted native owner; a later lexical scope is not a new grant.
        await withUpdateCommandExecutor(
          runId,
          async (executor) => {
            const fence = await executor.enter(installation, { preflight: true });
            await withUpdateInitialStoreInvocation(input, async () => {
              const selectedEnv =
                phase === "initial-selector" ? { ...env, OPENCLAW_STATE_DIR: other } : env;
              const operation = prepareMutableUpdateRuntime(selectedEnv, fence);
              if (phase === "stable") {
                await expect(operation).resolves.toEqual({});
                expect(ownership).toHaveBeenCalledExactlyOnceWith({
                  databasePath: input.selection.state.databasePath,
                });
                expect(inventory).toHaveBeenCalledOnce();
              } else {
                await expect(operation).rejects.toThrow(
                  "effective installation or store selectors diverged",
                );
                expect(ownership).not.toHaveBeenCalled();
                expect(disable).not.toHaveBeenCalled();
                expect(inventory).not.toHaveBeenCalled();
                if (phase === "initial-selector") {
                  expect(cleanup).not.toHaveBeenCalled();
                }
              }
            });
            fence.assertCurrent();
          },
          { directOriginal: { databasePath: input.selection.handoff.databasePath } },
        );
        expect(fs.readdirSync(other)).toEqual([]);
        expect(fs.readFileSync(input.selection.state.databasePath)).toEqual(before);
      },
      { applicationState: true },
    );
  },
);
