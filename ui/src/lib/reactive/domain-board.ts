import type { BoardCommandEvent } from "@openclaw/gateway-protocol";
import type { BoardEventStream, BoardSnapshotSignal } from "../board/provider-signals.ts";
import {
  acquireBoardProviderForSession,
  boardProviderForSession,
  type BoardProvider,
  type BoardProviderLease,
} from "../board/provider.ts";
import { projectEvents, projectSource } from "./projection.ts";

/** ValueSignal deliberately publishes repeated values, including the same mutable object. */
export function projectBoardValue<T>(source: BoardSnapshotSignal<T>) {
  return projectSource(source, {
    read: (signal) => signal.value,
    subscribe: (signal, notify) => signal.subscribe(notify),
    equality: "revision",
  });
}

export function projectBoardEvents<T>(source: BoardEventStream<T>) {
  return projectEvents<BoardEventStream<T>, T>(source, {
    subscribe: (events, listener) => events.subscribe(listener),
  });
}

function readBoardProvider(provider: BoardProvider) {
  return {
    snapshot: provider.snapshot$.value,
    loadError: provider.loadError$.value,
    sessionKey: provider.sessionKey,
    appViewGeneration: provider.appViewGeneration,
    hasLoadedSnapshot: provider.hasLoadedSnapshot,
    canMutate: provider.canMutate,
    canGrant: provider.canGrant,
    canPinWidgets: provider.canPinWidgets,
    canPinMcpApps: provider.canPinMcpApps,
  };
}

function subscribeBoardProvider(provider: BoardProvider, notify: () => void) {
  const stopSnapshot = provider.snapshot$.subscribe(notify);
  const stopError = provider.loadError$.subscribe(notify);
  return () => {
    stopSnapshot();
    stopError();
  };
}

/** For an existing lifecycle-owned provider, including GatewayBoardProvider. */
export function projectBoardProvider(source: BoardProvider) {
  return projectSource(source, {
    read: readBoardProvider,
    subscribe: subscribeBoardProvider,
    equality: "revision",
  });
}

export type BoardSessionProjectionSource = {
  session: Parameters<typeof acquireBoardProviderForSession>[0];
  client: Parameters<typeof acquireBoardProviderForSession>[1];
  connected: boolean;
  capabilities: Pick<BoardProvider, "canPinWidgets" | "canPinMcpApps" | "canMutate" | "canGrant">;
};

/** State readers and event listeners share one lease, released when both become idle. */
export function projectBoardSession(initialSource: BoardSessionProjectionSource) {
  const leases = new Map<
    BoardSessionProjectionSource,
    { lease: BoardProviderLease; users: number }
  >();
  const retain = (source: BoardSessionProjectionSource) => {
    let entry = leases.get(source);
    if (!entry) {
      const { session, client, connected, capabilities } = source;
      entry = {
        lease: acquireBoardProviderForSession(
          session,
          client,
          connected,
          capabilities.canPinWidgets,
          capabilities.canPinMcpApps,
          capabilities.canMutate,
          capabilities.canGrant,
        ),
        users: 0,
      };
      leases.set(source, entry);
    }
    entry.users += 1;
    return entry.lease.provider;
  };
  const release = (source: BoardSessionProjectionSource) => {
    const entry = leases.get(source);
    if (entry && --entry.users === 0) {
      leases.delete(source);
      entry.lease.release();
    }
  };
  const state = projectSource(initialSource, {
    read: (source) => {
      const owned = leases.get(source)?.lease.provider;
      const snapshot = readBoardProvider(
        owned ?? boardProviderForSession(source.session, source.connected),
      );
      // A cached transport is readable before acquisition, but another consumer's
      // lease can never confer mutation authority on this projection.
      return owned
        ? snapshot
        : {
            ...snapshot,
            canMutate: false,
            canGrant: false,
            canPinWidgets: false,
            canPinMcpApps: false,
          };
    },
    subscribe: (source, notify) => {
      const stop = subscribeBoardProvider(retain(source), notify);
      return () => {
        stop();
        release(source);
      };
    },
    equality: "revision",
  });
  const events = projectEvents<BoardSessionProjectionSource, BoardCommandEvent>(initialSource, {
    subscribe: (source, listener) => {
      const stop = retain(source).events.subscribe(listener);
      return () => {
        stop();
        release(source);
      };
    },
  });
  return {
    state: {
      equality: state.equality,
      read: state.read,
      revision: state.revision,
      subscribe: state.subscribe,
    },
    events: { subscribe: events.subscribe },
    replaceSource(source: BoardSessionProjectionSource) {
      state.replaceSource(source);
      events.replaceSource(source);
    },
    dispose() {
      state.dispose();
      events.dispose();
    },
  };
}
