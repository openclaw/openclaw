import { createMemo } from "solid-js";
import type { ControlUiSession } from "../../../src/plugin-sdk/control-ui.js";
import { listen } from "../lib/reactive/listener.ts";
import { projectSource } from "../lib/reactive/projection.ts";
import { pluginSessionMenuActions } from "./control-ui-actions.ts";
import type { ControlUiPluginCapability } from "./control-ui-capability.ts";

/** Menu lifetime owns interest; plugin state stays with its activation. */
export function createSessionMenuActionsProjection(
  read: () => {
    runtime?: ControlUiPluginCapability;
    session?: ControlUiSession;
  },
) {
  const source = createMemo(() =>
    projectSource(read(), {
      read: ({ runtime, session }) =>
        runtime && session ? pluginSessionMenuActions(runtime, session) : [],
      subscribe: ({ runtime, session }, notify) =>
        runtime && session ? observeSessionMenuActions(runtime, session, notify) : () => {},
      equality: "revision",
    }),
  );
  return () => source().read();
}

/** Observe active session actions without retaining a hidden menu or a retired plugin. */
export function observeSessionMenuActions(
  runtime: ControlUiPluginCapability,
  session: ControlUiSession,
  notify: () => void,
): () => void {
  let live = true;
  const observed = new Map<AbortSignal, () => void>();
  const changed = () => {
    if (live) {
      notify();
    }
  };
  const reconcile = () => {
    const entries = runtime
      .registrations("actions")
      .filter(
        (entry) =>
          entry.value.placement === "session" && entry.value.observe && !entry.signal.aborted,
      );
    const current = new Set(entries.map((entry) => entry.signal));
    for (const [signal, stop] of observed) {
      if (!current.has(signal)) {
        observed.delete(signal);
        stop();
      }
    }
    for (const entry of entries) {
      if (observed.has(entry.signal) || !entry.value.observe) {
        continue;
      }
      const lifetime = new AbortController();
      const signal = AbortSignal.any([entry.signal, lifetime.signal]);
      let ended = false;
      let stop: (() => void) | undefined;
      const retire = () => {
        if (ended) {
          return;
        }
        ended = true;
        stopAbort();
        lifetime.abort();
        stop?.();
      };
      // Register custody before calling plugin code, which may synchronously withdraw itself.
      observed.set(entry.signal, retire);
      const stopAbort = listen(entry.signal, "abort", retire, { once: true });
      try {
        const cleanup = entry.value.observe(
          {
            sessionKey: session.key,
            agentId: session.agentId,
            session: structuredClone(session),
            signal,
          },
          () => {
            if (!signal.aborted) {
              changed();
            }
          },
        );
        if (ended) {
          cleanup();
        } else {
          stop = cleanup;
        }
      } catch (error) {
        retire();
        runtime.reportError(entry.pluginId, error);
      }
    }
  };
  let actions = runtime.registrations("actions");
  const stopRuntime = runtime.subscribe(() => {
    const next = runtime.registrations("actions");
    // A registration replacement has a new signal; diagnostics preserve the same lifetimes.
    if (
      next.length === actions.length &&
      next.every((entry, index) => entry.signal === actions[index]?.signal)
    ) {
      return;
    }
    actions = next;
    reconcile();
    changed();
  });
  reconcile();
  return () => {
    live = false;
    stopRuntime();
    for (const stop of observed.values()) {
      stop();
    }
    observed.clear();
  };
}
