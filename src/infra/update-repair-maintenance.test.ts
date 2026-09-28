import { beforeEach, expect, it, vi } from "vitest";
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

it.each(["doctor-fix", "update-repair"] as const)(
  "executes only the typed %s continuation on the selected installation",
  async (operation) => {
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
      allowGatewayActivation: false,
      target,
      env: {
        OPENCLAW_STATE_DIR: target.stateDir,
        OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION: "1",
      },
      signal,
      assertCurrent: current,
    });
    expect(current).toHaveBeenCalledOnce();
    expect(external.command).toHaveBeenCalledExactlyOnceWith(
      [
        expect.any(String),
        "/synthetic/install/dist/index.js",
        ...(operation === "update-repair"
          ? ["update", "repair", "--yes", "--json", "--no-restart"]
          : ["doctor", "--fix", "--non-interactive"]),
      ],
      expect.objectContaining({
        cwd: target.installRoot,
        baseEnv: {},
        env: expect.objectContaining({
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

it.each(["revoked", "cancelled"])(
  "does not launch maintenance when %s during entrypoint resolution",
  async (cause) => {
    const controller = new AbortController();
    let current = true;
    external.entry.mockImplementation(async () => {
      current = false;
      if (cause === "cancelled") {
        controller.abort(new Error("cancelled"));
      }
      return "/synthetic/install/dist/index.js";
    });
    await expect(
      runUpdateRepairMaintenance({
        request: { operation: "update-repair" },
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
    ).rejects.toThrow(cause);
    expect(external.command).not.toHaveBeenCalled();
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

it.each(["forced", "uncertain", "rejected"] as const)(
  "cannot certify the repair owner after %s maintenance cleanup",
  async (cleanup) => {
    if (cleanup === "rejected") {
      external.command.mockRejectedValue(new CommandProcessCleanupError());
    } else {
      external.command.mockResolvedValue({
        termination: "exit",
        code: 0,
        stdout: "",
        stderr: "",
        cleanup,
      });
    }
    const owner = createAgentCleanupScope();
    await expect(
      owner.run(() =>
        runUpdateRepairMaintenance({
          request: { operation: "doctor-fix" },
          allowGatewayActivation: false,
          target,
          env: {},
          signal: new AbortController().signal,
          assertCurrent: () => {},
        }),
      ),
    ).rejects.toThrow(/cleanup/i);
    expect(owner.outcome).toBe("uncertain");
  },
);

it("leaves an intended-running recovery with the native maintenance owner", async () => {
  await runUpdateRepairMaintenance({
    request: { operation: "update-repair" },
    allowGatewayActivation: true,
    target,
    env: { OPENCLAW_SERVICE_REPAIR_POLICY: "external" },
    signal: new AbortController().signal,
    assertCurrent: () => {},
  });
  expect(external.command).toHaveBeenCalledExactlyOnceWith(
    [expect.any(String), "/synthetic/install/dist/index.js", "update", "repair", "--yes", "--json"],
    expect.objectContaining({
      env: { OPENCLAW_SERVICE_REPAIR_POLICY: "external", OPENCLAW_SHELL: "exec" },
    }),
  );
});
