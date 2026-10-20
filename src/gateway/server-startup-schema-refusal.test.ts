import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { handleGatewayStartupMaintenance } from "../cli/gateway-cli/startup-maintenance.js";
import { setConsoleSubsystemFilter } from "../logging/console.js";
import { resetLogger, setLoggerOverride } from "../logging/logger.js";
import { loggingState } from "../logging/state.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { defaultRuntime } from "../runtime.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { prepareGatewayServerBootstrap } from "./server-startup-bootstrap.js";

const park = vi.hoisted(() => vi.fn(async () => true));
vi.mock("../daemon/launchd.js", () => ({ parkCurrentLaunchAgentForMaintenance: park }));

afterEach(() => {
  vi.restoreAllMocks();
  park.mockClear();
  setConsoleSubsystemFilter(null);
  closeOpenClawStateDatabaseForTest();
  setLoggerOverride(null);
  loggingState.rawConsole = null;
  resetLogger();
});

it.each([false, true])(
  "reports the bootstrap schema refusal before exit 78 (backend logs only and candidate: %s)",
  async (backendLogsOnly) => {
    await withOpenClawTestState({ label: "startup-schema-refusal" }, async (state) => {
      await state.writeConfig({ plugins: { enabled: false } });
      const databasePath = openOpenClawStateDatabase({ env: state.env }).path;
      closeOpenClawStateDatabaseForTest();
      {
        using database = new DatabaseSync(databasePath);
        database.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION + 1}`);
        database
          .prepare("UPDATE schema_meta SET app_version = ? WHERE meta_key = 'primary'")
          .run("2026.9.4");
      }
      const errorLog = vi.fn();
      setLoggerOverride({ level: "silent", consoleLevel: "error", consoleStyle: "json" });
      loggingState.rawConsole = { log: errorLog, info: errorLog, warn: errorLog, error: errorLog };
      setConsoleSubsystemFilter(backendLogsOnly ? ["agent/cli-backend"] : null);
      const runtimeError = vi.spyOn(console, "error").mockImplementation(() => {});
      const exited = new Error("test exit");
      const exit = vi.spyOn(defaultRuntime, "exit").mockImplementation(() => {
        throw exited;
      });
      const log = createSubsystemLogger("gateway");
      const refusal = await prepareGatewayServerBootstrap({
        port: 18789,
        opts: { updateCanary: backendLogsOnly },
        log,
        logSecrets: log,
        loadWorkerEnvironmentStartupModule: () => import("./server-worker-environment-startup.js"),
        formatRuntimeGatewayAuthTokenWarning: () => "unused",
      }).catch((error: unknown) => error);
      if (!(refusal instanceof Error)) {
        throw new Error("Expected bootstrap schema refusal");
      }
      const facts = `uses schema ${OPENCLAW_STATE_SCHEMA_VERSION + 1}; this build supports ${OPENCLAW_STATE_SCHEMA_VERSION}; writer build 2026.9.4.`;
      await expect(handleGatewayStartupMaintenance(refusal)).rejects.toBe(exited);
      const output = runtimeError.mock.calls.flat().join("\n");
      expect(output).toContain(`state database ${databasePath} ${facts}`);
      expect(output).toContain("Refused by OpenClaw");
      expect(output).toContain("Run a build at least as new as the writer");
      expect(output).toContain("restore your pre-upgrade backup");
      expect(output).toContain("Gateway failed to start: Gateway refused startup");
      expect(runtimeError).toHaveBeenCalledExactlyOnceWith(
        `Gateway failed to start: ${refusal.message}`,
      );
      expect(runtimeError.mock.invocationCallOrder[0]).toBeLessThan(
        exit.mock.invocationCallOrder[0]!,
      );
      expect(errorLog).toHaveBeenCalledTimes(backendLogsOnly ? 0 : 1);
      if (!backendLogsOnly) {
        expect(errorLog.mock.calls.flat().join("\n")).toContain(
          JSON.stringify(refusal.message).slice(1, -1),
        );
        expect(errorLog.mock.invocationCallOrder[0]).toBeLessThan(
          exit.mock.invocationCallOrder[0]!,
        );
      }
      expect([park.mock.calls.length, exit.mock.calls]).toEqual([1, [[78]]]);
    });
  },
);
