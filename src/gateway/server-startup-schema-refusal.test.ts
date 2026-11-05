import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { handleGatewayStartupMaintenance } from "../cli/gateway-cli/startup-maintenance.js";
import { setConsoleSubsystemFilter } from "../logging/console.js";
import { resetLogger, setLoggerOverride } from "../logging/logger.js";
import { loggingState } from "../logging/state.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { defaultRuntime } from "../runtime.js";
import { OpenClawDatabaseSchemaPreflightError } from "../state/openclaw-database-preflight.messages.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { VERSION } from "../version.js";
import { prepareGatewayServerBootstrap } from "./server-startup-bootstrap.js";

const park = vi.hoisted(() => vi.fn(async () => true));
vi.mock("../daemon/launchd.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/launchd.js")>()),
  parkCurrentLaunchAgentForMaintenance: park,
}));

afterEach(() => {
  vi.restoreAllMocks();
  park.mockClear();
  setConsoleSubsystemFilter(null);
  closeOpenClawStateDatabaseForTest();
  setLoggerOverride(null);
  loggingState.rawConsole = null;
  resetLogger();
});

it.each([
  { backendLogsOnly: false, updateCanary: false },
  { backendLogsOnly: true, updateCanary: true },
])(
  "reports the bootstrap schema refusal before exit 78 (backend logs only: $backendLogsOnly, candidate: $updateCanary)",
  ({ backendLogsOnly, updateCanary }) =>
    withOpenClawTestState({ label: "startup-schema-refusal" }, async (state) => {
      await state.writeConfig({ plugins: { enabled: false } });
      const databasePath = openOpenClawStateDatabase({ env: state.env }).path;
      closeOpenClawStateDatabaseForTest();
      {
        using database = new DatabaseSync(databasePath);
        database.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION + 1}`);
        database
          .prepare("UPDATE schema_meta SET app_version = ? WHERE meta_key = 'primary'")
          .run("9999.1.1");
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
      let refusal: unknown;
      try {
        await prepareGatewayServerBootstrap({
          port: 18789,
          opts: { updateCanary },
          log,
          logSecrets: log,
          loadWorkerEnvironmentStartupModule: () =>
            import("./server-worker-environment-startup.js"),
          formatRuntimeGatewayAuthTokenWarning: () => "unused",
        });
      } catch (error) {
        refusal = error;
      }
      expect(refusal).toBeInstanceOf(Error);
      const facts = `uses schema ${OPENCLAW_STATE_SCHEMA_VERSION + 1}; this build supports ${OPENCLAW_STATE_SCHEMA_VERSION}; It was written by OpenClaw 9999.1.1; it is newer than this Gateway (${VERSION}).`;
      await expect(handleGatewayStartupMaintenance(refusal)).rejects.toBe(exited);
      const output = runtimeError.mock.calls.flat().join("\n");
      expect(output).toContain(facts);
      expect(output).toContain("Refused by OpenClaw");
      expect(output).toContain("Use the newer install that supports these schemas");
      expect(output).toContain("restore your pre-upgrade backup");
      const doctor = new OpenClawDatabaseSchemaPreflightError(
        [
          {
            kind: "state",
            path: databasePath,
            foundVersion: OPENCLAW_STATE_SCHEMA_VERSION + 1,
            supportedVersion: OPENCLAW_STATE_SCHEMA_VERSION,
            writerAppVersion: "9999.1.1",
          },
        ],
        {
          operation: "doctor",
        },
      );
      const message = doctor.message.replace(
        "Doctor refused to continue",
        "Gateway refused startup",
      );
      expect(runtimeError).toHaveBeenCalledExactlyOnceWith(`Gateway failed to start: ${message}`);
      expect(runtimeError.mock.invocationCallOrder[0]).toBeLessThan(
        exit.mock.invocationCallOrder[0]!,
      );
      if (backendLogsOnly) {
        expect(errorLog).not.toHaveBeenCalled();
      } else {
        expect(errorLog).toHaveBeenCalledOnce();
        expect(errorLog.mock.calls.flat().join("\n")).toContain(
          JSON.stringify(message).slice(1, -1),
        );
        expect(errorLog.mock.invocationCallOrder[0]).toBeLessThan(
          exit.mock.invocationCallOrder[0]!,
        );
      }
      expect(park).toHaveBeenCalledOnce();
      expect(exit).toHaveBeenCalledWith(78);
    }),
);
