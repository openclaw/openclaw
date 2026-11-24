import { expect, it, vi } from "vitest";
import { withGatewayMaintenanceDrain } from "../cli/update-cli/update-command-service-drain.js";
import * as serviceMaintenance from "../cli/update-cli/update-command-service-maintenance.js";
import * as stopPolicy from "../daemon/systemd-maintenance.js";
import * as gatewayCall from "../gateway/call.js";
import { writeSecretStoreEntry } from "../secrets/store/secret-store.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  GATEWAY_SERVICE_STOP_TIMEOUT_MS,
  GATEWAY_SHUTDOWN_TIMEOUT_MS,
} from "./gateway-shutdown-budget.js";
import { stopSupervisedPredecessorGateway } from "./update-candidate-predecessor-stop.js";
import { readUpdateDatabaseGenerations } from "./update-database-generations.js";
import { createUpdateDoctorDatabaseWriteCapture } from "./update-doctor-result.js";
import { createUpdateRun, getUpdateRun } from "./update-run-ledger.js";

it.runIf(process.platform !== "win32")(
  "records the predecessor stop under native exclusion after a store-backed probe",
  async () => {
    await withOpenClawTestState(
      { scenario: "minimal", applyEnv: true },
      async ({ env, writeConfig }) => {
        const token = "synthetic-maintenance-probe-token"; // pragma: allowlist secret
        await writeConfig({
          gateway: {
            mode: "local",
            auth: {
              mode: "token",
              token: { source: "store", provider: "default", id: "PROBE_TOKEN" },
            },
          },
        });
        const pathname = openOpenClawStateDatabase({ env }).path;
        await writeSecretStoreEntry({
          scope: { kind: "team" },
          name: "PROBE_TOKEN",
          value: token,
          kind: "secret",
          updatedBy: "test",
          database: { env },
        });
        const { runId } = createUpdateRun({ trigger: "control-ui" }, { env });
        await closeOpenClawStateDatabaseAsync();
        const generations = readUpdateDatabaseGenerations([pathname]);
        const capture = createUpdateDoctorDatabaseWriteCapture(generations, {
          env,
          signal: new AbortController().signal,
          warn: vi.fn(),
        })!;
        await capture.admit();
        vi.spyOn(stopPolicy, "readSystemdGatewayStopTimeout").mockResolvedValue(
          GATEWAY_SERVICE_STOP_TIMEOUT_MS,
        );
        const call = vi.spyOn(gatewayCall, "callGatewayCli").mockResolvedValue({
          pid: 631,
          shutdownBudget: { timeoutMs: GATEWAY_SHUTDOWN_TIMEOUT_MS },
        });
        vi.spyOn(
          serviceMaintenance,
          "maybeStopManagedServiceBeforeMutableUpdate",
        ).mockImplementation(async (options) =>
          withGatewayMaintenanceDrain(
            {
              state: {
                installed: true,
                loadState: { status: "loaded" },
                running: true,
                env,
                command: null,
                runtime: { status: "running", pid: 631 },
              },
              assertCurrent() {},
              warn: vi.fn(),
            },
            async () => {
              // The network response is faked; the service probe resolves its real store-backed token.
              expect(call).toHaveBeenCalledExactlyOnceWith(
                expect.objectContaining({ method: "status", token }),
              );
              const stopped = {
                stopped: true,
                inspected: true,
                runtimeInspected: true,
                running: false,
                servicePid: 631,
                serviceManagerUid: 1000,
                stoppedAtMs: 7,
                serviceUpdateVerdict: {
                  kind: "owned" as const,
                  root: process.cwd(),
                  fingerprint: "sealed",
                  refreshDefinition: false,
                },
              };
              options.onStopped?.(stopped);
              return stopped;
            },
          ),
        );
        try {
          await expect(
            stopSupervisedPredecessorGateway(
              { runId, repair: true },
              {
                root: process.cwd(),
                assertCurrent() {},
                warn: vi.fn(),
                databaseWriteCapture: capture,
              },
            ),
          ).resolves.toBe(true);
          await capture.settle();
          expect(capture.receipt).toMatchObject({ unchanged: true, fromGenerations: generations });
          expect(getUpdateRun(runId, { env })?.steps).toContainEqual(
            expect.objectContaining({
              step: "finalize:predecessor-stop:7:1000:631:sealed",
              status: "completed",
            }),
          );
        } finally {
          vi.restoreAllMocks();
          await closeOpenClawStateDatabaseAsync();
        }
      },
    );
  },
);
