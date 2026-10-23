import { expect, it, type Mock } from "vitest";
import { readAcpSessionEntry } from "../../acp/runtime/session-meta.js";
import { seedStaleDeferredPluginSessionImport } from "../../commands/doctor-session-sqlite.deferred-plugin.test-support.js";
import { noteSessionTranscriptHealth } from "../../commands/doctor-session-transcripts.js";
import { loadTranscriptEventsSync } from "../../config/sessions/session-accessor.sqlite-read.js";
import { migrateLegacyAcpSessionMetadata } from "../../infra/state-migrations.session-store.js";
import { EMPTY_LEGACY_SESSION_SURFACES } from "../../plugins/legacy-session-surfaces.types.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  createManagedServiceIdentityFixture,
  finishSuccessfulPackageSwitch,
  managedServiceState,
  successfulPluginUpdate,
  validConfigSnapshot,
} from "./update-command-post-update.test-support.js";

export function registerStaleSessionReceiptUpdateTest(mocks: {
  completePluginUpdate: Mock;
  restartService: Mock;
  printResult: Mock;
  readServiceState: Mock;
}) {
  it("restarts the stopped Gateway after Doctor supersedes a foreign session receipt", async () => {
    await withOpenClawTestState({ label: "update-stale-session-receipt" }, async (state) => {
      const { cfg, scope } = await seedStaleDeferredPluginSessionImport(state);
      const identity = createManagedServiceIdentityFixture(state.home);
      // v2026.9.5 post-plugin Doctor markers: the updater retains service activation ownership.
      const env = {
        ...state.env,
        OPENCLAW_UPDATE_IN_PROGRESS: "1",
        OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "1",
        OPENCLAW_UPDATE_PARENT_SUPPORTS_GATEWAY_RESTART: "1",
        OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR: "0",
        OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION: "0",
        OPENCLAW_UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR: "1",
        OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: "1",
        OPENCLAW_SERVICE_REPAIR_POLICY: "external",
      };
      mocks.readServiceState.mockResolvedValue(managedServiceState(env));
      mocks.completePluginUpdate.mockImplementationOnce(
        async (
          params: Parameters<
            typeof import("./update-command-fresh-doctor.js").completePostCorePluginUpdate
          >[0],
        ) => {
          await params.beforeDoctor?.();
          await migrateLegacyAcpSessionMetadata({
            cfg,
            env,
            legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
          });
          await noteSessionTranscriptHealth({
            cfg,
            env,
            shouldRepair: true,
            postSessionPluginMigrationPlanBound: true,
            onWarnings: (warnings) => params.onWarnings?.([...warnings]),
          });
          return { pluginUpdate: successfulPluginUpdate, configSnapshot: validConfigSnapshot };
        },
      );
      try {
        await finishSuccessfulPackageSwitch({ restartEnvironment: env, stoppedForUpdate: true });
      } finally {
        identity.restore();
      }
      expect(loadTranscriptEventsSync({ ...scope, sessionId: "legacy-kept" })).toHaveLength(2);
      expect(
        readAcpSessionEntry({ cfg, env, agentId: "main", sessionKey: "agent:main:kept" })?.acp
          ?.runtimeSessionName,
      ).toBe("legacy-runtime");
      expect(mocks.restartService).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          shouldRestart: true,
          requireRunningServiceAfterRestart: true,
        }),
      );
      expect(mocks.printResult.mock.lastCall?.[0]).toMatchObject({
        status: "ok",
        steps: expect.arrayContaining([
          expect.objectContaining({
            exitCode: 0,
            advisory: expect.objectContaining({
              message: expect.stringContaining("retained_plugin_receipt_superseded"),
            }),
          }),
        ]),
      });
      expect(mocks.printResult.mock.lastCall?.[0].recovery?.serviceRestartSafe).not.toBe(false);
    });
  });
}
