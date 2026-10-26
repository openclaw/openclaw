import type { GatewaySessionRow } from "../api/types.ts";
import type { ChatPageHost } from "../pages/chat/chat-state-host.ts";
import type { SessionSnapshotStore } from "../pages/chat/session-snapshot-store.ts";

type TitleOwner = {
  element: HTMLElement;
  state?: ChatPageHost;
  sessionSnapshotStore?: SessionSnapshotStore;
  resolveHeaderSessionTitle(row: GatewaySessionRow | undefined): string;
  transcriptSessionProps(row: GatewaySessionRow | undefined): {
    transcriptMetadata?: GatewaySessionRow;
  };
  hydrateStoredChatSnapshot(state: ChatPageHost, key: string): void;
  applySessionsState(publication: ChatPageHost["sessions"]["state"]): void;
};

type ColdLoadTitleTrace = {
  mark(phase: string): void;
  holdCacheRead(): void;
  releaseCacheRead(): void;
  cacheReadPending: boolean;
  read(): {
    attribution: string;
    events: Array<Record<string, unknown>>;
    firstLostTitleWrite?: Record<string, unknown>;
    dropped: number;
  };
};

declare global {
  interface Window {
    coldLoadTitleTrace?: ColdLoadTitleTrace;
  }
}

/** Serialized before app modules; observes the existing native owner registration. */
export function installColdLoadTitleTrace(input: { sessionKey: string; expectedTitle: string }) {
  const events: Array<Record<string, unknown>> = [];
  const restores: Array<() => void> = [];
  let sequence = 0;
  let dropped = 0;
  let phase = "boot";
  let lastResolution: Record<string, unknown> | undefined;
  let firstLostTitleWrite: Record<string, unknown> | undefined;
  let expectedTitleSeen = false;
  let cacheReadGate: Promise<void> | undefined;
  let releaseCacheRead: (() => void) | undefined;
  let cacheReadPending = false;
  const record = (kind: string, value: Record<string, unknown>): Record<string, unknown> => {
    const event = { sequence: ++sequence, atMs: performance.now(), phase, kind, ...value };
    if (events.length === 96) {
      events.shift();
      dropped++;
    }
    events.push(event);
    return event;
  };
  const title = (value: unknown) =>
    value === input.expectedTitle
      ? "expected-title"
      : value === "New session"
        ? "New session"
        : typeof value === "string" && value.trim()
          ? "other-title"
          : "absent";
  const row = (value: GatewaySessionRow | null | undefined) => ({
    present: value != null,
    label: title(value?.label),
    displayName: title(value?.displayName),
    generatedName: title(value?.derivedTitle),
  });
  const sameSession = (owner: TitleOwner) => owner.state?.sessionKey === input.sessionKey;
  const preserve = (target: object, key: string) => {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    restores.push(() => {
      if (descriptor) {
        Object.defineProperty(target, key, descriptor);
      } else {
        Reflect.deleteProperty(target, key);
      }
    });
  };
  const captured = new WeakSet<object>();
  const capture = (owner: TitleOwner) => {
    if (captured.has(owner)) {
      return;
    }
    captured.add(owner);
    let metadata: GatewaySessionRow | undefined;
    let previousResolution = "";
    preserve(owner, "transcriptSessionProps");
    const originalProps = owner.transcriptSessionProps.bind(owner);
    owner.transcriptSessionProps = function (selected) {
      const result = originalProps.call(this, selected);
      metadata = result.transcriptMetadata;
      return result;
    };
    preserve(owner, "resolveHeaderSessionTitle");
    const originalTitle = owner.resolveHeaderSessionTitle.bind(owner);
    owner.resolveHeaderSessionTitle = function (selected) {
      metadata = undefined;
      const result = originalTitle.call(this, selected);
      if (sameSession(this)) {
        const presented = this.state?.sessions.presentation.result?.sessions.find(
          (candidate) => candidate.key === input.sessionKey,
        );
        const value = {
          title: title(result),
          source: presented || selected ? "session-row" : metadata ? "hydration" : "generated-name",
          sessionRow: row(presented ?? selected),
          liveRow: row(
            this.state?.sessions.state.result?.sessions.find(
              (candidate) => candidate.key === input.sessionKey,
            ),
          ),
          retainedRow: row(presented),
          cachedMetadata: row(metadata),
        };
        const signature = JSON.stringify(value);
        if (signature !== previousResolution) {
          previousResolution = signature;
          lastResolution = record("title-resolution", value);
        }
      }
      return result;
    };
    preserve(owner, "applySessionsState");
    const originalApply = owner.applySessionsState.bind(owner);
    owner.applySessionsState = function (publication) {
      if (sameSession(this)) {
        record("session-row-publication", {
          cached: publication.resultCached,
          row: row(
            publication.result?.sessions.find((candidate) => candidate.key === input.sessionKey),
          ),
        });
      }
      return originalApply.call(this, publication);
    };
    preserve(owner, "hydrateStoredChatSnapshot");
    const originalHydrate = owner.hydrateStoredChatSnapshot.bind(owner);
    owner.hydrateStoredChatSnapshot = function (state, key) {
      if (key === input.sessionKey) {
        record("hydration-start", {});
        const store = this.sessionSnapshotStore;
        if (store && !captured.has(store)) {
          captured.add(store);
          preserve(store, "read");
          const originalRead = store.read.bind(store);
          store.read = function (cacheKey) {
            const reading = originalRead.call(this, cacheKey).then(async (snapshot) => {
              if (cacheReadGate) {
                cacheReadPending = true;
                await cacheReadGate;
                cacheReadPending = false;
              }
              return snapshot;
            });
            void reading.then(
              (snapshot) => record("cache-read", { metadata: row(snapshot?.transcriptMetadata) }),
              () => record("cache-read-error", {}),
            );
            return reading;
          };
        }
      }
      return originalHydrate.call(this, state, key);
    };
  };
  const OriginalWeakMap = window.WeakMap;
  class RegistrationWeakMap<K extends WeakKey, V> extends OriginalWeakMap<K, V> {
    override set(host: K, value: V): this {
      super.set(host, value);
      if (
        host instanceof HTMLElement &&
        host.localName === "openclaw-chat-pane" &&
        typeof value === "object" &&
        value !== null &&
        "element" in value &&
        value.element === host &&
        "resolveHeaderSessionTitle" in value &&
        typeof value.resolveHeaderSessionTitle === "function" &&
        "transcriptSessionProps" in value &&
        typeof value.transcriptSessionProps === "function" &&
        "hydrateStoredChatSnapshot" in value &&
        typeof value.hydrateStoredChatSnapshot === "function" &&
        "applySessionsState" in value &&
        typeof value.applySessionsState === "function"
      ) {
        // The registered chat owner supplies these existing runtime methods.
        capture(value as TitleOwner);
      }
      return this;
    }
  }
  window.WeakMap = RegistrationWeakMap;
  restores.push(() => {
    if (window.WeakMap === RegistrationWeakMap) {
      window.WeakMap = OriginalWeakMap;
    }
    Reflect.deleteProperty(RegistrationWeakMap.prototype, "set");
  });
  const observeWrite = (node: Node, property: string) => {
    const element = node instanceof Element ? node : node.parentElement;
    const heading = element?.closest(".chat-pane__session-title-text");
    if (!heading) {
      return;
    }
    const event = record("title-write", {
      property,
      title: title(heading.textContent?.trim()),
      resolution: lastResolution?.sequence ?? null,
    });
    if (event.title === "expected-title") {
      expectedTitleSeen = true;
    } else if (event.title === "New session" && expectedTitleSeen) {
      firstLostTitleWrite ??= event;
    }
  };
  for (const [prototype, property] of [
    [Node.prototype, "textContent"],
    [Node.prototype, "nodeValue"],
    [CharacterData.prototype, "data"],
  ] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, property)!;
    Object.defineProperty(prototype, property, {
      ...descriptor,
      set(this: Node, value: string | null) {
        descriptor.set!.call(this, value);
        observeWrite(this, property);
      },
    });
    restores.push(() => Object.defineProperty(prototype, property, descriptor));
  }
  let observedTitle: string | undefined;
  const observer = new MutationObserver(() => {
    const heading = document.querySelector(".chat-pane__session-title-text");
    const next = title(heading?.textContent?.trim());
    if (next !== observedTitle) {
      observedTitle = next;
      if (heading) {
        observeWrite(heading, "mutation-observer");
      }
    }
  });
  observer.observe(document, { subtree: true, childList: true, characterData: true });
  restores.push(() => observer.disconnect());
  window.coldLoadTitleTrace = {
    holdCacheRead() {
      ({ promise: cacheReadGate, resolve: releaseCacheRead } = Promise.withResolvers<void>());
    },
    releaseCacheRead() {
      releaseCacheRead?.();
      cacheReadGate = undefined;
    },
    get cacheReadPending() {
      return cacheReadPending;
    },
    mark(next) {
      phase = next;
      record("phase", {});
    },
    read: () => ({
      attribution:
        "resolution identifies the title source; DOM writes reference the latest observed resolution",
      events,
      firstLostTitleWrite,
      dropped,
    }),
  };
  window.addEventListener("pagehide", () => restores.toReversed().forEach((restore) => restore()), {
    once: true,
  });
}
