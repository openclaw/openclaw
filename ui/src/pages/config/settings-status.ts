import { createMemo, createSignal, onCleanup, onSettled } from "solid-js";
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
    onStatus?: (status: T) => void;
    onError?: () => void;
  },
) {
  const gatewayProjection = projectGateway(context.gateway);
  const configProjection = projectRuntimeConfig(context.runtimeConfig);
  let disposed = false;
  let request: AbortController | undefined;
  const client = () => {
    const snapshot = gatewayProjection.read().snapshot;
    return !disposed &&
      snapshot.phase === "connected" &&
      options.access(snapshot.hello?.auth ?? null)
      ? snapshot.client
      : null;
  };
  const stateConnection = createMemo(client);
  // A connection change retires the local request state; refreshes keep their result.
  const [state, setState] = createSignal<"idle" | "pending" | "complete" | "error">(() =>
    stateConnection() ? "pending" : "idle",
  );
  const [error, setError] = createSignal<unknown>();
  const [result, setResult] = createSignal<{ status: T; isCurrent: () => boolean }>();
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
        request?.abort();
        // A same-turn reconnect must replace the retired read even if the final key is equal.
        lastRequestKey = undefined;
        if (identityChanged) {
          setResult(undefined);
          setError(undefined);
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
        client() === currentClient &&
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
    request?.abort();
    if (!currentClient) {
      setState("idle");
      return;
    }
    const controller = new AbortController();
    request = controller;
    const ownsConnection = capture();
    const isConnectionCurrent = () => ownsConnection() && configHash() === hash;
    const isCurrent = () =>
      !controller.signal.aborted && request === controller && isConnectionCurrent();
    setState("pending");
    void currentClient.request<T>(options.method, {}, { signal: controller.signal }).then(
      (status) => {
        if (isCurrent()) {
          setResult({ status, isCurrent: isConnectionCurrent });
          setState("complete");
          options.onStatus?.(status);
        }
      },
      (failure: unknown) => {
        if (isCurrent()) {
          setResult(undefined);
          setError(failure);
          setState("error");
          options.onError?.();
        }
      },
    );
  }
  // Config receipts admit a new status read after the current write has settled.
  onCleanup(configProjection.subscribe(scheduleRefresh));
  onSettled(refreshIfChanged);
  onCleanup(() => {
    disposed = true;
    request?.abort();
  });
  return { client, state, error, result, refresh, capture, gatewayProjection, configProjection };
}
