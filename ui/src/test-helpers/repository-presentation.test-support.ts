import type { ControlUiSessionPullRequestSnapshot } from "@openclaw/gateway-protocol";
import { onTestFinished } from "vitest";
import {
  createSessionAccessoryMount,
  createMobileSessionAccessoryMount,
  createHovercardAccessoryMount,
  createSidebarAccessoryMount,
  type RepositoryBrowserRuntime,
} from "../../../extensions/github-repositories/browser/api.ts";
import githubPlugin from "../../../extensions/github-repositories/browser/index.tsx";
import type { ApplicationContext } from "../app/context.ts";
import "../plugins/control-ui-contributions.solid.tsx";
import { createControlUiPluginHost } from "../plugins/control-ui-host.ts";
import {
  ControlUiPluginRuntime,
  type ControlUiPluginOwner,
} from "../plugins/control-ui-runtime.ts";

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
      uiCapabilities: ["accessory", "action"],
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
  const listeners = new Set<() => void>();
  const host = base;
  const repository: RepositoryBrowserRuntime | undefined = readSnapshot
    ? {
        read: readSnapshot,
        observe(_target, listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        store: {
          get: readSnapshot,
          branchKnown: () => readSnapshot()?.branchRead !== false,
          load: async () => readSnapshot(),
          watch() {},
          unwatch() {},
          refresh: () => false,
          dispose() {
            listeners.clear();
          },
          subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
        },
      }
    : undefined;
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
  const ready = repository
    ? Promise.resolve()
    : Promise.resolve(githubPlugin.activate?.(activationHost)).then((cleanup) => {
        if (typeof cleanup !== "function") {
          return;
        }
        if (live) {
          activationCleanup = cleanup;
        } else {
          cleanup();
        }
      });
  if (repository) {
    runtime.register(owner, "accessories", {
      id: "repository-hovercard",
      placement: "session-hovercard",
      mount: createHovercardAccessoryMount(repository),
    });
    runtime.register(owner, "accessories", {
      id: "repository-row",
      placement: "session-row",
      mount: createSidebarAccessoryMount(repository),
    });
    runtime.register(owner, "accessories", {
      id: "repository",
      placement: "session-context",
      mount: createSessionAccessoryMount(activationHost, repository),
    });
    runtime.register(owner, "accessories", {
      id: "repository-environment",
      placement: "session-environment",
      mount: createSessionAccessoryMount(activationHost, repository, true),
    });
    for (const placement of ["root", "page", "activity"] as const) {
      runtime.register(owner, "accessories", {
        id: `repository-mobile-${placement}`,
        placement: `session-mobile-${placement}`,
        mount: createMobileSessionAccessoryMount(activationHost, repository, placement),
      });
    }
  }
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
    runtime.dispose();
  };
  retirement.current = dispose;
  onTestFinished(dispose);
  return {
    context,
    host,
    ready,
    notify() {
      for (const listener of listeners) {
        listener();
      }
    },
    dispose,
  };
}
