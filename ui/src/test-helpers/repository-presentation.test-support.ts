import type { ControlUiSessionPullRequestSnapshot } from "@openclaw/gateway-protocol";
import { asRecord } from "@openclaw/normalization-core/record-coerce";
import { onTestFinished } from "vitest";
import { SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD } from "../../../src/gateway/control-ui-contract.js";
import type { ApplicationContext } from "../app/context.ts";
import { createControlUiPluginHost } from "../plugins/control-ui-host.ts";
import {
  ControlUiPluginRuntime,
  type ControlUiPluginOwner,
} from "../plugins/control-ui-runtime.ts";
import "../plugins/control-ui-contributions.solid.tsx";
import { createTestGatewayClient } from "./gateway-client.ts";
import { repositoryUi } from "./repository-module.ts";

/** Real accessory mounts and host scoping; optional facts isolate component presentation from transport. */
export function installRepositoryPresentation(
  source: ApplicationContext,
  readSnapshot?: () => ControlUiSessionPullRequestSnapshot | undefined,
) {
  let context = source;
  const client = context.gateway.snapshot.client;
  if (!client) {
    throw new Error("Repository presentation fixture needs a connected client.");
  }
  const previous = context.plugins;
  const runtime = new ControlUiPluginRuntime(() => context);
  const retirement: { current?: () => void } = {};
  // The fixture owner is installed directly rather than loaded from a URL. Retire
  // it at the same connection boundary before runtime publications can reach it.
  const stopConnection = context.gateway.subscribe((snapshot) => {
    if (snapshot.phase !== "connected" || snapshot.client !== client) {
      retirement.current?.();
    }
  });
  const owner: Omit<ControlUiPluginOwner, "host"> = {
    descriptor: {
      pluginId: "github-repositories",
      name: "GitHub repositories",
      revision: "synthetic-presentation",
      entryUrl: "/synthetic-repository-presentation.js",
      styles: [],
    },
    client,
    abort: new AbortController(),
    disposers: new Set(),
    selections: new Map(),
    contributions: {
      pages: new Map(),
      navigation: new Map(),
      panels: new Map(),
      actions: new Map(),
      accessories: new Map(),
      widgets: new Map(),
      replacements: new Map(),
      textReferences: new Map(),
      inlineViews: new Map(),
    },
  };
  // Presentation fixtures install one local activation, as createTestControlUiPluginHost does.
  // Catalog loading is covered independently; connection retirement still revokes this host.
  runtime.isCurrent = (current) =>
    current === owner &&
    !owner.abort.signal.aborted &&
    context.gateway.snapshot.phase === "connected" &&
    context.gateway.snapshot.client === client;
  const base = createControlUiPluginHost(() => context, runtime, owner);
  const listeners = new Set<Parameters<ApplicationContext["gateway"]["subscribeEvents"]>[0]>();
  const host = base;
  const interested = new Set<string>();
  const publish = () => {
    const snapshot = readSnapshot?.();
    for (const listener of listeners) {
      listener({
        type: "event",
        event: "controlUi.sessionPullRequests.changed",
        payload: {
          sessions: Object.fromEntries(
            [...interested].map((key) => [
              key,
              snapshot ?? { status: "ready", pullRequests: [], rateLimited: false },
            ]),
          ),
        },
      });
    }
  };
  const request = client.request;
  const subscribeEvents = source.gateway.subscribeEvents;
  const hello = source.gateway.snapshot.hello;
  const originalFeatures = hello?.features;
  if (readSnapshot) {
    if (hello) {
      hello.features = {
        ...hello.features,
        methods: [
          ...new Set([...(hello.features?.methods ?? []), SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD]),
        ],
      };
    }
    client.request = createTestGatewayClient(async (method, params, options) => {
      if (method !== SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD) {
        return request.call(client, method, params, options);
      }
      interested.clear();
      const selection = asRecord(params);
      for (const keys of [selection?.sessionKeys, selection?.passiveSessionKeys]) {
        if (Array.isArray(keys)) {
          for (const key of keys) {
            if (typeof key === "string") {
              interested.add(key);
            }
          }
        }
      }
      queueMicrotask(publish);
      return { subscribed: true };
    }).request;
    source.gateway.subscribeEvents = (listener) => {
      listeners.add(listener);
      const stop = subscribeEvents.call(source.gateway, listener);
      return () => {
        listeners.delete(listener);
        stop();
      };
    };
  }
  const plugins: ApplicationContext["plugins"] = {
    ...previous,
    get errors() {
      return runtime.errors;
    },
    registrations(kind) {
      return [...owner.contributions[kind]].map(([id, entry]) => ({
        key: `${owner.descriptor.pluginId}/${id}`,
        pluginId: owner.descriptor.pluginId,
        host,
        value: entry.value,
        signal: entry.signal,
      }));
    },
    subscribe: (listener) => runtime.subscribe(listener),
    selectedReplacement: (surface) => runtime.selectedReplacement(surface),
    reportError: (pluginId, error) => runtime.reportError(pluginId, error),
  };
  context = { ...source, plugins };
  const activationHost = host.scopeView(owner.abort.signal);
  let activationCleanup: (() => void) | undefined;
  let live = true;
  const ready = Promise.resolve(repositoryUi.default?.activate?.(activationHost)).then(
    (cleanup) => {
      if (typeof cleanup !== "function") {
        return;
      }
      if (live) {
        activationCleanup = cleanup;
      } else {
        cleanup();
      }
    },
  );
  const dispose = () => {
    if (!live) {
      return;
    }
    live = false;
    stopConnection();
    activationCleanup?.();
    owner.abort.abort();
    for (const stop of owner.disposers) {
      stop();
    }
    owner.disposers.clear();
    listeners.clear();
    if (readSnapshot) {
      client.request = request;
      source.gateway.subscribeEvents = subscribeEvents;
      if (hello) {
        hello.features = originalFeatures;
      }
    }
    runtime.dispose();
  };
  retirement.current = dispose;
  onTestFinished(dispose);
  return {
    context,
    host,
    ready,
    notify: publish,
    dispose,
  };
}
