/** Setup runtime choices preserve pin intent without persisting automatic selection. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as runtimePaths from "../daemon/runtime-paths.js";
import type { DaemonRuntimePinSnapshot } from "../daemon/runtime-pin-types.js";
import { resolveDaemonInstallRuntimeInputs } from "./daemon-install-plan.shared.js";
import { resolveGatewaySetupRuntime } from "./gateway-setup-runtime.js";

const readPin = vi.hoisted(() => vi.fn<() => DaemonRuntimePinSnapshot>());
vi.mock("../daemon/runtime-pin-state.js", () => ({ readDaemonRuntimePinForInstall: readPin }));

describe("setup runtime intent", () => {
  beforeEach(() => {
    readPin.mockReset();
    readPin.mockReturnValue({ revision: "empty", stored: false });
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
      const select = vi.fn(async (runtime: "node" | "bun") => runtime);
      try {
        const selection = await resolveGatewaySetupRuntime({
          env: {},
          existingCommand: null,
          selectRuntime: flow === "advanced" ? select : undefined,
        });
        expect(selection.runtime).toBe(suggested);
        expect(selection.runtimeExplicit).toBe(flow === "advanced");
        expect(selection.runtimePath).toBe(suggested === "bun" ? process.execPath : undefined);
        expect(selection.runtimePinUpdate.pin).toBeUndefined();
        if (flow === "advanced") {
          expect(select).toHaveBeenCalledExactlyOnceWith(suggested);
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
