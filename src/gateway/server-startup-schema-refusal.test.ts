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
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
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
  "reports the bootstrap schema refusal before exit 78 (backend logs only: %s)",
  async (backendLogsOnly) => {
    const state = await createOpenClawTestState({ label: "startup-schema-refusal" });
    try {
      await state.writeConfig({ plugins: { enabled: false } });
      const databasePath = openOpenClawStateDatabase({ env: state.env }).path;
      closeOpenClawStateDatabaseForTest();
      const database = new DatabaseSync(databasePath);
      try {
        database.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION + 1}`);
        database
          .prepare("UPDATE schema_meta SET app_version = ? WHERE meta_key = 'primary'")
          .run("2026.9.4");
      } finally {
        database.close();
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
          opts: {},
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
      const facts = `uses schema ${OPENCLAW_STATE_SCHEMA_VERSION + 1}; this build supports ${OPENCLAW_STATE_SCHEMA_VERSION}; writer build 2026.9.4.`;
      await expect(handleGatewayStartupMaintenance(refusal)).rejects.toBe(exited);
      const output = runtimeError.mock.calls.flat().join("\n");
      expect(output).toContain(facts);
      expect(output).toContain("Refused by OpenClaw");
      expect(output).toContain("Run a build at least as new as the writer");
      expect(output).toContain("restore your pre-upgrade backup");
      const doctor = new OpenClawDatabaseSchemaPreflightError(
        [
          {
            kind: "state",
            path: databasePath,
            foundVersion: OPENCLAW_STATE_SCHEMA_VERSION + 1,
            supportedVersion: OPENCLAW_STATE_SCHEMA_VERSION,
            writerAppVersion: "2026.9.4",
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
    } finally {
      await state.cleanup();
    }
  },
);
