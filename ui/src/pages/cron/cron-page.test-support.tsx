import { createRouter, definePage } from "@openclaw/uirouter";
import { createSignal } from "solid-js";
import { vi } from "vitest";
import type { GatewayBrowserClient, GatewayEventListener } from "../../api/gateway.ts";
import type { CronJob, CronJobsListResult } from "../../api/types.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import {
  createGatewayMetadataObserver,
  notifyGatewayObservers,
} from "../../app/gateway-observers.ts";
import { createAgentIdentityCapability } from "../../lib/agents/identity.ts";
import { invalidateChatMetadataStore } from "../../lib/chat/chat-metadata-cache.ts";
import { createApplicationGatewaySnapshot } from "../../test-helpers/application-context-fixtures.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../test-helpers/solid-application-context.tsx";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createCronPage } from "./cron-page-state.ts";
import { CronPageContent } from "./cron-page.tsx";

type CronPageState = ReturnType<typeof createCronPage>;
export type CronTestPage = HTMLElement & {
  context: ApplicationContext;
  routeSearch: string;
  cron: ReturnType<CronPageState["cron"]>;
  cronModelSuggestions: string[];
  deliveryDirectory: CronPageState["deliveryDirectory"];
  patchForm: CronPageState["actions"]["onFormChange"];
  closePanel: CronPageState["actions"]["onClosePanel"];
  submitForm: (runNow?: boolean) => void;
  selectJob: CronPageState["actions"]["onSelectJob"];
  removeJob: CronPageState["actions"]["onRemove"];
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
  let snapshot: ApplicationGatewaySnapshot = createApplicationGatewaySnapshot({
    client,
    phase: connected ? "connected" : "stopped",
    sessionKey: "main",
  });
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
    router: createRouter({
      routes: [definePage({ id: "cron", path: "/cron", component: () => ({}) })],
    }),
    gateway,
    agentIdentity: createAgentIdentityCapability(gateway),
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
  options: { render?: boolean; attach?: boolean } = {},
): CronTestPage {
  // SAFETY: The native mount host receives the test facade below before it is returned.
  const page = document.createElement("section") as CronTestPage;
  if (options.attach !== false) {
    document.body.append(page);
  }
  let currentContext = context;
  let routeSearch = "";
  let state!: ReturnType<typeof createCronPage>;
  let hideView!: () => void;
  const provider = createSolidApplicationContextProvider(context);
  const mounted = mountSolid(
    () => {
      const [visible, setVisible] = createSignal(options.render ?? false);
      hideView = () => setVisible(false);
      state = createCronPage(
        () => currentContext,
        () => page,
      );
      return <>{visible() ? <CronPageContent page={state} /> : null}</>;
    },
    { container: page, wrapper: provider.wrapper },
  );
  Object.defineProperty(page, "context", {
    get: () => currentContext,
    set: (value: ApplicationContext) => {
      currentContext = value;
    },
  });
  Object.defineProperty(page, "routeSearch", {
    get: () => routeSearch,
    set: (value: string) => {
      routeSearch = value;
      state.setRouteSearch(value);
    },
  });
  Object.defineProperty(page, "cronModelSuggestions", { get: () => state.cronModelSuggestions() });
  Object.defineProperty(page, "cron", { get: () => state.cron() });
  Object.defineProperty(page, "deliveryDirectory", { get: () => state.deliveryDirectory });
  page.patchForm = state.actions.onFormChange;
  page.closePanel = state.actions.onClosePanel;
  page.submitForm = (runNow = false) =>
    runNow ? state.actions.onSubmitRunNow() : state.actions.onSubmit();
  page.selectJob = state.actions.onSelectJob;
  page.removeJob = state.actions.onRemove;
  page.refreshView = () => state.publish();
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
