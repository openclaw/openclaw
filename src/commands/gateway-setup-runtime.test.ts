import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runtimeFixture } from "../cli/update-cli/update-command-fixtures.test-support.js";
import * as runtimePaths from "../daemon/runtime-paths.js";
import type { DaemonRuntimePinSnapshot } from "../daemon/runtime-pin-types.js";
import { resolveDaemonInstallRuntimeInputs } from "./daemon-install-plan.shared.js";
import type { GatewayDaemonRuntime } from "./daemon-runtime.js";
import { resolveGatewaySetupRuntime } from "./gateway-setup-runtime.js";

const readPin = vi.hoisted(() => vi.fn<() => DaemonRuntimePinSnapshot>());
const bunVersion = Object.getOwnPropertyDescriptor(process.versions, "bun");
// mock-isolation: Runtime selection tests use supplied pin snapshots without opening disk state.
vi.mock("../daemon/runtime-pin-state.js", () => ({
  withDaemonRuntimePinMigration: async <T>(_env: NodeJS.ProcessEnv, run: () => T) => run(),
  readDaemonRuntimePinForInstall: readPin,
}));

beforeEach(() => {
  readPin.mockReset();
  readPin.mockReturnValue({ revision: "empty", stored: false });
});
afterEach(() => {
  vi.restoreAllMocks();
  if (bunVersion) {
    Object.defineProperty(process.versions, "bun", bunVersion);
  } else {
    delete process.versions.bun;
  }
});

it.each([true, false])(
  "keeps explicit runtime intent and persists only an existing pin (pinned=%s)",
  async (pinned) => {
    const pin = pinned ? { runtime: "bun" as const, path: "/opt/pinned/bun" } : undefined;
    const expected = { revision: pinned ? "version-2" : "empty", stored: pinned, pin };
    readPin.mockReturnValue(expected);
    const selectRuntime = vi.fn(async () => (pinned ? ("node" as const) : ("bun" as const)));
    const result = await resolveGatewaySetupRuntime({
      env: {},
      existingCommand: null,
      selectRuntime,
    });
    expect(result).toMatchObject({
      runtime: "bun",
      runtimeExplicit: true,
      pinnedRuntimePath: pin?.path,
      runtimePinUpdate: { expected, pin },
    });
    expect(result.runtimePinUpdate.expected).toBe(expected);
    expect(selectRuntime).toHaveBeenCalledTimes(pinned ? 0 : 1);
  },
);

it.each([
  { flow: "advanced", nodePath: undefined, suggested: "bun" },
  { flow: "advanced", nodePath: "/opt/node/bin/node", suggested: "node" },
  { flow: "quickstart", nodePath: undefined, suggested: "node" },
] as const)(
  "suggests $suggested for $flow with Node at $nodePath",
  async ({ flow, nodePath, suggested }) => {
    Object.defineProperty(process.versions, "bun", { configurable: true, value: "1.4.4" });
    vi.spyOn(runtimePaths, "resolvePreferredNodePath").mockResolvedValue(nodePath);
    vi.spyOn(runtimePaths, "resolveBunRuntimeInfo").mockResolvedValue(
      runtimeFixture("1.4.4", "3.53.4"),
    );
    const select = vi.fn(async (runtime: GatewayDaemonRuntime) => runtime);
    const selection = await resolveGatewaySetupRuntime({
      env: {},
      existingCommand: null,
      selectRuntime: flow === "advanced" ? select : undefined,
    });
    expect(selection).toMatchObject({
      runtime: suggested,
      runtimeExplicit: flow === "advanced",
      runtimePath: suggested === "bun" ? process.execPath : undefined,
      runtimePinUpdate: { pin: undefined },
    });
    if (flow === "advanced") {
      expect(select).toHaveBeenCalledExactlyOnceWith(suggested);
    } else {
      expect(select).not.toHaveBeenCalled();
      await expect(resolveDaemonInstallRuntimeInputs(selection)).resolves.toMatchObject({
        runtime: "bun",
        runtimePath: process.execPath,
      });
    }
  },
);

it.each([undefined, "", "/caller/wrapper"])(
  "preserves wrapper precedence (%s)",
  async (wrapper) => {
    const result = await resolveGatewaySetupRuntime({
      env: { OPENCLAW_WRAPPER: wrapper },
      existingCommand: {
        programArguments: ["/effective-wrapper"],
        environment: { OPENCLAW_WRAPPER: "/ignored/override" },
        managedDefinition: {
          programArguments: ["node"],
          environment: { OPENCLAW_WRAPPER: "/stored/wrapper" },
        },
      },
    });
    expect(result).toMatchObject({
      env: { OPENCLAW_WRAPPER: wrapper ?? "/stored/wrapper" },
      runtime: "node",
      runtimePinUpdate: { pin: undefined },
    });
  },
);
