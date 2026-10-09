import { createSignal, onCleanup } from "solid-js";
import { vi } from "vitest";
import type { GatewayBrowserClient, GatewayEventListener } from "../../api/gateway.ts";
import type { CronJob, CronJobsListResult } from "../../api/types.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import {
  createGatewayMetadataObserver,
  notifyGatewayObservers,
} from "../../app/gateway-observers.ts";
import { invalidateChatMetadataStore } from "../../lib/chat/chat-metadata-cache.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../test-helpers/solid-application-context.tsx";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { CronPageController } from "./cron-page-controller.ts";
import { CronPageContent } from "./cron-page.tsx";

export type CronTestPage = HTMLElement &
  Pick<
    CronPageController,
    | "context"
    | "routeSearch"
    | "cron"
    | "cronModelSuggestions"
    | "patchForm"
    | "deliveryDirectory"
    | "closePanel"
    | "submitForm"
    | "selectJob"
    | "removeJob"
  > & {
    settle: () => Promise<void>;
    refreshView: () => void;
    hideView: () => void;
  };

export function waitForCronPage(assertion: () => void) {
  return waitForSolid(assertion);
}

type TestGateway = ApplicationContext["gateway"] & {
  emitSnapshot: (patch: Partial<ApplicationGatewaySnapshot>) => void;
  emitRetiredEvent: (event: Parameters<GatewayEventListener>[0]) => void;
};

export function createGateway(client: GatewayBrowserClient, connected: boolean): TestGateway {
  invalidateChatMetadataStore(client);
  let snapshot: ApplicationGatewaySnapshot = {
    client,
    phase: connected ? "connected" : "stopped",
    offlineStable: false,
    canvasPluginSurfaceUrl: null,
    hello: null,
    assistantAgentId: null,
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  };
  const metadataObserver = createGatewayMetadataObserver((current) => current === snapshot);
  const snapshotListeners = new Set<(next: ApplicationGatewaySnapshot) => void>();
  const eventListeners = new Set<GatewayEventListener>();
  const allEventListeners: GatewayEventListener[] = [];
  return {
    get snapshot() {
      return snapshot;
    },
    connection: { gatewayUrl: "", token: "", password: "" },
    subscribe(listener: (next: ApplicationGatewaySnapshot) => void) {
      snapshotListeners.add(listener);
      return () => snapshotListeners.delete(listener);
    },
    subscribeEvents(listener: GatewayEventListener) {
      eventListeners.add(listener);
      allEventListeners.push(listener);
      return () => eventListeners.delete(listener);
    },
    emitSnapshot(patch: Partial<ApplicationGatewaySnapshot>) {
      const previous = snapshot;
      snapshot = { ...previous, ...patch };
      if (metadataObserver.synchronize(previous, snapshot)) {
        notifyGatewayObservers(
          snapshotListeners,
          snapshot,
          "snapshot",
          (current) => current === snapshot,
        );
      }
    },
    emitRetiredEvent(event: Parameters<GatewayEventListener>[0]) {
      if (
        eventListeners.size > 0 &&
        (event.event === "config.changed" || event.event === "chat.metadata.changed")
      ) {
        invalidateChatMetadataStore(client);
      }
      for (const listener of allEventListeners) {
        listener(event);
      }
    },
  } as unknown as TestGateway;
}

export function operatorHello(scopes: string[]): NonNullable<ApplicationGatewaySnapshot["hello"]> {
  return {
    type: "hello-ok",
    protocol: 4,
    auth: { role: "operator", scopes },
  };
}

export function createContext(
  gateway: ApplicationContext["gateway"],
  scopeId: string | null = "main",
  selectedId: string | null = scopeId,
): ApplicationContext {
  const subscribe = () => () => undefined;
  let selectionState = { selectedId, scopeId };
  let intentRevision = 0;
  const selectionListeners = new Set<(state: typeof selectionState) => void>();
  return {
    basePath: "",
    gateway,
    agents: {
      state: {
        agentsList: { defaultId: "main", agents: [{ id: "main" }] },
        agentsLoading: false,
        agentsError: null,
      },
      ensureList: vi.fn(async () => undefined),
      subscribe,
    },
    channels: {
      state: {
        channelsSnapshot: null,
      },
      refresh: vi.fn(async () => undefined),
      subscribe,
    },
    runtimeConfig: {
      state: { configSnapshot: null },
      subscribe,
    },
    agentSelection: {
      get intentRevision() {
        return intentRevision;
      },
      get state() {
        return selectionState;
      },
      set(agentId: string | null) {
        intentRevision += 1;
        selectionState = { selectedId: agentId, scopeId: agentId };
        for (const listener of selectionListeners) {
          listener(selectionState);
        }
      },
      setScope(agentId: string | null) {
        intentRevision += 1;
        selectionState = { ...selectionState, scopeId: agentId };
        for (const listener of selectionListeners) {
          listener(selectionState);
        }
      },
      subscribe(listener: (state: typeof selectionState) => void) {
        selectionListeners.add(listener);
        return () => selectionListeners.delete(listener);
      },
    },
    navigate: vi.fn(),
    preload: vi.fn(async () => undefined),
  } as unknown as ApplicationContext;
}

export function createPage(
  context: ApplicationContext,
  options: { render?: boolean } = {},
): CronTestPage {
  // SAFETY: The native mount host receives the controller facade below before it is returned.
  const page = document.createElement("section") as CronTestPage;
  document.body.append(page);
  let controller!: CronPageController;
  let hideView!: () => void;
  const provider = createSolidApplicationContextProvider(context);
  const mounted = mountSolid(
    () => {
      const [revision, setRevision] = createSignal(0, { ownedWrite: true });
      const [visible, setVisible] = createSignal(options.render ?? false);
      hideView = () => setVisible(false);
      controller = new CronPageController(context, page, () => setRevision((value) => value + 1));
      controller.activate();
      onCleanup(() => controller.dispose());
      return (
        <>{visible() ? <CronPageContent controller={controller} revision={revision} /> : null}</>
      );
    },
    { container: page, wrapper: provider.wrapper },
  );
  for (const key of [
    "context",
    "routeSearch",
    "cron",
    "cronModelSuggestions",
    "deliveryDirectory",
  ] as const) {
    Object.defineProperty(page, key, {
      get: () => controller[key],
      set: (value) => {
        if (key === "routeSearch") {
          controller.setRouteSearch(value);
        } else {
          Reflect.set(controller, key, value);
        }
      },
    });
  }
  for (const key of ["patchForm", "closePanel", "submitForm", "selectJob", "removeJob"] as const) {
    Object.defineProperty(page, key, { value: controller[key].bind(controller) });
  }
  page.refreshView = () => controller.publish();
  page.hideView = hideView;
  page.settle = async () => {
    await Promise.resolve();
    flush();
  };
  page.remove = () => {
    mounted.unmount();
    HTMLElement.prototype.remove.call(page);
  };
  flush();
  return page;
}

export function cronListResponse(jobs: CronJob[]): CronJobsListResult {
  return {
    jobs: jobs.map((job) => ({
      configRevision: job.configRevision ?? `config-revision-${job.id}`,
      ...job,
    })),
    snapshotRevision: "cron-page-fixture",
    total: jobs.length,
    offset: 0,
    limit: 50,
    hasMore: false,
    nextOffset: null,
  };
}

export function createRequest(
  cronStatus: { enabled: boolean; jobs: number; triggersEnabled: boolean } = {
    enabled: true,
    jobs: 0,
    triggersEnabled: true,
  },
) {
  return vi.fn(async (method: string) => {
    if (method === "cron.status") {
      return { ...cronStatus };
    }
    if (method === "cron.list") {
      return cronListResponse([]);
    }
    if (method === "cron.runs") {
      return { entries: [], total: 0, offset: 0, hasMore: false };
    }
    if (method === "models.list") {
      return { models: [] };
    }
    return {};
  });
}
