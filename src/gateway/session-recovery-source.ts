import path from "node:path";
import { withSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import {
  prepareSessionMutationFacts,
  SessionMutationFactsUnavailableError,
} from "./session-sharing-preparation.js";
import type { GatewaySessionStoreTarget } from "./session-utils-store.types.js";

export class SessionRecoverySourceChangedError extends Error {
  constructor(options?: ErrorOptions) {
    super("Session changed before recovery; refresh and retry.", options);
    this.name = "SessionRecoverySourceChangedError";
  }
}

/** Keep full recovery metadata tied to the existing sharing/source publication lifetime. */
export async function prepareRecoverySource(params: {
  cfg: OpenClawConfig;
  target: GatewaySessionStoreTarget;
  commitGuard?: () => void;
  storageReady?: Promise<void>;
}) {
  const { target } = params;
  const facts = await prepareSessionMutationFacts({
    cfg: params.cfg,
    sessionKey: target.canonicalKey,
    agentId: target.agentId,
    allowMissing: true,
    storageReady: params.storageReady,
  });
  let generation = 0;
  let selectedGeneration = -1;
  let selected: InternalSessionEntry | undefined;
  const sourcePaths = new Set([path.resolve(target.storePath)]);
  const readFacts = () => {
    try {
      const current = facts.readCurrent(params.cfg);
      if (
        facts.storageTarget.agentId !== target.agentId ||
        facts.storageTarget.canonicalKey !== target.canonicalKey ||
        path.resolve(facts.storageTarget.storePath) !== path.resolve(target.storePath)
      ) {
        throw new SessionRecoverySourceChangedError();
      }
      return current;
    } catch (error) {
      if (error instanceof SessionMutationFactsUnavailableError) {
        throw new SessionRecoverySourceChangedError({ cause: error });
      }
      throw error;
    }
  };
  try {
    const source = readFacts();
    if (source.sourcePath) {
      sourcePaths.add(path.resolve(source.sourcePath));
    }
  } catch (error) {
    facts.release();
    throw error;
  }
  const unsubscribe = sessionChanges.subscribeFacts((change) => {
    if (
      !("all" in change) &&
      change.storePath &&
      sourcePaths.has(path.resolve(change.storePath)) &&
      target.storeKeys.includes(change.sessionKey)
    ) {
      generation += 1;
    }
  });
  const assertCurrent = () => {
    params.commitGuard?.();
    readFacts();
    if (selectedGeneration !== generation) {
      throw new SessionRecoverySourceChangedError();
    }
  };
  return {
    current() {
      assertCurrent();
      return selected;
    },
    async refresh() {
      params.commitGuard?.();
      const before = generation;
      const current = readFacts();
      if (!current.target) {
        selected = undefined;
        selectedGeneration = before;
        assertCurrent();
        return undefined;
      }
      const read = await withSessionEntryReadOnlyInWorker(
        {
          agentId: target.agentId,
          sessionKey: current.target.storeKey,
          storePath: current.sourcePath ?? target.storePath,
        },
        () => params.commitGuard?.(),
        async (result, owner) => {
          owner.assertCurrent();
          if (!result.ok) {
            throw result.error;
          }
          return result.value;
        },
      );
      selected = read;
      selectedGeneration = before;
      assertCurrent();
      return selected;
    },
    [Symbol.dispose]() {
      unsubscribe();
      facts.release();
    },
  };
}
