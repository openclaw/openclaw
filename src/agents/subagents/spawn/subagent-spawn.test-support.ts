import { vi, type MockInstance } from "vitest";
import * as spawnRuntime from "./subagent-spawn.runtime.js";

type SpawnRuntime = typeof import("./subagent-spawn.runtime.js");
type SpawnDeps = Omit<
  Pick<
    SpawnRuntime,
    | "callGateway"
    | "dispatchGatewayMethodInProcess"
    | "ensureContextEnginesInitialized"
    | "forkSessionEntryFromParent"
    | "getGlobalHookRunner"
    | "getRuntimeConfig"
    | "hasInProcessGatewayContext"
    | "prepareModelChoice"
    | "resolveContextEngine"
  >,
  "getGlobalHookRunner"
> & {
  getGlobalHookRunner: () => import("../../../plugins/hooks.js").SubagentLifecycleHookRunner | null;
};

type Testing = {
  setDepsForTest(overrides?: Partial<SpawnDeps>): void;
};

const runtime: SpawnDeps = spawnRuntime;
const overridesToRestore: Array<Pick<MockInstance, "mockRestore">> = [];

export const testing: Testing = {
  setDepsForTest(overrides) {
    for (const mock of overridesToRestore.splice(0).toReversed()) {
      mock.mockRestore();
    }
    if (!overrides) {
      return;
    }
    if (overrides.callGateway) {
      overridesToRestore.push(
        vi.spyOn(runtime, "callGateway").mockImplementation(overrides.callGateway),
      );
    }
    if (overrides.dispatchGatewayMethodInProcess) {
      overridesToRestore.push(
        vi
          .spyOn(runtime, "dispatchGatewayMethodInProcess")
          .mockImplementation(overrides.dispatchGatewayMethodInProcess),
      );
    }
    if (overrides.ensureContextEnginesInitialized) {
      overridesToRestore.push(
        vi
          .spyOn(runtime, "ensureContextEnginesInitialized")
          .mockImplementation(overrides.ensureContextEnginesInitialized),
      );
    }
    if (overrides.forkSessionEntryFromParent) {
      overridesToRestore.push(
        vi
          .spyOn(runtime, "forkSessionEntryFromParent")
          .mockImplementation(overrides.forkSessionEntryFromParent),
      );
    }
    if (overrides.getGlobalHookRunner) {
      overridesToRestore.push(
        vi.spyOn(runtime, "getGlobalHookRunner").mockImplementation(overrides.getGlobalHookRunner),
      );
    }
    if (overrides.getRuntimeConfig) {
      overridesToRestore.push(
        vi.spyOn(runtime, "getRuntimeConfig").mockImplementation(overrides.getRuntimeConfig),
      );
    }
    if (overrides.hasInProcessGatewayContext) {
      overridesToRestore.push(
        vi
          .spyOn(runtime, "hasInProcessGatewayContext")
          .mockImplementation(overrides.hasInProcessGatewayContext),
      );
    }
    if (overrides.prepareModelChoice) {
      overridesToRestore.push(
        vi.spyOn(runtime, "prepareModelChoice").mockImplementation(overrides.prepareModelChoice),
      );
    }
    if (overrides.resolveContextEngine) {
      overridesToRestore.push(
        vi
          .spyOn(runtime, "resolveContextEngine")
          .mockImplementation(overrides.resolveContextEngine),
      );
    }
  },
};
