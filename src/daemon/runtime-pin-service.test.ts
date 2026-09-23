import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { readLaunchAgentProgramArguments } from "./launchd.js";
import { resolveNodeService } from "./node-service.js";
import { readDaemonRuntimePin } from "./runtime-pin-state.js";
import type { GatewayServiceCommandConfig, GatewayServiceInstallArgs } from "./service-types.js";
import { resolveGatewayService } from "./service.js";
const native = vi.hoisted(() => ({
  command: null as GatewayServiceCommandConfig | null,
  install: vi.fn(),
  stage: vi.fn(),
  uninstall: vi.fn(),
}));
vi.mock("./launchd.js", () => ({
  installLaunchAgent: native.install,
  stageLaunchAgent: native.stage,
  uninstallLaunchAgent: native.uninstall,
  readLaunchAgentProgramArguments: vi.fn(async () => native.command),
  isLaunchAgentEnabled: vi.fn(),
  isLaunchAgentLoaded: vi.fn(),
  readLaunchAgentRuntime: vi.fn(),
  restartLaunchAgent: vi.fn(),
  startLaunchAgent: vi.fn(),
  stopLaunchAgent: vi.fn(),
}));
vi.mock("../infra/tmp-openclaw-dir.js", () => ({
  resolvePreferredOpenClawTmpDir: () => {
    const root = process.env.OPENCLAW_STATE_DIR;
    if (!root) {
      throw new Error("Synthetic state required");
    }
    return root;
  },
}));
vi.mock("./future-config-guard.js", () => ({
  assertFutureConfigActionAllowed: vi.fn(async () => {}),
}));
vi.mock("../infra/gateway-supervision.js", () => ({
  assertGatewayServiceMutationAllowed: vi.fn(),
}));
beforeEach(() => {
  vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  native.command = null;
  const write = async (args: GatewayServiceInstallArgs) => {
    native.command = {
      programArguments: args.programArguments,
      workingDirectory: args.workingDirectory,
    };
  };
  native.install.mockReset().mockImplementation(write);
  native.stage.mockReset().mockImplementation(write);
  native.uninstall.mockReset().mockImplementation(async () => {
    native.command = null;
  });
});
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
});
describe("native service runtime pin persistence", () => {
  it.each(["gateway", "node"] as const)(
    "refuses pin-unaware %s rewrites before changing the native definition",
    async (kind) => {
      await withOpenClawTestState({ label: "pin-native-unplanned" }, async (state) => {
        const service = kind === "gateway" ? resolveGatewayService() : resolveNodeService();
        const scope = { kind, env: state.env };
        const pin = { runtime: "node" as const, path: "/runtime/node" };
        await service.stage({
          env: state.env,
          stdout: process.stdout,
          programArguments: [pin.path, "/app/openclaw.mjs", kind],
          runtimePinUpdate: { expected: readDaemonRuntimePin(scope, null), pin },
        });
        const previous = native.command;
        const replacement = {
          env: state.env,
          stdout: process.stdout,
          programArguments: [pin.path, "/updated/openclaw.mjs", kind],
        };
        await expect(service.install(replacement)).rejects.toThrow(/explicit runtime intent/);
        await expect(service.stage(replacement)).rejects.toThrow(/explicit runtime intent/);
        expect(native.install).not.toHaveBeenCalled();
        expect(native.stage).toHaveBeenCalledOnce();
        expect(native.command).toBe(previous);
        expect(readDaemonRuntimePin(scope, native.command).pin).toEqual(pin);
      });
    },
  );
  it("keeps pin-unaware default writes read-only for runtime metadata", async () => {
    await withOpenClawTestState({ label: "pin-native-default" }, async (state) => {
      const service = resolveGatewayService();
      const args = {
        env: state.env,
        stdout: process.stdout,
        programArguments: ["/runtime/node", "/app/openclaw.mjs", "gateway"],
      };
      await service.stage(args);
      await service.install(args);
      expect(native.stage).toHaveBeenCalledOnce();
      expect(native.install).toHaveBeenCalledOnce();
      expect(readDaemonRuntimePin({ kind: "gateway", env: state.env }, native.command).stored).toBe(
        false,
      );
      expect(fs.existsSync(state.statePath("state", "openclaw.sqlite"))).toBe(false);
    });
  });
  it.each(["gateway", "node"] as const)(
    "commits %s staged definitions, preserves intent on reinstall, and removes it on uninstall",
    async (kind) => {
      await withOpenClawTestState({ label: "pin-native" }, async (state) => {
        const service = kind === "gateway" ? resolveGatewayService() : resolveNodeService();
        const scope = { kind, env: state.env };
        const pin = { runtime: "node" as const, path: "/runtime/node" };
        const args = {
          env: state.env,
          stdout: process.stdout,
          programArguments: [pin.path, "/app/openclaw.mjs", kind],
          runtimePinUpdate: { expected: readDaemonRuntimePin(scope, null), pin },
        };
        await service.stage(args);
        expect(readDaemonRuntimePin(scope, native.command).pin).toEqual(pin);
        const expected = readDaemonRuntimePin(scope, native.command);
        await service.install({
          ...args,
          programArguments: [pin.path, "/updated/openclaw.mjs", kind],
          runtimePinUpdate: { expected, pin },
        });
        expect(readDaemonRuntimePin(scope, native.command).pin).toEqual(pin);
        await service.uninstall({ env: state.env, stdout: process.stdout });
        expect(readDaemonRuntimePin(scope, null).stored).toBe(false);
      });
    },
  );
  it("does not commit on failed native write or mismatched readback", async () => {
    await withOpenClawTestState({ label: "pin-native-failure" }, async (state) => {
      const scope = { kind: "gateway" as const, env: state.env };
      const service = resolveGatewayService();
      const pin = { runtime: "node" as const, path: "/runtime/node" };
      const args = {
        env: state.env,
        stdout: process.stdout,
        programArguments: [pin.path, "gateway"],
        runtimePinUpdate: { expected: readDaemonRuntimePin(scope, null), pin },
      };
      native.install.mockRejectedValueOnce(new Error("native failure"));
      await expect(service.install(args)).rejects.toThrow(/native failure/);
      expect(readDaemonRuntimePin(scope, null).stored).toBe(false);
      native.install.mockImplementationOnce(async () => {
        native.command = { programArguments: ["/other/node"] };
      });
      await expect(service.install(args)).rejects.toThrow(/readback differs/);
      expect(readDaemonRuntimePin(scope, null).stored).toBe(false);
    });
  });
  it("does not claim an unchanged definition when custody is lost during installed pin readback", async () => {
    await withOpenClawTestState({ label: "pin-native-custody" }, async (state) => {
      const scope = { kind: "gateway" as const, env: state.env };
      const service = resolveGatewayService();
      const pin = { runtime: "node" as const, path: "/runtime/node" };
      const args = {
        env: state.env,
        stdout: process.stdout,
        programArguments: [pin.path, "/app/openclaw.mjs", "gateway"],
      };
      await service.stage({
        ...args,
        runtimePinUpdate: { expected: readDaemonRuntimePin(scope, null), pin },
      });
      const previous = native.command;
      const expected = readDaemonRuntimePin(scope, previous);
      let current = true;
      vi.mocked(readLaunchAgentProgramArguments)
        .mockImplementationOnce(async () => native.command)
        .mockImplementationOnce(async () => {
          current = false;
          return native.command;
        });
      const programArguments = [pin.path, "/updated/openclaw.mjs", "gateway"];
      await expect(
        service.install({
          ...args,
          programArguments,
          runtimePinUpdate: { expected, pin },
          assertCurrent: () => {
            if (!current) {
              throw new Error("Custody released during native readback");
            }
          },
        }),
      ).rejects.toMatchObject({ code: "service-authority-revoked", outcome: undefined });
      expect(native.command?.programArguments).toEqual(programArguments);
      expect(readDaemonRuntimePin(scope, previous)).toEqual(expected);
    });
  });
  it("refuses a definition changed after planning without writing or clearing prior metadata", async () => {
    await withOpenClawTestState({ label: "pin-native-drift" }, async (state) => {
      const scope = { kind: "gateway" as const, env: state.env };
      const service = resolveGatewayService();
      const expected = readDaemonRuntimePin(scope, null);
      native.command = { programArguments: ["/external/node", "gateway"] };
      await expect(
        service.install({
          env: state.env,
          stdout: process.stdout,
          programArguments: ["/runtime/node", "gateway"],
          runtimePinUpdate: { expected, pin: { runtime: "node", path: "/runtime/node" } },
        }),
      ).rejects.toThrow(/changed during/);
      expect(native.install).not.toHaveBeenCalled();
      expect(readDaemonRuntimePin(scope, null).stored).toBe(false);
    });
  });
  it("serializes concurrent pin plans and refuses the stale writer before native mutation", async () => {
    await withOpenClawTestState({ label: "pin-native-concurrent" }, async (state) => {
      const scope = { kind: "gateway" as const, env: state.env };
      const service = resolveGatewayService();
      const pin = { runtime: "node" as const, path: "/runtime/node" };
      const args = {
        env: state.env,
        stdout: process.stdout,
        programArguments: [pin.path, "gateway"],
        runtimePinUpdate: { expected: readDaemonRuntimePin(scope, null), pin },
      };
      const outcomes = await Promise.allSettled([service.install(args), service.install(args)]);
      expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(outcomes.filter((r) => r.status === "rejected")).toHaveLength(1);
      expect(native.install).toHaveBeenCalledOnce();
      expect(readDaemonRuntimePin(scope, native.command).pin).toEqual(pin);
    });
  });
});
