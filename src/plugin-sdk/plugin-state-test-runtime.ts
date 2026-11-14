/**
 * Test SDK subpath for plugin state stores, ingress queues, and state DB helpers.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { resolveOpenClawPackageRootSync } from "../infra/openclaw-root.js";
import {
  createPluginStateKeyedStore,
  createPluginStateKeyedStoreV2,
  createPluginStateSyncKeyedStore,
} from "../plugin-state/plugin-state-store.js";
import { assertPluginStateKey } from "../plugin-state/plugin-state-store.kernel.js";
import type { PluginStateOperationModule } from "../plugin-state/plugin-state-store.native-binding.js";
import type { PluginStateKeyedStore } from "../plugin-state/plugin-state-store.types.js";

export { withDatabaseEngineSelection } from "../infra/database-engine/context.js";
export { resolveDatabaseFamilyEngines } from "../infra/database-engine/registry.js";

let fixturePackageRoot: string | undefined;
const fixtureOperationModules = new Map<string, PluginStateOperationModule>();

function guardFixtureRegistrations<T>(
  store: Pick<PluginStateKeyedStore<T>, "register" | "registerIfAbsent">,
): void {
  const { register, registerIfAbsent } = store;
  // Keep the host-owned object: native read guards and operations bind by identity.
  store.register = async (...args) => {
    assertPluginStateKey(true, args[0], "register");
    return register(...args);
  };
  store.registerIfAbsent = async (...args) => {
    assertPluginStateKey(true, args[0], "register");
    return registerIfAbsent(...args);
  };
}

function resolveFixtureOperationModule(
  pluginId: string,
  moduleName: string,
): PluginStateOperationModule {
  if (
    !/^[a-z0-9][a-z0-9-]*$/u.test(pluginId) ||
    !/^[a-z0-9][a-z0-9.-]*-operation-api\.[cm]?[jt]s$/u.test(moduleName)
  ) {
    throw new Error("Fixture operation must name a top-level bundled plugin operation entry");
  }
  const key = JSON.stringify([pluginId, moduleName]);
  const cached = fixtureOperationModules.get(key);
  if (cached) {
    return cached;
  }
  fixturePackageRoot ??=
    resolveOpenClawPackageRootSync({ moduleUrl: import.meta.url }) ?? undefined;
  if (!fixturePackageRoot) {
    throw new Error("Unable to locate the fixture's OpenClaw package");
  }
  const roots = [
    path.join(fixturePackageRoot, "extensions", pluginId),
    path.join(fixturePackageRoot, "dist", "extensions", pluginId),
    path.join(fixturePackageRoot, "dist-runtime", "extensions", pluginId),
  ];
  const names = [...new Set([moduleName.replace(/\.([cm]?)js$/u, ".$1ts"), moduleName])];
  for (const boundaryRoot of roots) {
    for (const name of names) {
      const modulePath = path.join(boundaryRoot, name);
      if (existsSync(modulePath)) {
        const descriptor: PluginStateOperationModule = {
          modulePath,
          boundaryRoot,
          origin: "bundled",
          pluginId,
        };
        fixtureOperationModules.set(key, descriptor);
        return descriptor;
      }
    }
  }
  throw new Error(`Fixture operation ${pluginId}/${moduleName} does not exist in its package`);
}

/** Bundled fixtures use package-local operation entries without constructing a live registry. */
export function createPluginStateKeyedStoreForTests<T>(
  ...args: Parameters<typeof createPluginStateKeyedStore<T>>
) {
  const [pluginId, options, assertCurrent, moduleSource] = args;
  const store = createPluginStateKeyedStore<T>(
    pluginId,
    options,
    assertCurrent,
    moduleSource ?? {
      resolve(moduleName) {
        return resolveFixtureOperationModule(pluginId, moduleName);
      },
    },
  );
  guardFixtureRegistrations(store);
  const { withCurrent } = store;
  store.withCurrent = (authority) => {
    const current = withCurrent(authority);
    guardFixtureRegistrations(current);
    return current;
  };
  return store;
}

/** Bundled V2 fixtures resolve operations through the same package boundary as the host. */
export function createPluginStateKeyedStoreV2ForTests<T>(
  ...args: Parameters<typeof createPluginStateKeyedStoreV2<T>>
) {
  const [pluginId, options, assertCurrent, moduleSource] = args;
  const store = createPluginStateKeyedStoreV2<T>(
    pluginId,
    options,
    assertCurrent,
    moduleSource ?? {
      resolve(moduleName) {
        return resolveFixtureOperationModule(pluginId, moduleName);
      },
    },
  );
  guardFixtureRegistrations(store);
  return store;
}

/** SQLite fixtures reject new NUL keys while still reading legacy rows for adoption. */
export function createPluginStateSyncKeyedStoreForTests<T>(
  ...args: Parameters<typeof createPluginStateSyncKeyedStore<T>>
) {
  const store = createPluginStateSyncKeyedStore<T>(...args);
  const { register, registerIfAbsent } = store;
  store.register = (...registration) => {
    assertPluginStateKey(true, registration[0], "register");
    return register(...registration);
  };
  store.registerIfAbsent = (...registration) => {
    assertPluginStateKey(true, registration[0], "register");
    return registerIfAbsent(...registration);
  };
  return store;
}

export {
  getPluginStateCapacity as getPluginStateCapacityForTests,
  importPluginStateEntriesForDoctor as importPluginStateEntriesForDoctorForTests,
  resetPluginStateStoreForTests,
} from "../plugin-state/plugin-state-store.js";
export { setMaxMemoryHostEventsForTests } from "../memory-host-sdk/event-store.js";
export { createPluginBlobKernelStore } from "../plugin-state/plugin-blob-store.test-helpers.js";
export {
  createPluginBlobStoreForTests,
  resetPluginBlobStoreForTests,
} from "../plugin-state/plugin-blob-store.js";
export {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
  listChannelIngressQueueAccountIdsForTests,
} from "./channel-ingress-test-runtime.js";
export { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
export type { DB as OpenClawStateKyselyDatabaseForTests } from "../state/openclaw-state-db.generated.js";
export { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
// Test-only ingress reliability helpers: core predicates polling/webhook tests
// assert directly; excluded from the public SDK surface (private-local subpath).
export {
  INGRESS_CLAIM_LEASE_MS,
  isIngressClaimOwnedByOtherLiveProcess,
} from "../channels/message/ingress-claim-owner.js";
export {
  resolveIngressRetryDelayMs,
  shouldDeadLetterRetryableIngressEvent,
} from "../channels/message/ingress-retry-policy.js";
// Test-only pairing-store seeding so channel tests exercise the real
// store-backed authorization path instead of injecting fake readers.
export { addChannelAllowFromStoreEntry } from "../pairing/pairing-store.js";
