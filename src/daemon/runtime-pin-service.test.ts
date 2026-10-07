import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { readLaunchAgentProgramArguments } from "./launchd.js";
import { resolveNodeService } from "./node-service.js";
import { readDaemonRuntimePin } from "./runtime-pin-state.js";
import { withGatewayServiceOperationLock } from "./service-operation-lock.js";
import type {
  GatewayServiceCommandConfig,
  GatewayServiceControlArgs,
  GatewayServiceInstallArgs,
} from "./service-types.js";
import { readGatewayServiceState, resolveGatewayService } from "./service.js";
const native = vi.hoisted(() => ({
  command: null as GatewayServiceCommandConfig | null,
  install: vi.fn(),
  stage: vi.fn(),
  uninstall: vi.fn(),
  loaded: vi.fn(),
  runtime: vi.fn(),
  stop: vi.fn(),
}));
vi.mock("./launchd.js", () => ({
  installLaunchAgent: native.install,
  stageLaunchAgent: native.stage,
  uninstallLaunchAgent: native.uninstall,
  readLaunchAgentProgramArguments: vi.fn(async () => native.command),
  isLaunchAgentEnabled: vi.fn(),
  isLaunchAgentLoaded: native.loaded,
  readLaunchAgentRuntime: native.runtime,
  restartLaunchAgent: vi.fn(),
  startLaunchAgent: vi.fn(),
  stopLaunchAgent: native.stop,
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
  native.loaded.mockReset().mockResolvedValue(true);
  native.runtime.mockReset().mockResolvedValue({ status: "running" });
  native.stop.mockReset().mockImplementation(async (args: GatewayServiceControlArgs) => {
    native.runtime.mockResolvedValue({ status: "stopped" });
    if (args.disable) {
      native.loaded.mockResolvedValue(false);
    }
  });
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
    "requires explicit %s runtime intent for rewrites and removes the pin on uninstall",
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

  it.each([false, true])(
    "checks an unpinned guarded definition under the native lock (changed=%s)",
    async (changed) => {
      await withOpenClawTestState({ label: "pin-native-guarded-unpinned" }, async (state) => {
        const scope = { kind: "gateway" as const, env: state.env };
        const service = resolveGatewayService();
        native.command = { programArguments: ["/original/node", "/app/openclaw.mjs", "gateway"] };
        const expected = readDaemonRuntimePin(scope, native.command);
        if (changed) {
          native.command = { programArguments: ["/operator/node", "/app/openclaw.mjs", "gateway"] };
        }
        const previous = native.command;
        const programArguments = ["/retained/node", "/app/openclaw.mjs", "gateway"];
        const install = service.install({
          env: state.env,
          stdout: process.stdout,
          programArguments,
          runtimePinUpdate: { expected, requireDefinitionMatch: true },
        });
        if (changed) {
          await expect(install).rejects.toThrow(/changed during runtime pin planning/);
          expect(native.install).not.toHaveBeenCalled();
          expect(native.command).toBe(previous);
        } else {
          await install;
          expect(native.install).toHaveBeenCalledOnce();
          expect(native.command?.programArguments).toEqual(programArguments);
        }
        expect(readDaemonRuntimePin(scope, native.command).stored).toBe(false);
      });
    },
  );

  it.each([false, true])(
    "preserves a stop before the guarded runtime writer acquires its lock (disable=%s)",
    async (disable) => {
      await withOpenClawTestState({ label: "pin-native-intervening-stop" }, async (state) => {
        const scope = { kind: "gateway" as const, env: state.env };
        const service = resolveGatewayService();
        native.command = { programArguments: ["/original/node", "/app/openclaw.mjs", "gateway"] };
        const original = native.command;
        const observed = await readGatewayServiceState(service, { env: state.env });
        expect(observed.running).toBe(true);
        const expected = readDaemonRuntimePin(scope, observed.command);
        const entered = createDeferred();
        const release = createDeferred();
        const stopping = withGatewayServiceOperationLock(state.env, async () => {
          entered.resolve();
          await release.promise;
          await service.stop({ env: state.env, stdout: process.stdout, disable });
        });
        await entered.promise;
        const install = service.install({
          env: state.env,
          stdout: process.stdout,
          programArguments: ["/bundled/bun", "/app/openclaw.mjs", "gateway"],
          runtimePinUpdate: {
            expected,
            pin: { runtime: "bun", path: "/bundled/bun" },
            requireDefinitionMatch: true,
            requireRunning: true,
          },
        });
        const refused = expect(install).rejects.toThrow(
          /Start it before choosing Use bundled runtime/,
        );
        release.resolve();
        await Promise.all([stopping, refused]);
        expect(native.stop).toHaveBeenCalledOnce();
        expect(native.install).not.toHaveBeenCalled();
        expect(native.command).toBe(original);
        expect(readDaemonRuntimePin(scope, original)).toEqual(expected);
      });
    },
  );

  it.each(["stage", "install"] as const)(
    "admits a running service to a guarded %s",
    async (action) => {
      await withOpenClawTestState({ label: "pin-native-running" }, async (state) => {
        const scope = { kind: "gateway" as const, env: state.env };
        const service = resolveGatewayService();
        native.command = { programArguments: ["/original/node", "/app/openclaw.mjs", "gateway"] };
        const pin = { runtime: "bun" as const, path: "/bundled/bun" };
        await service[action]({
          env: state.env,
          stdout: process.stdout,
          programArguments: [pin.path, "/app/openclaw.mjs", "gateway"],
          runtimePinUpdate: {
            expected: readDaemonRuntimePin(scope, native.command),
            pin,
            requireRunning: true,
          },
        });
        expect(native[action]).toHaveBeenCalledOnce();
        expect(readDaemonRuntimePin(scope, native.command).pin).toEqual(pin);
      });
    },
  );

  it.each(["unknown", "inspection-failed", "disabled"])(
    "refuses a guarded runtime switch when native state is %s",
    async (reason) => {
      await withOpenClawTestState({ label: "pin-native-unknown-running" }, async (state) => {
        const scope = { kind: "gateway" as const, env: state.env };
        const service = resolveGatewayService();
        native.command = { programArguments: ["/original/node", "/app/openclaw.mjs", "gateway"] };
        const original = native.command;
        const expected = readDaemonRuntimePin(scope, original);
        if (reason === "inspection-failed") {
          native.runtime.mockRejectedValue(new Error("native inspection failed"));
        } else if (reason === "disabled") {
          native.loaded.mockResolvedValue(false);
        } else {
          native.runtime.mockResolvedValue({ status: "unknown" });
        }
        await expect(
          service.install({
            env: state.env,
            stdout: process.stdout,
            programArguments: ["/bundled/bun", "/app/openclaw.mjs", "gateway"],
            runtimePinUpdate: { expected, requireDefinitionMatch: true, requireRunning: true },
          }),
        ).rejects.toThrow(/Start it before choosing Use bundled runtime/);
        expect(native.install).not.toHaveBeenCalled();
        expect(native.command).toBe(original);
        expect(readDaemonRuntimePin(scope, original)).toEqual(expected);
      });
    },
  );

  it("admits a guarded fresh install without requiring an existing running service", async () => {
    await withOpenClawTestState({ label: "pin-native-fresh" }, async (state) => {
      const scope = { kind: "gateway" as const, env: state.env };
      const service = resolveGatewayService();
      native.loaded.mockResolvedValue(false);
      native.runtime.mockResolvedValue({ status: "stopped" });
      const pin = { runtime: "bun" as const, path: "/bundled/bun" };
      await service.install({
        env: state.env,
        stdout: process.stdout,
        programArguments: [pin.path, "/app/openclaw.mjs", "gateway"],
        runtimePinUpdate: {
          expected: readDaemonRuntimePin(scope, null),
          pin,
          requireDefinitionMatch: true,
        },
      });
      expect(native.install).toHaveBeenCalledOnce();
      expect(native.runtime).not.toHaveBeenCalled();
      expect(readDaemonRuntimePin(scope, native.command).pin).toEqual(pin);
    });
  });
});
