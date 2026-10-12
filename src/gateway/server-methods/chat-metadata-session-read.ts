import { isDeepStrictEqual } from "node:util";
import { PreparedModelRuntimePublicationSupersededError } from "../../agents/prepared-model-runtime.errors.js";
import { retainPreparedSessionEntryPredicate } from "../../config/sessions/session-accessor.sqlite-entry-cache-publication-state.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { registerOpenClawAgentDatabaseAsyncResource } from "../../state/openclaw-agent-db-resources.js";
import { hasSessionReadAccessChanged } from "../session-sharing-policy.js";
import { resolveSessionStoreIdentity } from "../session-store-key.js";
import { retainGatewaySessionEntryReadOnly } from "../session-utils-read-lifetime.js";
import { withGatewaySessionEntry } from "../session-utils-store.js";
import { chatMetadataSessionFields } from "./chat-metadata-contract.js";

function sameMetadataEntry(previous: SessionEntry | undefined, current: SessionEntry | undefined) {
  return previous && current
    ? !hasSessionReadAccessChanged(previous, current) &&
        chatMetadataSessionFields.every((field) =>
          isDeepStrictEqual(previous[field], current[field]),
        )
    : previous === current;
}

export async function prepareChatMetadataSessionRead(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId: string;
  assertRequestCurrent: () => void;
}) {
  const changed = () =>
    new PreparedModelRuntimePublicationSupersededError(
      "Session changed while preparing its metadata. Retry the request.",
    );
  let active = true;
  let retained: ReturnType<typeof retainPreparedSessionEntryPredicate> | undefined;
  const releases: Array<() => void> = [];
  const preparations = new Set<Promise<unknown>>();
  const release = () => {
    active = false;
    for (const stop of releases.splice(0).toReversed()) {
      stop();
    }
  };
  const assertRefreshable = () => {
    params.assertRequestCurrent();
    if (!active || retained?.canRefresh() === false) {
      throw changed();
    }
  };
  const isCurrent = () => active && retained?.isCurrent() !== false;
  const assertCurrent = () => {
    assertRefreshable();
    if (!isCurrent()) {
      throw changed();
    }
  };
  const options = { agentId: params.agentId, projection: [] };
  try {
    if (isIncognitoSessionKey(resolveSessionStoreIdentity(params).canonicalKey)) {
      const selected = retainGatewaySessionEntryReadOnly(
        params.sessionKey,
        params.agentId,
        sameMetadataEntry,
        params.cfg,
      );
      releases.push(selected.release);
      const assertNativeCurrent = () => {
        assertRefreshable();
        if (!selected.isCurrentAtResponse()) {
          throw changed();
        }
      };
      assertNativeCurrent();
      return {
        selected,
        isCurrent: selected.isCurrent,
        assertCurrent: assertNativeCurrent,
        beforeRequest: assertNativeCurrent,
        release,
        async withCurrent<T>(consume: () => T): Promise<Awaited<T>> {
          assertNativeCurrent();
          return await consume();
        },
      };
    }
    const selected = await withGatewaySessionEntry(
      params.sessionKey,
      options,
      (session) => {
        assertCurrent();
        const sources = new Map(
          [
            { agentId: session.readSource?.agentId ?? session.agentId, path: session.storePath },
            ...(session.readSource ? [session.readSource] : []),
            ...(session.capturedReadSources ?? []),
          ].map((source) => [source.path, source]),
        );
        for (const source of sources.values()) {
          releases.push(
            registerOpenClawAgentDatabaseAsyncResource({
              ...source,
              revoke: release,
              close: async () => {
                release();
                await Promise.allSettled(preparations);
              },
            }),
          );
        }
        if (session.capturedReadSource) {
          if (typeof session.capturedReadSource.databaseIdentity !== "string") {
            throw changed();
          }
          retained = retainPreparedSessionEntryPredicate({
            databaseIdentity: `file:${session.capturedReadSource.databaseIdentity}`,
            sessionKey: session.legacyKey ?? session.canonicalKey,
            entry: session.entry,
            matches: sameMetadataEntry,
          });
          releases.push(retained.release);
        }
        return session;
      },
      params.cfg,
      assertCurrent,
    );
    assertCurrent();
    const matchesSelected = (current: typeof selected) =>
      current.agentId === selected.agentId &&
      current.canonicalKey === selected.canonicalKey &&
      current.legacyKey === selected.legacyKey &&
      current.storePath === selected.storePath &&
      isDeepStrictEqual(current.readSource, selected.readSource) &&
      isDeepStrictEqual(current.capturedReadSource, selected.capturedReadSource) &&
      isDeepStrictEqual(current.capturedReadSources, selected.capturedReadSources) &&
      sameMetadataEntry(selected.entry, current.entry);
    let requestRead: ReturnType<typeof retainGatewaySessionEntryReadOnly> | undefined;
    return {
      selected,
      isCurrent,
      assertCurrent,
      beforeRequest: () => {
        assertCurrent();
        // GuardedFetchOptions.beforeRequest is synchronous after transport preparation,
        // immediately before credential send. Retain the old canonical reread here;
        // awaiting a worker would reopen the foreign-commit revocation window.
        if (!requestRead) {
          requestRead = retainGatewaySessionEntryReadOnly(
            params.sessionKey,
            params.agentId,
            sameMetadataEntry,
            params.cfg,
          );
          releases.push(requestRead.release);
        }
        if (!matchesSelected(requestRead) || !requestRead.isCurrentAtResponse()) {
          throw changed();
        }
      },
      release,
      async withCurrent<T>(consume: () => T): Promise<Awaited<T>> {
        assertRefreshable();
        const revision = retained?.captureRevision();
        let preparation: Promise<Awaited<T>> | undefined;
        let failure: { error: unknown } | undefined;
        // Resolve again to preserve precedence if another canonical/legacy candidate appeared.
        const reading = withGatewaySessionEntry(
          params.sessionKey,
          options,
          (current) => {
            assertRefreshable();
            if (
              !matchesSelected(current) ||
              (retained && !retained.acknowledge(current.entry, revision!))
            ) {
              throw changed();
            }
            assertCurrent();
            // Start synchronously; capture thrown failures before cleanup can replace them.
            preparation = (async (): Promise<Awaited<T>> => await consume())();
            const pending = preparation;
            preparations.add(pending);
            const settled = () => preparations.delete(pending);
            void pending.then(settled, (error: unknown) => {
              failure ??= { error };
              settled();
            });
            return { value: pending };
          },
          params.cfg,
          assertRefreshable,
        );
        try {
          const prepared = await reading;
          return await prepared.value;
        } catch (error) {
          failure ??= { error };
          release();
          await Promise.allSettled(preparation ? [preparation] : []);
          throw failure.error;
        }
      },
    };
  } catch (error) {
    release();
    throw error;
  }
}
