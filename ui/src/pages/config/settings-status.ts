import { createMemo, createSignal, isPending, latest, onCleanup, onSettled } from "solid-js";
import type { ApplicationContext } from "../../app/context-types.ts";
import type { hasOperatorReadAccess } from "../../app/operator-access.ts";
import { projectGateway } from "../../lib/reactive/application.ts";
import { projectRuntimeConfig } from "../../lib/reactive/domain-capabilities.ts";

/** Shared health reads; each settings page still owns its edits and write authority. */
export function createSettingsStatus<T>(
  context: ApplicationContext,
  options: {
    method: string;
    access: typeof hasOperatorReadAccess;
    configHash: "hash" | "appliedConfigHash";
    onConnectionChange?: (identityChanged: boolean) => void;
    onStatus?: (status: T, isCurrent: () => boolean) => void;
    onError?: () => void;
  },
) {
  const gatewayProjection = projectGateway(context.gateway);
  const configProjection = projectRuntimeConfig(context.runtimeConfig);
  let disposed = false;
  let abortRequest: (() => void) | undefined;
  const client = () => {
    const snapshot = gatewayProjection.read().snapshot;
    return !disposed &&
      snapshot.phase === "connected" &&
      options.access(snapshot.hello?.auth ?? null)
      ? snapshot.client
      : null;
  };
  type Result = { status: T; isCurrent: () => boolean };
  type Outcome = { result: Result } | { error: unknown };
  type Read = { scope: object; promise?: Promise<Outcome | undefined> };
  let scope = {};
  // Immutable issued-read identities; payloads stay on their admitted promise.
  const [issued, setIssued] = createSignal<Read>({ scope });
  const scopeKey = createMemo(() => issued().scope);
  type Snapshot = { scope: object; outcome?: Outcome };
  const reads = createMemo<Snapshot>((previous) => {
    const current = issued();
    const retained = previous?.scope === current.scope ? previous.outcome : undefined;
    // A retired read keeps only an accepted answer from the same connection scope.
    return current.promise
      ? current.promise.then((outcome) => ({ scope: current.scope, outcome: outcome ?? retained }))
      : { scope: current.scope, outcome: retained };
  });
  const lastOutcome = () => {
    const current = latest(reads);
    return current.scope === scopeKey() ? current.outcome : undefined;
  };
  const pending = createMemo(
    () => Boolean(client()) && (isPending(reads) || lastOutcome() === undefined),
  );
  const result = createMemo(() => {
    const outcome = lastOutcome();
    return outcome && "result" in outcome ? outcome.result : undefined;
  });
  const read = () => {
    if (!client()) {
      return result();
    }
    const outcome = reads().outcome;
    if (outcome && "error" in outcome) {
      throw outcome.error;
    }
    return outcome?.result;
  };
  let lastRequestKey: ReturnType<typeof requestKey> | undefined;
  const scheduleRefresh = () => onSettled(refreshIfChanged);
  const connectionKey = () => {
    const snapshot = context.gateway.snapshot;
    return [snapshot.client, snapshot.phase, snapshot.hello, snapshot.hello?.auth] as const;
  };
  let connection = connectionKey();
  onCleanup(
    // Every connection receipt retires requests before a same-turn reconnect can settle them.
    gatewayProjection.subscribe(() => {
      const next = connectionKey();
      if (connection.some((value, index) => value !== next[index])) {
        const identityChanged =
          connection[0] !== next[0] ||
          (next[1] === "connected" && !options.access(next[3] ?? null));
        connection = next;
        abortRequest?.();
        // A same-turn reconnect must replace the retired read even if the final key is equal.
        lastRequestKey = undefined;
        if (identityChanged) {
          scope = {};
          setIssued({ scope });
        }
        options.onConnectionChange?.(identityChanged);
        scheduleRefresh();
      }
    }),
  );
  function capture() {
    const owner = context.gateway;
    // Mutation authority captures this connection once, then checks it at settlement.
    const currentClient = client();
    const captured = connectionKey();
    return () => {
      const current = connectionKey();
      return (
        currentClient !== null &&
        !disposed &&
        current[0] === currentClient &&
        current[1] === "connected" &&
        options.access(current[3] ?? null) &&
        context.gateway === owner &&
        captured.every((value, index) => value === current[index])
      );
    };
  }
  const configHash = () => context.runtimeConfig.state.configSnapshot?.[options.configHash];
  function requestKey() {
    const snapshot = context.gateway.snapshot;
    return [client(), configHash(), snapshot.phase, snapshot.hello, snapshot.hello?.auth] as const;
  }
  function refreshIfChanged() {
    const key = requestKey();
    if (lastRequestKey?.every((value, index) => value === key[index])) {
      return;
    }
    readStatus(key);
  }
  function refresh() {
    readStatus(requestKey());
  }
  function readStatus(key: ReturnType<typeof requestKey>) {
    if (disposed) {
      return;
    }
    const [currentClient, hash] = key;
    lastRequestKey = key;
    abortRequest?.();
    if (!currentClient) {
      return;
    }
    const controller = new AbortController();
    const retired = Promise.withResolvers<undefined>();
    // Retiring the read must release its frame even if the transport settles later.
    const abort = () => {
      controller.abort();
      retired.resolve(undefined);
    };
    abortRequest = abort;
    const ownsConnection = capture();
    const isConnectionCurrent = () => ownsConnection() && configHash() === hash;
    const isCurrent = () =>
      !controller.signal.aborted && abortRequest === abort && isConnectionCurrent();
    const response = currentClient
      .request<T>(options.method, {}, { signal: controller.signal })
      .then(
        (status) => {
          if (isCurrent()) {
            options.onStatus?.(status, isCurrent);
            return { result: { status, isCurrent: isConnectionCurrent } };
          }
          return undefined;
        },
        (failure: unknown) => {
          if (isCurrent()) {
            options.onError?.();
            return { error: failure };
          }
          return undefined;
        },
      );
    const promise = Promise.race([response, retired.promise]);
    setIssued({ scope, promise });
  }
  // Config receipts admit a new status read after the current write has settled.
  onCleanup(configProjection.subscribe(scheduleRefresh));
  onSettled(refreshIfChanged);
  onCleanup(() => {
    disposed = true;
    abortRequest?.();
  });
  return {
    client,
    pending,
    result,
    read,
    scopeKey,
    requestKey: issued,
    refresh,
    capture,
    gatewayProjection,
    configProjection,
  };
}
