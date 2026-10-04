import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createAgentCleanupScope } from "../agents/run-cleanup-timeout.js";
import { CommandProcessCleanupError } from "../process/exec-result.js";
import {
  readUpdateRepairMaintenanceRequest,
  runUpdateRepairMaintenance,
} from "./update-repair-maintenance.js";

const external = vi.hoisted(() => ({ entry: vi.fn(), command: vi.fn() }));
vi.mock("../daemon/gateway-entrypoint.js", () => ({
  resolveGatewayInstallEntrypoint: external.entry,
}));
vi.mock("../process/exec.js", () => ({ runUtf8CommandWithTimeout: external.command }));
afterEach(() => vi.unstubAllGlobals());
beforeEach(() => {
  external.entry.mockReset().mockResolvedValue("/synthetic/install/dist/index.js");
  external.command
    .mockReset()
    .mockResolvedValue({ termination: "exit", code: 0, stdout: "", stderr: "" });
});
const target = {
  installRoot: "/synthetic/install",
  stateDir: "/synthetic/state",
  configPath: "/synthetic/config",
  workspaceDir: "/synthetic/workspace",
};

it.each([
  { operation: "doctor-fix", activate: false },
  { operation: "update-repair", activate: false },
  { operation: "update-repair", activate: true },
] as const)(
  "executes typed $operation with activation=$activate on the selected installation",
  async ({ operation, activate }) => {
    vi.stubGlobal("process", {
      ...process,
      execPath: "/synthetic/app-runtime",
      versions: { ...process.versions, bun: "1.4.3" },
    });
    const request = readUpdateRepairMaintenanceRequest({
      stopReason: "tool_calls",
      pendingToolCalls: [
        { name: "request_update_maintenance", arguments: JSON.stringify({ operation }) },
      ],
    });
    expect(request).toEqual({ operation });
    const current = vi.fn();
    const signal = new AbortController().signal;
    await runUpdateRepairMaintenance({
      request: request!,
      allowGatewayActivation: activate,
      target,
      env: activate
        ? { OPENCLAW_SERVICE_REPAIR_POLICY: "external" }
        : {
            OPENCLAW_STATE_DIR: target.stateDir,
            OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION: "1",
          },
      signal,
      assertCurrent: current,
    });
    expect(current).toHaveBeenCalledOnce();
    expect(external.command).toHaveBeenCalledExactlyOnceWith(
      [
        "/synthetic/app-runtime",
        "/synthetic/install/dist/index.js",
        ...(operation === "update-repair"
          ? ["update", "repair", "--yes", "--json", ...(activate ? [] : ["--no-restart"])]
          : ["doctor", "--fix", "--non-interactive"]),
      ],
      expect.objectContaining({
        cwd: target.installRoot,
        baseEnv: {},
        env: activate
          ? { OPENCLAW_SERVICE_REPAIR_POLICY: "external", OPENCLAW_SHELL: "exec" }
          : expect.objectContaining({
              OPENCLAW_STATE_DIR: target.stateDir,
              OPENCLAW_SHELL: "exec",
              OPENCLAW_UPDATE_IN_PROGRESS: "1",
              OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR: "0",
              OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION: "0",
              OPENCLAW_SERVICE_REPAIR_POLICY: "external",
            }),
        signal,
        killProcessTree: true,
        requireProcessTreeExtinction: true,
      }),
    );
  },
);

it.each(["revoked", "cancelled", "forced", "uncertain", "rejected"] as const)(
  "refuses to certify maintenance after %s",
  async (cause) => {
    const controller = new AbortController();
    const beforeLaunch = cause === "revoked" || cause === "cancelled";
    let current = true;
    if (beforeLaunch) {
      external.entry.mockImplementation(async () => {
        current = false;
        if (cause === "cancelled") {
          controller.abort(new Error("cancelled"));
        }
        return "/synthetic/install/dist/index.js";
      });
    } else if (cause === "rejected") {
      external.command.mockRejectedValue(new CommandProcessCleanupError());
    } else {
      external.command.mockResolvedValue({
        termination: "exit",
        code: 0,
        stdout: "",
        stderr: "",
        cleanup: cause,
      });
    }
    const owner = createAgentCleanupScope();
    await expect(
      owner.run(() =>
        runUpdateRepairMaintenance({
          request: { operation: beforeLaunch ? "update-repair" : "doctor-fix" },
          allowGatewayActivation: false,
          target,
          env: {},
          signal: controller.signal,
          assertCurrent: () => {
            if (!current) {
              throw new Error("revoked");
            }
          },
        }),
      ),
    ).rejects.toThrow(beforeLaunch ? cause : /cleanup/i);
    if (beforeLaunch) {
      expect(external.command).not.toHaveBeenCalled();
    } else {
      expect(owner.outcome).toBe("uncertain");
    }
  },
);

it.each([
  {
    stopReason: "stop",
    pendingToolCalls: [
      { name: "request_update_maintenance", arguments: '{"operation":"doctor-fix"}' },
    ],
  },
  {
    stopReason: "tool_calls",
    pendingToolCalls: [{ name: "exec", arguments: '{"operation":"doctor-fix"}' }],
  },
  {
    stopReason: "tool_calls",
    pendingToolCalls: [
      {
        name: "request_update_maintenance",
        arguments: '{"operation":"doctor-fix","command":"anything"}',
      },
    ],
  },
  {
    stopReason: "tool_calls",
    pendingToolCalls: [
      { name: "request_update_maintenance", arguments: '{"operation":"doctor-fix"}' },
      { name: "request_update_maintenance", arguments: '{"operation":"update-repair"}' },
    ],
  },
])("refuses malformed or ambiguous terminal maintenance requests: %j", (meta) => {
  expect(() => readUpdateRepairMaintenanceRequest(meta)).toThrow();
});
