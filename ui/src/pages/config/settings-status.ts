import { createEffect, createMemo, createSignal, onCleanup, untrack } from "solid-js";
import type { ApplicationContext } from "../../app/context-types.ts";
import type { hasOperatorReadAccess } from "../../app/operator-access.ts";
import { createGatewayConnectionLifecycle } from "../../lib/gateway-connection-lifecycle.ts";
import { projectGateway } from "../../lib/reactive/application.ts";
import { projectRuntimeConfig } from "../../lib/reactive/domain-capabilities.ts";

/** Shared health reads; each settings page still owns its edits and write authority. */
export function createSettingsStatus<T>(
  context: ApplicationContext,
  options: {
    method: string;
    access: typeof hasOperatorReadAccess;
    configHash: "hash" | "appliedConfigHash";
    onConnectionChange?: () => void;
    onStatus?: (status: T) => void;
    onError?: () => void;
  },
) {
  const gatewayProjection = projectGateway(context.gateway);
  const configProjection = projectRuntimeConfig(context.runtimeConfig);
  const gateway = createGatewayConnectionLifecycle(context.gateway.snapshot);
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
  const [state, setState] = createSignal<"idle" | "pending" | "complete" | "error">(
    untrack(client) ? "pending" : "idle",
  );
  const [error, setError] = createSignal<unknown>();
  const [result, setResult] = createSignal<{ status: T; isCurrent: () => boolean }>();
  const [revision, setRevision] = createSignal(0);
  const refresh = () => setRevision((value) => value + 1);
  let previousHello = context.gateway.snapshot.hello;
  let previousAuth = previousHello?.auth;
  onCleanup(
    gatewayProjection.subscribe(() => {
      const snapshot = context.gateway.snapshot;
      const transition = gateway.transition(snapshot);
      const identityChanged =
        previousHello !== snapshot.hello || previousAuth !== snapshot.hello?.auth;
      if (identityChanged) {
        gateway.invalidate();
      }
      previousHello = snapshot.hello;
      previousAuth = snapshot.hello?.auth;
      if (transition || identityChanged) {
        request?.abort();
        options.onConnectionChange?.();
        refresh();
      }
    }),
  );
  function capture() {
    const owner = context.gateway;
    const snapshot = owner.snapshot;
    const currentClient = untrack(client);
    const scope = gateway.capture();
    const hello = snapshot.hello;
    const auth = hello?.auth;
    return () =>
      currentClient !== null &&
      scope !== null &&
      client() === currentClient &&
      gateway.isCurrent(scope) &&
      context.gateway === owner &&
      owner.snapshot.hello === hello &&
      hello?.auth === auth;
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
      (status) =>
        untrack(() => {
          if (isCurrent()) {
            setResult({ status, isCurrent: isConnectionCurrent });
            setState("complete");
            options.onStatus?.(status);
          }
        }),
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
    gateway.dispose();
  });
  return { client, state, error, result, refresh, capture, gatewayProjection, configProjection };
}
