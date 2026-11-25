import { expectDefined } from "@openclaw/normalization-core";
import { beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { bindThreadForSubagentSpawn } from "../agents/subagents/spawn/subagent-spawn-thread-binding.js";
import { testing as sessionBindingTesting } from "../infra/outbound/session-binding-service.js";
import {
  createPluginStateKeyedStoreV2ForTests,
  resetPluginStateStoreForTests,
} from "../plugin-sdk/plugin-state-test-runtime.js";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { pluginInstanceInvocation } from "./plugin-instance-invocation.js";
import { getPluginInstance } from "./plugin-instance-scope.js";
import { markPluginRegistryActive, markPluginRegistryRetired } from "./registry-lifecycle.js";
import { createPluginRegistry } from "./registry.js";
import type { PluginRuntime } from "./runtime/types.js";
import { createPluginRecord } from "./status.test-helpers.js";

type MatrixStoreOptions = Parameters<PluginRuntime["state"]["openKeyedStoreV2"]>[0];
type StoredMatrixBinding = { targetSessionKey: string };
type MatrixThreadBindingManager = {
  stop: () => Promise<void>;
  getByConversation: (ref: {
    conversationId: string;
    parentConversationId?: string;
  }) => StoredMatrixBinding | undefined;
};
type MatrixThreadBindingManagerParams = {
  cfg: Record<string, never>;
  accountId: string;
  auth: typeof matrixAuth;
  client: unknown;
  stateDir: string;
  idleTimeoutMs: number;
  maxAgeMs: number;
  enableSweeper: boolean;
};

const matrixAuth = {
  accountId: "ops",
  homeserver: "https://matrix.example.org",
  userId: "@bot:example.org",
  accessToken: "placeholder-token",
};
// The observer store uses this no-op authority; Matrix's runtime store runs production checks.
const storeAuthority = {
  assertCurrent() {},
};

let setMatrixRuntime: (runtime: PluginRuntime) => void;
let createMatrixThreadBindingManager: (
  params: MatrixThreadBindingManagerParams,
) => Promise<MatrixThreadBindingManager>;

beforeAll(async () => {
  ({ createMatrixThreadBindingManager, setMatrixRuntime } = await loadBundledPluginFacade<{
    createMatrixThreadBindingManager: typeof createMatrixThreadBindingManager;
    setMatrixRuntime: typeof setMatrixRuntime;
  }>({ pluginId: "matrix", artifactBasename: "session-binding-contract-api.js" }));
});

async function createMatrixSpawnFixture() {
  const state = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-matrix-binding-owner-",
  });
  onTestFinished(() => state.cleanup());
  resetPluginStateStoreForTests();
  onTestFinished(() => resetPluginStateStoreForTests());
  sessionBindingTesting.resetSessionBindingAdaptersForTests();
  onTestFinished(() => sessionBindingTesting.resetSessionBindingAdaptersForTests());

  const { createPluginRuntime } = await import("./runtime/index.js");
  const builder = createPluginRegistry({
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    runtime: createPluginRuntime(),
    activateGlobalSideEffects: false,
  });
  const record = createPluginRecord({ id: "matrix", origin: "bundled" });
  const api = builder.createApi(record, { config: {}, registrationMode: "full" });
  const matrix = expectDefined(getPluginInstance(record), "registered Matrix plugin instance");
  onTestFinished(async () => expect((await matrix.dispose()).errors).toEqual([]));
  builder.registry.plugins.push(record);
  markPluginRegistryActive(builder.registry);
  onTestFinished(() => markPluginRegistryRetired(builder.registry));

  const opened: { options?: MatrixStoreOptions; failNextWrite?: boolean } = {};
  const observedRuntime = new Proxy(api.runtime, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property !== "state") {
        return value;
      }
      const runtimeState = value as PluginRuntime["state"];
      return {
        ...runtimeState,
        // SAFETY: This fixture serves only Matrix's thread-binding namespace and record type.
        openKeyedStoreV2: ((options: MatrixStoreOptions, authority) => {
          opened.options = options;
          const store = runtimeState.openKeyedStoreV2<StoredMatrixBinding>(options, authority);
          if (opened.failNextWrite) {
            opened.failNextWrite = false;
            vi.spyOn(store, "register").mockRejectedValueOnce(new Error("Matrix write failed"));
          }
          return store;
        }) as PluginRuntime["state"]["openKeyedStoreV2"],
      };
    },
  });

  const sent: string[] = [];
  const managerParams: MatrixThreadBindingManagerParams = {
    cfg: {},
    accountId: matrixAuth.accountId,
    auth: matrixAuth,
    client: {
      prepareRoomForMessageSend: async () => "m.room.message",
      getUserId: async () => matrixAuth.userId,
      sendMessage: async (roomId: string) => {
        sent.push(roomId);
        return `$root-${sent.length}`;
      },
    },
    stateDir: state.stateDir,
    idleTimeoutMs: 24 * 60 * 60 * 1000,
    maxAgeMs: 0,
    enableSweeper: false,
  };
  // The manager starts inside Matrix's instance, as channel startup does.
  const manager = await matrix.run(async () => {
    setMatrixRuntime(observedRuntime);
    return await createMatrixThreadBindingManager(managerParams);
  });
  // stop() rethrows a failed queued write; each case asserts that failure through the spawn result.
  onTestFinished(() => manager.stop().catch(() => {}));
  const observer = createPluginStateKeyedStoreV2ForTests<StoredMatrixBinding>(
    "matrix",
    expectDefined(opened.options, "Matrix thread-binding store options"),
    storeAuthority,
  );

  return {
    matrix,
    manager,
    managerParams,
    registry: builder.registry,
    sent,
    failNextWrite: () => {
      opened.failNextWrite = true;
    },
    readStoredTargets: async () =>
      (await observer.entries()).map((entry) => entry.value.targetSessionKey),
    // A Gateway chat.send turn into a Matrix room session runs sessions_spawn from core,
    // so no plugin instance is current when the binding is written.
    spawnOutsidePluginInstance: (childSessionKey: string) => {
      expect(pluginInstanceInvocation.getStore()).toBeUndefined();
      return bindThreadForSubagentSpawn({
        cfg: {},
        childSessionKey,
        agentId: "main",
        mode: "session",
        requester: { channel: "matrix", accountId: matrixAuth.accountId, to: "room:!room:a" },
      });
    },
  };
}

describe("Matrix thread bindings written outside any plugin instance", () => {
  it("persists a thread-bound spawn made outside any plugin instance across a restart", async () => {
    const fixture = await createMatrixSpawnFixture();
    const result = await fixture.spawnOutsidePluginInstance("agent:main:subagent:child");

    expect(result).toEqual({
      status: "ok",
      deliveryOrigin: expect.objectContaining({
        channel: "matrix",
        accountId: matrixAuth.accountId,
      }),
    });
    expect(fixture.sent).toEqual(["!room:a"]);
    expect(await fixture.readStoredTargets()).toEqual(["agent:main:subagent:child"]);
    await fixture.manager.stop();
    const restarted = await fixture.matrix.run(() =>
      createMatrixThreadBindingManager(fixture.managerParams),
    );
    onTestFinished(() => restarted.stop());
    expect(
      restarted.getByConversation({ conversationId: "$root-1", parentConversationId: "!room:a" }),
    ).toMatchObject({ targetSessionKey: "agent:main:subagent:child" });
  });

  it("keeps the manager usable after a write outside any plugin instance fails", async () => {
    const fixture = await createMatrixSpawnFixture();
    fixture.failNextWrite();

    await expect(fixture.spawnOutsidePluginInstance("agent:main:subagent:first")).resolves.toEqual({
      status: "error",
      error: "Thread bind failed: Matrix write failed",
    });
    await expect(
      fixture.spawnOutsidePluginInstance("agent:main:subagent:second"),
    ).resolves.toMatchObject({ status: "ok" });
    expect(await fixture.readStoredTargets()).toEqual(["agent:main:subagent:second"]);
  });

  it("refuses a spawn write outside any plugin instance after the Matrix registry is retired", async () => {
    const fixture = await createMatrixSpawnFixture();
    markPluginRegistryRetired(fixture.registry);

    await expect(
      fixture.spawnOutsidePluginInstance("agent:main:subagent:child"),
    ).resolves.toMatchObject({ status: "error" });
    expect(fixture.sent).toEqual(["!room:a"]);
    expect(await fixture.readStoredTargets()).toEqual([]);
  });
});
