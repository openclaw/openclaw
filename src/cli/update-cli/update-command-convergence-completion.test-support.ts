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
  writePostCorePluginUpdateResultFile,
} from "./update-command-post-core.js";
import { resumePostCoreUpdate } from "./update-command-resume.js";
import { withUpdateEnv } from "./update-command-service-env.js";

export function registerConvergenceCompletionTests({
  mocks,
  validConfigSnapshot,
  successfulPluginUpdate,
}: {
  mocks: { leaseActive: boolean };
  validConfigSnapshot: ConfigFileSnapshot;
  successfulPluginUpdate: PostCorePluginUpdateResult;
}) {
  it.each(["candidate", "current", "resumed"] as const)(
    "completes unchanged plugins with deferred model retirement once (%s)",
    async (runtime) => {
      const coreAlreadyCurrent = runtime === "current";
      const resumesTarget = runtime === "resumed";
      const installedVersion = resumesTarget ? "2026.9.4" : VERSION;
      vi.mocked(readPackageVersion).mockResolvedValue(installedVersion);
      const run = createUpdateRun({ trigger: "cli" });
      const env = { ...process.env };
      const doctorEnv = { ...env, OPENCLAW_UPDATE_RUN_ID: run.runId };
      recordUpdateModelRetirement("deferred", doctorEnv);
      const opts = {
        json: true,
        run: { runId: run.runId, env, executorFence: { assertCurrent() {} } },
      };
      const pluginUpdate = { ...successfulPluginUpdate, changed: false };
      vi.mocked(updatePluginsAfterCoreUpdate).mockResolvedValueOnce({
        ...pluginUpdate,
        assessment: { kind: "no-payload-repair" },
      });
      vi.mocked(completePostCorePluginUpdate).mockImplementationOnce(async (params) => {
        expect(mocks.leaseActive).toBe(false);
        await params.beforeDoctor?.();
        recordUpdateModelRetirement("completed", doctorEnv);
        params.onWarnings?.(["Deferred retirement repair warning"]);
        return { pluginUpdate, configSnapshot: validConfigSnapshot };
      });
      if (resumesTarget) {
        const handoffDir = process.env.OPENCLAW_STATE_DIR!;
        await fs.writeFile(path.join(handoffDir, "handoff.json"), '{"completionOwner":"parent"}');
        vi.stubEnv("OPENCLAW_UPDATE_POST_CORE_RESULT_PATH", path.join(handoffDir, "plugins.json"));
        vi.mocked(continuePostCoreUpdateInFreshProcess).mockImplementationOnce(async () => {
          await withUpdateEnv({ OPENCLAW_UPDATE_RUN_ID: run.runId }, () =>
            resumePostCoreUpdate({
              root: "/tmp/openclaw",
              channel: "stable",
              opts,
              timeoutMs: 5_000,
            }),
          );
          expect(completePostCorePluginUpdate).not.toHaveBeenCalled();
          const published = vi.mocked(writePostCorePluginUpdateResultFile).mock.lastCall?.[1];
          expect(published).toBeDefined();
          return { resumed: true, pluginUpdate: published };
        });
      }
      const beforeDoctor = vi.fn(async () => {});
      const result = await convergeUpdatePlugins({
        candidateRuntime: runtime === "candidate",
        coreAlreadyCurrent,
        result: {
          status: coreAlreadyCurrent ? "skipped" : "ok",
          ...(coreAlreadyCurrent ? { reason: "already-current" } : {}),
          mode: resumesTarget ? "npm" : "git",
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
        opts,
        preUpdatePluginInstallRecords: {},
        startedAt: 1_000,
        updateStepTimeoutMs: 5_000,
        packageUpdateNodeRunner: "/selected/node",
        beforeDoctor,
      });
      expect(updatePluginsAfterCoreUpdate).toHaveBeenCalledOnce();
      expect(completePostCorePluginUpdate).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          pluginUpdate: expect.objectContaining({ changed: false }),
          nodeRunner: "/selected/node",
          opts,
        }),
      );
      expect(beforeDoctor).toHaveBeenCalledOnce();
      expect(result.resultWithPostUpdate.steps).toContainEqual(
        expect.objectContaining({
          name: "post-plugin-doctor-warning-1",
          advisory: {
            kind: "package-post-install-doctor",
            message: "Deferred retirement repair warning",
          },
        }),
      );
      expect(continuePostCoreUpdateInFreshProcess).toHaveBeenCalledTimes(resumesTarget ? 1 : 0);
    },
  );
}
import fs from "node:fs/promises";
import path from "node:path";
