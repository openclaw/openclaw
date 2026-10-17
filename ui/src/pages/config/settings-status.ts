import { createEffect, createMemo, createSignal, onCleanup, untrack } from "solid-js";
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
  const [revision, setRevision] = createSignal(0);
  const refresh = () => setRevision((value) => value + 1);
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
        if (identityChanged) {
          setResult(undefined);
          setError(undefined);
        }
        options.onConnectionChange?.(identityChanged);
        refresh();
      }
    }),
  );
  function capture() {
    const owner = context.gateway;
    // Mutation authority captures this connection once, then checks it at settlement.
    const currentClient = untrack(client);
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
  const key = createMemo(
    () => {
      const snapshot = gatewayProjection.read().snapshot;
      configProjection.read();
      return [
        client(),
        configHash(),
        snapshot.phase,
        snapshot.hello,
        snapshot.hello?.auth,
        revision(),
      ] as const;
    },
    { equals: (previous, next) => previous.every((value, index) => value === next[index]) },
  );
  // Gateway status requests follow the admitted connection and config revision.
  createEffect(key, ([currentClient, hash], previous) => {
    request?.abort();
    if (!currentClient) {
      if (previous) {
        setState("idle");
      }
      return undefined;
    }
    const controller = new AbortController();
    request = controller;
    const ownsConnection = capture();
    const isConnectionCurrent = () => ownsConnection() && configHash() === hash;
    const isCurrent = () =>
      !controller.signal.aborted && request === controller && isConnectionCurrent();
    if (previous) {
      setState("pending");
    }
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
    return () => controller.abort();
  });
  onCleanup(() => {
    disposed = true;
    request?.abort();
  });
  return { client, state, error, result, refresh, capture, gatewayProjection, configProjection };
}
