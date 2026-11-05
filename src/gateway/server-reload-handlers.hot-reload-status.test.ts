import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  getRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  publishSystemEventStoreResolver,
  registerSystemEventStoreOwner,
} from "../infra/system-event-ownership.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { buildGatewayReloadPlan } from "./config-reload-plan.js";
import { publishOperatorRoleConfigChange } from "./operator-role-policy.js";
import { captureGatewayOperatorRunAuthority } from "./operator-run-authority.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";
import { createManagedReloadTestParams } from "./server-reload-handlers.config.test-support.js";
import { startManagedGatewayConfigReloader } from "./server-reload-managed.js";
import { createTestRuntimeSecretsActivator } from "./server-startup-config.test-support.js";

type WatcherOptions = Parameters<typeof import("./config-reload.js").startGatewayConfigReloader>[0];

const hoisted = vi.hoisted(() => ({
  hotReloadStatus: { current: "active" as "active" | "disabled" },
  invalidateConfigGetResponseCache: vi.fn(),
  onConfigCandidateCommitted: undefined as WatcherOptions["onConfigCandidateCommitted"],
  onRuntimeConfigCommitted: undefined as WatcherOptions["onRuntimeConfigCommitted"],
  stop: vi.fn(async () => {}),
}));

vi.mock("./config-get-response.js", () => ({
  invalidateConfigGetResponseCache: hoisted.invalidateConfigGetResponseCache,
}));

vi.mock("./config-reload.js", async () => {
  const actual = await vi.importActual<typeof import("./config-reload.js")>("./config-reload.js");
  return {
    ...actual,
    startGatewayConfigReloader: vi.fn((options: WatcherOptions) => {
      hoisted.onConfigCandidateCommitted = options.onConfigCandidateCommitted;
      hoisted.onRuntimeConfigCommitted = options.onRuntimeConfigCommitted;
      return {
        ready: Promise.resolve(),
        isReady: () => true,
        stop: hoisted.stop,
        hotReloadStatus: () => hoisted.hotReloadStatus.current,
        isReloading: () => false,
        applyPluginLifecycleChange: vi.fn(),
      };
    }),
  };
});

it("forwards live status and invalidates config.get on watcher commit", async () => {
  const initialConfig = { session: { store: "/tmp/sessions.json" } } as OpenClawConfig;
  const pluginRegistry = createEmptyPluginRegistry();
  const broadcast = vi.fn();
  const invalidateMentions = vi.fn();
  const gatewayContext = {
    mentionInbox: { invalidateAsync: invalidateMentions },
  } as unknown as GatewayRequestContext;
  const reloader = startManagedGatewayConfigReloader(
    createManagedReloadTestParams({
      scheduler: createTestGatewayScheduler(vi.isFakeTimers() ? "fake-timers" : undefined),
      getPluginRegistry: () => pluginRegistry,
      configRevisionProjector: {
        projectRawHash: (hash) => `opaque:${hash}`,
        projectResolvedHash: (hash) => `resolved:${hash}`,
        hashResponseSessionBearer: () => "unused-test-scope",
      },
      initialConfig,
      readSnapshot: vi.fn() as never,
      subscribeToWrites: vi.fn(() => () => {}) as never,
      broadcast,
      resolveGatewayContext: () => gatewayContext,
      activateRuntimeSecrets: createTestRuntimeSecretsActivator(),
      channelManager: {} as never,
    }),
  );
  await reloader.ready;
  const commit = (path: string, config = initialConfig) =>
    expectDefined(hoisted.onRuntimeConfigCommitted, "runtime config commit")(
      buildGatewayReloadPlan([path]),
      config,
    );

  expect(reloader.hotReloadStatus?.()).toBe("active");

  hoisted.hotReloadStatus.current = "disabled";
  expect(reloader.hotReloadStatus?.()).toBe("disabled");

  hoisted.onConfigCandidateCommitted?.({
    path: "/tmp/openclaw.json",
    persistedHash: "persisted-1",
    changedPaths: ["gateway.port"],
  });
  expect(hoisted.invalidateConfigGetResponseCache).toHaveBeenCalledOnce();
  expect(broadcast).toHaveBeenCalledWith(
    "config.changed",
    { path: "/tmp/openclaw.json", hash: "opaque:persisted-1", ts: expect.any(Number) },
    { dropIfSlow: true },
  );
  expect(invalidateMentions).not.toHaveBeenCalled();

  commit("gateway.roles");
  expect(invalidateMentions).toHaveBeenCalledOnce();

  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const profile = ensureProfileForEmail("committed-policy@example.test");
    gatewayContext.getRuntimeConfig = () => getRuntimeConfigSnapshot() ?? initialConfig;
    gatewayContext.getCommittedRuntimeConfig = expectDefined(
      reloader.getCommittedRuntimeConfig,
      "committed runtime config reader",
    );
    gatewayContext.resolveGatewayContext = () => gatewayContext;
    const capture = async () =>
      expectDefined(
        await captureGatewayOperatorRunAuthority({
          client: createSyntheticPluginRuntimeClient({
            scopes: ["operator.write"],
            operatorRoleActor: { kind: "operator", profileId: profile.id },
          }),
          context: gatewayContext,
        }),
        "operator source",
      );
    const original = await capture();
    let duringActivation: Awaited<ReturnType<typeof capture>> | undefined;
    const candidate: OpenClawConfig = {
      ...initialConfig,
      gateway: {
        roles: {
          default: "reader",
          definitions: {
            reader: { scopes: ["operator.read"], agents: "*", sessions: { others: "view" } },
          },
        },
      },
    };
    try {
      setRuntimeConfigSnapshot(candidate);
      expect(original.authority.signal?.aborted).toBe(false);
      expect(() => original.authority.assertCurrent()).not.toThrow();
      duringActivation = await capture();
      // An unrelated Gateway publication cannot turn this tentative policy into source loss.
      publishOperatorRoleConfigChange({});
      expect(duringActivation.authority.signal?.aborted).toBe(false);
      setRuntimeConfigSnapshot(initialConfig);
      expect(duringActivation.authority.assertCurrent).not.toThrow();
      expect(original.authority.signal?.aborted).toBe(false);

      setRuntimeConfigSnapshot(candidate);
      commit("gateway.roles", candidate);
      expect(gatewayContext.getCommittedRuntimeConfig()).toBe(candidate);
      expect(original.authority.signal?.aborted).toBe(true);
      expect(duringActivation.authority.signal?.aborted).toBe(true);
    } finally {
      original.release();
      duringActivation?.release();
      clearRuntimeConfigSnapshot();
    }
  });

  const retireStoreOwner = vi.fn();
  const storeOwnerKey = Symbol.for("openclaw.test.managedReloadStoreOwner");
  registerSystemEventStoreOwner(storeOwnerKey, retireStoreOwner);
  try {
    const presentation: OpenClawConfig = {
      ...initialConfig,
      ui: { prefs: { sidebarEntries: ["route:usage"] } },
    };
    const replacement: OpenClawConfig = {
      ...presentation,
      session: { store: "/tmp/replacement-sessions.json" },
    };
    for (const [path, config, retirements] of [
      ["ui.prefs.sidebarEntries", presentation, 0],
      ["logging.level", { ...presentation, logging: { level: "debug" } }, 0],
      ["session.store", replacement, 1],
      ["env.OPENCLAW_STATE_DIR", replacement, 2],
      ["ui.prefs.sidebarEntries", replacement, 2],
    ] as const) {
      commit(path, config);
      expect(retireStoreOwner).toHaveBeenCalledTimes(retirements);
    }
  } finally {
    registerSystemEventStoreOwner(storeOwnerKey, () => {});
    publishSystemEventStoreResolver(undefined);
  }

  await reloader.stop();
  expect(hoisted.stop).toHaveBeenCalledOnce();
});
