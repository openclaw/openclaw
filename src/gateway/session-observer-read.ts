import { isDeepStrictEqual } from "node:util";
import { captureSessionStoreEnvironment } from "../config/sessions/session-store-target-inventory.js";
import type { SessionObserverDeps, SessionObserverRead } from "./session-observer-model.js";
import { defaultPersistDigest } from "./session-observer-model.js";
import { captureSessionMutationRouting } from "./session-sharing-preparation.js";
import { withGatewaySessionStoreTarget } from "./session-utils-store-lookup.js";
import {
  withQualifiedGatewaySessionStoreTarget,
  type GatewaySessionStoreSelection,
} from "./session-utils-store-retained.js";
import { findCanonicalStoreMatch } from "./session-utils-store-selection.js";
import type { GatewaySessionStoreTargetWithStore } from "./session-utils-store.types.js";

/** One observation retains its physical sources; every read still fetches current rows. */
export function captureSessionObserverRead(
  deps: Pick<SessionObserverDeps, "getConfig" | "readSession" | "persistDigest">,
  sessionKey: string,
  agentId: string,
): SessionObserverRead {
  const cfg = deps.getConfig();
  const routing = captureSessionMutationRouting(cfg, undefined, [{ sessionKey, agentId }]);
  const { config, serialized: env } = captureSessionStoreEnvironment(cfg);
  let target: GatewaySessionStoreTargetWithStore | undefined;
  let selection: GatewaySessionStoreSelection | undefined;
  const assertCurrent = () => {
    routing(deps.getConfig());
  };
  const reader: SessionObserverRead = {
    assertCurrent,
    async withRead(consume) {
      assertCurrent();
      if (deps.readSession) {
        const entry = deps.readSession(sessionKey, agentId);
        assertCurrent();
        return consume(entry);
      }
      const consumeRead = (
        loaded: GatewaySessionStoreTargetWithStore,
        assertReadCurrent: () => void,
        selected?: GatewaySessionStoreSelection,
      ) => {
        assertCurrent();
        assertReadCurrent();
        if (
          target &&
          (!isDeepStrictEqual(target.capturedReadSources, loaded.capturedReadSources) ||
            !isDeepStrictEqual(target.capturedReadSource, loaded.capturedReadSource) ||
            target.canonicalKey !== loaded.canonicalKey)
        ) {
          throw new Error("Session observer source changed during observation");
        }
        // Keep only locators between reads; acceptance retains the live reader and writer FIFO.
        target = { ...loaded, store: {} };
        selection ??= selected;
        return consume(findCanonicalStoreMatch(loaded.store, loaded.storeKeys)?.entry);
      };
      if (selection) {
        return withQualifiedGatewaySessionStoreTarget({
          target: selection.target,
          logicalStorePath: selection.logicalStorePath,
          env: selection.env,
          preparedSource: selection.source,
          includeMembership: false,
          consume: (loaded, _members, assertReadCurrent) => consumeRead(loaded, assertReadCurrent),
        });
      }
      return withGatewaySessionStoreTarget(
        {
          cfg: config,
          env,
          key: sessionKey,
          agentId,
          projection: "full",
          ordered: true,
        },
        (loaded, _members, assertReadCurrent, _related, selected) =>
          consumeRead(loaded, assertReadCurrent, selected),
      );
    },
    async persist(params) {
      assertCurrent();
      if (deps.persistDigest) {
        return deps.persistDigest(params);
      }
      if (!target) {
        // Legacy event admission is synchronous; its asynchronous write still prepares the source.
        await reader.withRead(() => undefined);
        assertCurrent();
      }
      if (!target) {
        throw new Error("Session observer persistence requires an admitted source");
      }
      return defaultPersistDigest({
        ...params,
        storePath: target.storePath,
        target: {
          agentId: target.agentId,
          storePath: target.storePath,
          readSource: target.capturedReadSource,
          target: { canonicalKey: target.canonicalKey, storeKeys: target.storeKeys },
          env,
        },
        stillCurrent: () => {
          assertCurrent();
          return params.stillCurrent?.() !== false;
        },
      });
    },
  };
  return reader;
}
