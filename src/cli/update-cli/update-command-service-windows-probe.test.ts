import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { buildTaskScript, readScheduledTaskCommand } from "../../daemon/schtasks-layout.js";
import { readScheduledTaskRuntime } from "../../daemon/schtasks-runtime.js";
import type { GatewayService } from "../../daemon/service.js";
import {
  createMockGatewayService,
  mockSystemAccountHome,
} from "../../daemon/service.test-helpers.js";
import * as openClawTmp from "../../infra/tmp-openclaw-dir.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { mockProcessPlatform } from "../../test-utils/vitest-spies.js";
import { maybeStopManagedServiceBeforeMutableUpdate } from "./update-command-service-maintenance.js";

const mocks = vi.hoisted(() => ({ service: vi.fn<() => GatewayService>() }));
vi.mock("../../daemon/service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/service.js")>()),
  resolveGatewayService: mocks.service,
}));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync: vi.fn(() => ({
    pid: 0,
    output: [null, JSON.stringify({ state: 4, lastRunResult: 0 }), ""],
    stdout: JSON.stringify({ state: 4, lastRunResult: 0 }),
    stderr: "",
    status: 0,
    signal: null,
  })),
}));
const dirs = useAutoCleanupTempDirTracker(afterEach);
beforeEach(() => {
  mockSystemAccountHome();
  vi.spyOn(performance, "now").mockReturnValue(1_000);
});
afterEach(() => vi.restoreAllMocks());

async function withServiceHome(run: (home: string) => Promise<void>): Promise<void> {
  const home = dirs.make("openclaw-update-windows-probe-");
  vi.spyOn(openClawTmp, "resolvePreferredOpenClawTmpDir").mockReturnValue(home);
  await withEnvAsync(
    {
      HOME: home,
      USERPROFILE: home,
      APPDATA: path.join(home, "AppData"),
      OPENCLAW_GATEWAY_PORT: undefined,
      OPENCLAW_HOME: undefined,
      OPENCLAW_STATE_DIR: undefined,
      OPENCLAW_CONFIG_PATH: undefined,
      OPENCLAW_PROFILE: undefined,
      OPENCLAW_SUPERVISOR_MODE: undefined,
      OPENCLAW_SERVICE_MARKER: undefined,
      OPENCLAW_SERVICE_KIND: undefined,
    },
    () => run(home),
  );
}

it.each([
  {
    stage: "registration",
    responses: ["timeout", "found", "found", "found", "found", "found"],
    recovered: true,
  },
  {
    stage: "revalidation",
    responses: ["found", "timeout", "found", "found", "found", "found", "found"],
    recovered: true,
  },
  { stage: "registration", responses: ["timeout", "timeout"], recovered: false },
  { stage: "revalidation", responses: ["found", "timeout", "found", "timeout"], recovered: false },
  {
    stage: "command then runtime",
    responses: ["timeout", "found", "found", "timeout"],
    recovered: false,
  },
  { stage: "unavailable", responses: ["unavailable"], recovered: false },
])("keeps strict Scheduled Task inspection through $stage failures: $responses", (scenario) =>
  withServiceHome(async (home) => {
    mockProcessPlatform("win32");
    const scriptPath = "C:\\Registered Service\\gateway.cmd";
    const script = Buffer.from(
      buildTaskScript({
        programArguments: [process.execPath, path.join(process.cwd(), "openclaw.mjs"), "gateway"],
        environment: { HOME: home },
      }),
    );
    const nativeReadFile = fs.readFile;
    vi.spyOn(fs, "readFile").mockImplementation(async (pathname, options) =>
      pathname === scriptPath ? script : nativeReadFile(pathname, options),
    );
    vi.mocked(spawnSync).mockReset();
    for (const response of scenario.responses) {
      const stdout =
        response === "found"
          ? JSON.stringify({
              taskPath: "\\OpenClaw Gateway",
              state: 4,
              actions: [{ type: 0, path: scriptPath, arguments: "", workingDirectory: "" }],
            })
          : "";
      vi.mocked(spawnSync).mockReturnValueOnce({
        pid: 0,
        output: [null, stdout, ""],
        stdout,
        stderr: "",
        status: response === "found" ? 0 : response === "unavailable" ? 2 : null,
        signal: null,
        ...(response === "timeout"
          ? { error: Object.assign(new Error("probe timed out"), { code: "ETIMEDOUT" }) }
          : {}),
      });
    }
    const service = createMockGatewayService({
      readCommand: vi.fn(readScheduledTaskCommand),
      readRuntime: readScheduledTaskRuntime,
      isLoaded: async () => true,
    });
    mocks.service.mockReturnValue(service);
    const inspected = await maybeStopManagedServiceBeforeMutableUpdate({
      root: process.cwd(),
      updateInstallKind: "package",
      shouldRestart: true,
      phase: "inspect",
      jsonMode: true,
      timeoutMs: 47_000,
    });
    expect(inspected.serviceUpdateVerdict?.kind).toBe(scenario.recovered ? "owned" : "unavailable");
    if (scenario.recovered) {
      expect(inspected.running).toBe(true);
      expect(inspected.serviceEnv?.HOME).toBe(home);
    } else {
      expect(inspected.serviceMutationSkipMessage).toContain(
        scenario.stage === "unavailable"
          ? "Task Scheduler probe failed (exit 2)."
          : scenario.stage === "command then runtime"
            ? "Scheduled Task probe timed out after 47000 ms (ETIMEDOUT)."
            : "Task Scheduler probe timed out after 47000 ms.",
      );
      if (scenario.stage !== "command then runtime") {
        expect(inspected.serviceUpdateVerdict).toMatchObject({
          inspectionReason: "windows-task-inspection-failed",
        });
      }
      expect(inspected.serviceEnv).toBeUndefined();
    }
    expect(spawnSync).toHaveBeenCalledTimes(scenario.responses.length);
    for (const call of vi.mocked(spawnSync).mock.calls) {
      expect(call[2]?.timeout).toBe(47_000);
    }
    expect(service.readCommand).toHaveBeenCalledTimes(scenario.stage === "unavailable" ? 1 : 2);
    for (const [, options] of vi.mocked(service.readCommand).mock.calls) {
      expect(options).toMatchObject({
        requireEffective: true,
        requireLoaded: true,
        timeoutMs: 47_000,
      });
    }
    expect(service.stop).not.toHaveBeenCalled();
    expect(service.install).not.toHaveBeenCalled();
  }),
);
