import { expect, it, vi } from "vitest";
import type { ConfigFileSnapshot } from "../../config/types.openclaw.js";
import { recordUpdateModelRetirement } from "../../infra/update-deferred-model-retirement.js";
import { createUpdateRun } from "../../infra/update-run-ledger.js";
import { VERSION } from "../../version.js";
import { readPackageVersion } from "./shared.js";
import { convergeUpdatePlugins } from "./update-command-convergence.js";
import { completePostCorePluginUpdate } from "./update-command-fresh-doctor.js";
import {
  updatePluginsAfterCoreUpdate,
  type PostCorePluginUpdateResult,
} from "./update-command-plugins.js";
import {
  continuePostCoreUpdateInFreshProcess,
  postCoreUpdateParentOwnsCompletion,
  writePostCorePluginUpdateResultFile,
} from "./update-command-post-core.js";
import { resumePostCoreUpdate } from "./update-command-resume.js";

export function registerConvergenceCompletionTests({
  mocks,
  validConfigSnapshot,
  successfulPluginUpdate,
}: {
  mocks: { events: string[]; leaseActive: boolean };
  validConfigSnapshot: ConfigFileSnapshot;
  successfulPluginUpdate: PostCorePluginUpdateResult;
}) {
  const record = (name: string): void => {
    mocks.events.push(name + ":" + mocks.leaseActive);
  };
  it.each(
    (["candidate", "current", "resumed"] as const).flatMap((runtime) =>
      [false, true].map((coreAlreadyCurrent) => ({ runtime, coreAlreadyCurrent })),
    ),
  )(
    "completes unchanged plugins with deferred model retirement once ($runtime, current=$coreAlreadyCurrent)",
    async ({ runtime, coreAlreadyCurrent }) => {
      const resumesTarget = runtime === "resumed" || (runtime === "current" && !coreAlreadyCurrent);
      const installedVersion = runtime === "resumed" ? "2026.9.4" : VERSION;
      vi.mocked(readPackageVersion).mockResolvedValue(installedVersion);
      const run = createUpdateRun({ trigger: "cli" });
      vi.stubEnv("OPENCLAW_UPDATE_RUN_ID", run.runId);
      recordUpdateModelRetirement("deferred");
      const pluginUpdate = { ...successfulPluginUpdate, changed: false };
      vi.mocked(updatePluginsAfterCoreUpdate).mockResolvedValueOnce({
        ...pluginUpdate,
        assessment: { kind: "no-payload-repair" },
      });
      vi.mocked(completePostCorePluginUpdate).mockImplementationOnce(async (params) => {
        expect(mocks.leaseActive).toBe(false);
        record("complete");
        await params.beforeDoctor?.();
        recordUpdateModelRetirement("completed");
        params.onWarnings?.(["Deferred retirement repair warning"]);
        return { pluginUpdate, configSnapshot: validConfigSnapshot };
      });
      if (resumesTarget) {
        vi.mocked(postCoreUpdateParentOwnsCompletion).mockResolvedValue(true);
        vi.stubEnv("OPENCLAW_UPDATE_POST_CORE_RESULT_PATH", "/fixture/post-core-result.json");
        vi.mocked(continuePostCoreUpdateInFreshProcess).mockImplementationOnce(async () => {
          // Run the actual resume producer, not a canned child result. The existing
          // transport mock observes when a modern child publishes to its parent.
          await resumePostCoreUpdate({
            root: "/tmp/openclaw",
            channel: "stable",
            opts: { json: true },
            timeoutMs: 5_000,
          });
          expect(completePostCorePluginUpdate).not.toHaveBeenCalled();
          const published = vi.mocked(writePostCorePluginUpdateResultFile).mock.lastCall?.[1];
          expect(published).toBeDefined();
          return { resumed: true, pluginUpdate: published };
        });
      }
      const beforeDoctor = vi.fn(async () => record("park"));
      const result = await convergeUpdatePlugins({
        candidateRuntime: runtime === "candidate",
        coreAlreadyCurrent,
        result: {
          status: coreAlreadyCurrent ? "skipped" : "ok",
          ...(coreAlreadyCurrent ? { reason: "already-current" } : {}),
          mode: runtime === "resumed" ? "npm" : "git",
          root: "/tmp/openclaw",
          before: { version: VERSION },
          after: { version: installedVersion },
          steps: [],
          durationMs: 0,
        },
        root: "/tmp/openclaw",
        installKindChanged: false,
        configSnapshot: validConfigSnapshot,
        requestedChannel: null,
        storedChannel: null,
        channel: "stable",
        downgradeRisk: false,
        opts: { json: true },
        preUpdatePluginInstallRecords: {},
        startedAt: 1_000,
        updateStepTimeoutMs: 5_000,
        packageUpdateNodeRunner: "/selected/node",
        beforeDoctor,
      });
      expect(updatePluginsAfterCoreUpdate).toHaveBeenCalledOnce();
      expect(completePostCorePluginUpdate).toHaveBeenCalledOnce();
      expect(completePostCorePluginUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          freshDoctorRequired: false,
          nodeRunner: "/selected/node",
          opts: { json: true },
        }),
      );
      expect(beforeDoctor).toHaveBeenCalledOnce();
      expect(mocks.events).not.toContain("complete:true");
      expect(result.resultWithPostUpdate.steps).toContainEqual(
        expect.objectContaining({
          name: "post-plugin-doctor-warning-1",
          advisory: {
            kind: "package-post-install-doctor",
            message: "Deferred retirement repair warning",
          },
        }),
      );
      if (resumesTarget) {
        expect(continuePostCoreUpdateInFreshProcess).toHaveBeenCalledOnce();
      } else {
        expect(continuePostCoreUpdateInFreshProcess).not.toHaveBeenCalled();
      }
    },
  );
}
