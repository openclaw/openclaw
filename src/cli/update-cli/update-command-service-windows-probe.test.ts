import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildTaskScript, readScheduledTaskCommand } from "../../daemon/schtasks-layout.js";
import { readScheduledTaskRuntime } from "../../daemon/schtasks-runtime.js";
import type { GatewayService } from "../../daemon/service.js";
import {
  createMockGatewayService,
  mockSystemAccountHome,
} from "../../daemon/service.test-helpers.js";
import { mockProcessPlatform } from "../../test-utils/vitest-spies.js";
import {
  gatewayCommand,
  maintenanceDefaults,
} from "./update-command-service-fixtures.test-support.js";
import { withServiceHome } from "./update-command-service-home.test-support.js";
import { maybeStopManagedServiceBeforeMutableUpdate } from "./update-command-service-maintenance.js";

const mocks = vi.hoisted(() => ({ service: vi.fn<() => GatewayService>() }));
vi.mock("../../daemon/service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/service.js")>()),
  resolveGatewayService: mocks.service,
}));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync: vi.fn(),
}));
beforeEach(() => {
  mockSystemAccountHome();
  vi.spyOn(performance, "now").mockReturnValue(1_000);
});
afterEach(() => vi.restoreAllMocks());

it.each([
  ["registration", ["timeout", "found", "found"], true],
  ["runtime", ["found", "timeout", "found", "found"], true],
  ["registration", ["timeout", "timeout"], false],
  ["runtime", ["found", "timeout", "found", "timeout"], false],
  ["command then runtime", ["timeout", "found", "timeout"], false],
  ["unavailable", ["unavailable"], false],
] as const)(
  "keeps strict Scheduled Task inspection through %s failures: %j",
  (stage, responses, recovered) =>
    withServiceHome(async (home) => {
      mockProcessPlatform("win32");
      const scriptPath = "C:\\Registered Service\\gateway.cmd";
      const programArguments = [...gatewayCommand(home).programArguments, "--port", "18789"];
      const script = Buffer.from(
        buildTaskScript({ programArguments, environment: { HOME: home } }),
      );
      const nativeReadFile = fs.readFile;
      vi.spyOn(fs, "readFile").mockImplementation(async (pathname, options) =>
        pathname === scriptPath ? script : nativeReadFile(pathname, options),
      );
      vi.mocked(spawnSync).mockReset();
      const taskResponses = [...responses];
      vi.mocked(spawnSync).mockImplementation((_command, args) => {
        const processProbe = args?.some((arg) => arg.includes("Get-CimInstance Win32_Process"));
        if (!processProbe && !args?.includes("-EncodedCommand")) {
          throw new Error("Unexpected native inspection");
        }
        const response = processProbe ? "found" : taskResponses.shift();
        if (!response) {
          throw new Error("Unexpected Task Scheduler query");
        }
        const stdout =
          response === "found"
            ? JSON.stringify(
                processProbe
                  ? [
                      {
                        ProcessId: 43210,
                        CommandLine: programArguments.map((arg) => `"${arg}"`).join(" "),
                      },
                    ]
                  : {
                      taskPath: "\\OpenClaw Gateway",
                      state: 4,
                      actions: [{ type: 0, path: scriptPath, arguments: "", workingDirectory: "" }],
                    },
              )
            : "";
        return {
          pid: 0,
          output: [null, stdout, ""],
          stdout,
          stderr: "",
          status: response === "found" ? 0 : response === "unavailable" ? 2 : null,
          signal: null,
          ...(response === "timeout"
            ? { error: Object.assign(new Error("probe timed out"), { code: "ETIMEDOUT" }) }
            : {}),
        };
      });
      const service = createMockGatewayService({
        readCommand: readScheduledTaskCommand,
        readRuntime: readScheduledTaskRuntime,
        isLoaded: async () => true,
      });
      mocks.service.mockReturnValue(service);
      const inspected = await maybeStopManagedServiceBeforeMutableUpdate({
        ...maintenanceDefaults,
        phase: "inspect",
        timeoutMs: 47_000,
      });
      expect(inspected.serviceUpdateVerdict?.kind).toBe(recovered ? "owned" : "unavailable");
      if (recovered) {
        expect(inspected).toMatchObject({
          running: true,
          servicePid: 43210,
          serviceEnv: { HOME: home },
        });
      } else {
        expect(inspected.serviceMutationSkipMessage).toContain(
          stage === "unavailable"
            ? "Task Scheduler check failed (exit 2)."
            : stage === "command then runtime" || stage === "runtime"
              ? "Scheduled Task check timed out after 47000 ms (ETIMEDOUT)."
              : "Task Scheduler check timed out after 47000 ms.",
        );
        if (stage === "registration" || stage === "unavailable") {
          expect(inspected.serviceUpdateVerdict).toMatchObject({
            inspectionReason: "windows-task-inspection-failed",
          });
        }
        expect(inspected.serviceEnv).toBeUndefined();
      }
      expect(taskResponses).toEqual([]);
      for (const call of vi.mocked(spawnSync).mock.calls) {
        expect(call[2]?.timeout).toBe(
          call[1]?.some((arg) => arg.includes("Get-CimInstance Win32_Process")) ? 5_000 : 47_000,
        );
      }
      expect(service.stop).not.toHaveBeenCalled();
      expect(service.install).not.toHaveBeenCalled();
    }),
);
