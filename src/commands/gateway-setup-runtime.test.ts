/** Setup runtime choices preserve pin intent without persisting automatic selection. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as runtimePaths from "../daemon/runtime-paths.js";
import type { DaemonRuntimePinSnapshot } from "../daemon/runtime-pin-types.js";
import type { WizardSelectParams } from "../wizard/prompts.js";
import { resolveOnboardingGatewayRuntime } from "../wizard/setup.service-runtime.js";
import { resolveDaemonInstallRuntimeInputs } from "./daemon-install-plan.shared.js";
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
        runtimeExplicit: true,
        pinnedRuntimePath: pin.path,
        runtimePinUpdate: { expected, pin },
      });
      expect(result.runtimePinUpdate.expected).toBe(expected);
      expect(selectRuntime).not.toHaveBeenCalled();
    },
  );

  it("keeps picker choices explicit without persisting a pin", async () => {
    const selectRuntime = vi.fn(async () => "bun" as const);
    const result = await resolveGatewaySetupRuntime({
      env: {},
      existingCommand: null,
      selectRuntime,
    });
    expect(result).toMatchObject({
      runtime: "bun",
      runtimeExplicit: true,
      runtimePinUpdate: { pin: undefined },
    });
    expect(result.pinnedRuntimePath).toBeUndefined();
    expect(selectRuntime).toHaveBeenCalledOnce();
  });

  it.each([
    { flow: "advanced", nodePath: undefined, suggested: "bun" },
    { flow: "advanced", nodePath: "/opt/node/bin/node", suggested: "node" },
    { flow: "quickstart", nodePath: undefined, suggested: "node" },
  ] as const)(
    "suggests $suggested for $flow with Node at $nodePath",
    async ({ flow, nodePath, suggested }) => {
      const bunVersion = Object.getOwnPropertyDescriptor(process.versions, "bun");
      Object.defineProperty(process.versions, "bun", { configurable: true, value: "1.4.2" });
      const discoverNode = vi
        .spyOn(runtimePaths, "resolvePreferredNodePath")
        .mockResolvedValue(nodePath);
      const probeBun = vi.spyOn(runtimePaths, "resolveBunRuntimeInfo").mockResolvedValue({
        status: "supported",
        version: "1.4.2",
        sqliteVersion: "3.53.4",
        sqliteProbe: { available: true, version: "3.53.4", text: true, blob: true, json: true },
        nodeSharedSqlite: false,
      });
      const prompter = {
        async select<T>({ initialValue }: WizardSelectParams<T>): Promise<T> {
          if (initialValue === undefined) {
            throw new Error("Missing runtime suggestion");
          }
          return initialValue;
        },
      };
      const select = vi.spyOn(prompter, "select");
      try {
        const selection = await resolveOnboardingGatewayRuntime({
          env: {},
          existingCommand: null,
          flow,
          prompter,
        });
        expect(selection.runtime).toBe(suggested);
        expect(selection.runtimeExplicit).toBe(flow === "advanced");
        expect(selection.runtimePath).toBe(suggested === "bun" ? process.execPath : undefined);
        expect(selection.runtimePinUpdate.pin).toBeUndefined();
        if (flow === "advanced") {
          expect(select).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ initialValue: suggested }),
          );
        } else {
          expect(select).not.toHaveBeenCalled();
          await expect(resolveDaemonInstallRuntimeInputs(selection)).resolves.toMatchObject({
            runtime: "bun",
            runtimePath: process.execPath,
          });
        }
      } finally {
        discoverNode.mockRestore();
        probeBun.mockRestore();
        if (bunVersion) {
          Object.defineProperty(process.versions, "bun", bunVersion);
        } else {
          delete process.versions.bun;
        }
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
      expect(result.env.OPENCLAW_WRAPPER).toBe(wrapper ?? "/stored/wrapper");
      expect(result.runtime).toBe("node");
      expect(result.runtimePinUpdate.pin).toBeUndefined();
    },
  );
});
