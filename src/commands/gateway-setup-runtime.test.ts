/** Setup runtime choices preserve pin intent without persisting automatic selection. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DaemonRuntimePinSnapshot } from "../daemon/runtime-pin-types.js";
import { resolveGatewaySetupRuntime } from "./gateway-setup-runtime.js";

const readPin = vi.hoisted(() => vi.fn<() => DaemonRuntimePinSnapshot>());
vi.mock("../daemon/runtime-pin-state.js", () => ({ readDaemonRuntimePinForInstall: readPin }));

describe("setup runtime intent", () => {
  beforeEach(() => {
    readPin.mockReset();
    readPin.mockReturnValue({ revision: "empty", stored: false });
  });

  it.each(["node", "bun"] as const)(
    "preserves %s pins and the inspected revision",
    async (runtime) => {
      const pin = { runtime, path: `/opt/pinned/${runtime}` };
      const expected = { revision: "version-2", stored: true, pin };
      readPin.mockReturnValue(expected);
      const selectRuntime = vi.fn(async () => "node" as const);
      const result = await resolveGatewaySetupRuntime({
        env: {},
        existingCommand: null,
        selectRuntime,
      });
      expect(result).toMatchObject({
        runtime,
        pinnedRuntimePath: pin.path,
        runtimePinUpdate: { expected, pin },
      });
      expect(result.runtimePinUpdate.expected).toBe(expected);
      expect(selectRuntime).not.toHaveBeenCalled();
    },
  );

  it("keeps automatic interactive choices unpinned", async () => {
    const selectRuntime = vi.fn(async () => "bun" as const);
    const result = await resolveGatewaySetupRuntime({
      env: {},
      existingCommand: null,
      selectRuntime,
    });
    expect(result).toMatchObject({ runtime: "bun", runtimePinUpdate: { pin: undefined } });
    expect(result.pinnedRuntimePath).toBeUndefined();
    expect(selectRuntime).toHaveBeenCalledOnce();
  });

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
      expect(result.env.OPENCLAW_WRAPPER).toBe(wrapper ?? "/stored/wrapper");
      expect(result.runtime).toBe("node");
      expect(result.runtimePinUpdate.pin).toBeUndefined();
    },
  );
});
