import fs from "node:fs";
import { afterEach, beforeEach, expect, it as base, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import * as sqliteSnapshots from "../infra/sqlite-snapshot-source.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { readLaunchAgentProgramArguments } from "./launchd.js";
import { resolveNodeService } from "./node-service.js";
import {
  commitDaemonRuntimePin,
  readDaemonRuntimePin,
  readDaemonRuntimePinMigrationPending,
  withDaemonRuntimePinMigration,
} from "./runtime-pin-state.js";
import { withDaemonRuntimePinStore } from "./runtime-pin-store.js";
import type { DaemonRuntimePinSnapshot, DaemonRuntimePinUpdate } from "./runtime-pin-types.js";
import { withGatewayServiceOperationLock } from "./service-operation-lock.js";
import type * as Service from "./service-types.js";
import { readGatewayServiceState, resolveGatewayService } from "./service.js";
const native = vi.hoisted(() => ({
  command: null as Service.GatewayServiceCommandConfig | null,
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
  native.command = null;
  native.loaded.mockReset().mockResolvedValue(true);
  native.runtime.mockReset().mockResolvedValue({ status: "running" });
  native.stop.mockReset().mockImplementation(async (args: Service.GatewayServiceControlArgs) => {
    native.runtime.mockResolvedValue({ status: "stopped" });
    if (args.disable) {
      native.loaded.mockResolvedValue(false);
    }
  });
  const write = async (args: Service.GatewayServiceInstallArgs) => {
    const { programArguments, workingDirectory } = args;
    native.command = { programArguments, workingDirectory };
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

function pinFixture(env: NodeJS.ProcessEnv, kind: "gateway" | "node") {
  const scope = { kind, env };
  const pin = { runtime: "node" as const, path: "/runtime/node" };
  const readPin = (command = native.command) => readDaemonRuntimePin(scope, command);
  return {
    readPin,
    scope,
    pin,
    service: kind === "gateway" ? resolveGatewayService() : resolveNodeService(),
    args: {
      env,
      stdout: process.stdout,
      programArguments: [pin.path, "/app/openclaw.mjs", kind],
      runtimePinUpdate: { expected: readDaemonRuntimePin(scope, null), pin },
    },
  };
}

const bundledPin = { runtime: "bun", path: "/bundled/bun" } as const;
const pausedService = /Start it before choosing Use bundled runtime/;
function bundledArgs(
  args: Service.GatewayServiceInstallArgs,
  expected: DaemonRuntimePinSnapshot,
  overrides: Partial<DaemonRuntimePinUpdate> = {},
): Service.GatewayServiceInstallArgs {
  return {
    ...args,
    programArguments: [bundledPin.path, "/app/openclaw.mjs", "gateway"],
    runtimePinUpdate: { expected, pin: bundledPin, ...overrides },
  };
}

const it = base.extend<{ state: OpenClawTestState; pins: ReturnType<typeof pinFixture> }>({
  state: async ({ task }, use) =>
    withOpenClawTestState({ label: task.name }, async (state) => {
      // Create private files on the real host before spoofing Darwin.
      withDaemonRuntimePinStore(state.env, true, () => undefined);
      const platform = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
      try {
        await use(state);
      } finally {
        platform.mockRestore();
      }
    }),
  pins: async ({ state }, use) => {
    await withDaemonRuntimePinMigration(state.env, () => undefined);
    await use(pinFixture(state.env, "gateway"));
  },
});

async function withoutSnapshots(run: () => Promise<void>) {
  await closeStateDatabaseForTest();
  const snapshots = vi.spyOn(sqliteSnapshots, "prepareSqliteReadOnlyLocationSync");
  try {
    await run();
    expect(snapshots).not.toHaveBeenCalled();
  } finally {
    snapshots.mockRestore();
  }
}
it.for(["gateway", "node"] as const)(
  "admits pending migration before %s uninstall",
  async (kind, { state }) => {
    const service = kind === "gateway" ? resolveGatewayService() : resolveNodeService();
    expect(readDaemonRuntimePinMigrationPending(state.env)).toBe(true);
    native.uninstall.mockImplementationOnce(async () => {
      expect(readDaemonRuntimePinMigrationPending(state.env)).toBe(false);
    });
    await service.uninstall({ env: state.env, stdout: process.stdout });
    expect(native.uninstall).toHaveBeenCalledOnce();
  },
);

it.for(["before-native-write", "before-persistence"] as const)(
  "rejects a pin changed %s without overwriting the newer intent",
  async (phase, { pins: { scope, service, pin, args, readPin } }) => {
    commitDaemonRuntimePin(scope, args.runtimePinUpdate, args);
    native.command = args;
    const expected = readPin(args);
    const newerPin = { runtime: "bun" as const, path: "/operator/bun" };
    const changePin = async () => {
      commitDaemonRuntimePin(scope, { expected, pin: newerPin }, args);
      return native.command;
    };
    const read = vi.mocked(readLaunchAgentProgramArguments);
    if (phase === "before-persistence") {
      read.mockImplementationOnce(async () => native.command);
    }
    read.mockImplementationOnce(changePin);
    await expect(service.install({ ...args, runtimePinUpdate: { expected, pin } })).rejects.toThrow(
      /Runtime pin changed/,
    );
    expect(native.install).toHaveBeenCalledTimes(phase === "before-native-write" ? 0 : 1);
    expect(readPin(args).pin).toEqual(newerPin);
  },
);

it("keeps pin-unaware writes read-only", async ({ state }) => {
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
it.for(["gateway", "node"] as const)(
  "requires explicit %s runtime intent for rewrites and removes the pin on uninstall",
  async (kind, { state }) => {
    await withDaemonRuntimePinMigration(state.env, () => undefined);
    const { service, pin, args, readPin } = pinFixture(state.env, kind);
    await service.stage(args);
    const { runtimePinUpdate, ...replacement } = args;
    replacement.programArguments = [pin.path, "/updated/openclaw.mjs", kind];
    await withoutSnapshots(async () => {
      await expect(service.install(replacement)).rejects.toThrow(/explicit runtime intent/);
      await expect(service.stage(replacement)).rejects.toThrow(/explicit runtime intent/);
    });
    expect(native.install).not.toHaveBeenCalled();
    expect(native.stage).toHaveBeenCalledOnce();
    expect(readPin().pin).toEqual(pin);
    const expected = readPin();
    await service.install({
      ...replacement,
      runtimePinUpdate: { ...runtimePinUpdate, expected },
    });
    expect(readPin().pin).toEqual(pin);
    await withoutSnapshots(() => service.uninstall(args));
    expect(readPin(null).stored).toBe(false);
  },
);
it("keeps pins after failed writes", async ({ pins: { service, args, readPin } }) => {
  args.programArguments = ["/runtime/node", "gateway"];
  native.install.mockRejectedValueOnce(new Error("native failure"));
  await expect(service.install(args)).rejects.toThrow(/native failure/);
  expect(readPin(null).stored).toBe(false);
  native.install.mockImplementationOnce(async () => {
    native.command = { programArguments: ["/other/node"] };
  });
  await expect(service.install(args)).rejects.toThrow(/readback differs/);
  expect(readPin(null).stored).toBe(false);
});
it("rejects custody loss during readback", async ({ pins: { service, pin, args, readPin } }) => {
  await service.stage(args);
  const previous = native.command;
  const expected = readPin(previous);
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
  expect(readPin(previous)).toEqual(expected);
});
it("serializes competing pin writes", async ({ pins: { service, pin, args, readPin } }) => {
  args.programArguments = [pin.path, "gateway"];
  const outcomes = await Promise.allSettled([service.install(args), service.install(args)]);
  expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(native.install).toHaveBeenCalledOnce();
  expect(readPin().pin).toEqual(pin);
});

it.for([false, true])(
  "preserves a stop before the guarded runtime writer acquires its lock (disable=%s)",
  async (disable, { pins: { service, args, readPin } }) => {
    native.command = { programArguments: ["/original/node", "/app/openclaw.mjs", "gateway"] };
    const original = native.command;
    const observed = await readGatewayServiceState(service, args);
    expect(observed.running).toBe(true);
    const expected = readPin(observed.command);
    const entered = createDeferred();
    const release = createDeferred();
    const stopping = withGatewayServiceOperationLock(args.env, async () => {
      entered.resolve();
      await release.promise;
      await service.stop({ ...args, disable });
    });
    await entered.promise;
    const install = service.install(
      bundledArgs(args, expected, { requireDefinitionMatch: true, requireRunning: true }),
    );
    const refused = expect(install).rejects.toThrow(pausedService);
    release.resolve();
    await Promise.all([stopping, refused]);
    expect(native.stop).toHaveBeenCalledOnce();
    expect(native.install).not.toHaveBeenCalled();
    expect(readPin(original)).toEqual(expected);
  },
);

it.for([
  ["unpinned", "install"],
  ["drift", "install"],
  ["fresh-drift", "install"],
  ["running", "stage"],
  ["running", "install"],
  ["unknown", "install"],
  ["inspection-failed", "install"],
  ["disabled", "install"],
] as const)(
  "guards a %s runtime %s under the native lock",
  async ([mode, action], { pins: { service, args, readPin } }) => {
    native.command = { programArguments: ["/original/node", "/app/openclaw.mjs", "gateway"] };
    const fresh = mode === "fresh-drift";
    const drift = mode === "drift" || fresh;
    const expected = readPin(fresh ? null : native.command);
    const requiresRunning = mode !== "unpinned" && !drift;
    const pinned = mode === "running" || fresh;
    if (drift) {
      native.command = { programArguments: ["/operator/node", "/app/openclaw.mjs", "gateway"] };
    } else if (mode === "inspection-failed") {
      native.runtime.mockRejectedValue(new Error("native inspection failed"));
    } else if (mode === "disabled") {
      native.loaded.mockResolvedValue(false);
    } else if (mode === "unknown") {
      native.runtime.mockResolvedValue({ status: "unknown" });
    }
    const previous = native.command;
    const runtime = requiresRunning ? bundledPin.path : "/retained/node";
    const programArguments = [runtime, "/app/openclaw.mjs", "gateway"];
    const runtimePinUpdate: DaemonRuntimePinUpdate = {
      expected,
      ...(pinned
        ? { pin: fresh ? args.runtimePinUpdate.pin : bundledPin }
        : { requireDefinitionMatch: true }),
      ...(requiresRunning ? { requireRunning: true } : {}),
    };
    const write = service[action]({
      ...args,
      programArguments,
      runtimePinUpdate,
    });
    if (drift || (requiresRunning && !pinned)) {
      await expect(write).rejects.toThrow(
        drift ? /changed during runtime pin planning/ : pausedService,
      );
      expect(native[action]).not.toHaveBeenCalled();
      if (!drift) {
        expect(readPin(previous)).toEqual(expected);
      }
    } else {
      await write;
      expect(native[action]).toHaveBeenCalledOnce();
      expect(native.command?.programArguments).toEqual(programArguments);
    }
    expect(readPin()).toMatchObject(pinned && !drift ? { pin: bundledPin } : { stored: false });
  },
);

it("allows first runtime install", async ({ pins: { service, args, readPin } }) => {
  native.loaded.mockResolvedValue(false);
  native.runtime.mockResolvedValue({ status: "stopped" });
  await service.install(bundledArgs(args, readPin(null), { requireDefinitionMatch: true }));
  expect(native.install).toHaveBeenCalledOnce();
  expect(native.runtime).not.toHaveBeenCalled();
  expect(readPin().pin).toEqual(bundledPin);
});
