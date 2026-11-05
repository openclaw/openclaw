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

function install<K extends keyof SpawnDeps>(key: K) {
  const createSpy = () => vi.spyOn(runtime, key);
  return (implementation?: Parameters<ReturnType<typeof createSpy>["mockImplementation"]>[0]) => {
    if (implementation) {
      overridesToRestore.push(createSpy().mockImplementation(implementation));
    }
  };
}

export const testing: Testing = {
  setDepsForTest(overrides) {
    for (const mock of overridesToRestore.splice(0).toReversed()) {
      mock.mockRestore();
    }
    if (!overrides) {
      return;
    }
    install("callGateway")(overrides.callGateway);
    install("dispatchGatewayMethodInProcess")(overrides.dispatchGatewayMethodInProcess);
    install("ensureContextEnginesInitialized")(overrides.ensureContextEnginesInitialized);
    install("forkSessionEntryFromParent")(overrides.forkSessionEntryFromParent);
    install("getGlobalHookRunner")(overrides.getGlobalHookRunner);
    install("getRuntimeConfig")(overrides.getRuntimeConfig);
    install("hasInProcessGatewayContext")(overrides.hasInProcessGatewayContext);
    install("prepareModelChoice")(overrides.prepareModelChoice);
    install("resolveContextEngine")(overrides.resolveContextEngine);
  },
};
