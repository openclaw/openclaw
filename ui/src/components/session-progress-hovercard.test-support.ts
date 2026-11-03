import type { ProgressCard, ControlUiSessionPullRequestSnapshot } from "@openclaw/gateway-protocol";
import { afterEach, vi } from "vitest";
import { SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD } from "../../../src/gateway/control-ui-contract.js";
import { createApplicationConfigCapability } from "../app/config.ts";
import {
  applicationContext,
  type ApplicationContext,
  type ApplicationContextRequest,
} from "../app/context.ts";
import type { ApplicationGateway } from "../app/gateway.ts";
import { listen } from "../lib/reactive/listener.ts";
import {
  createTestSessionCapability,
  sessionsResult,
} from "../lib/sessions/session-capability.test-support.ts";
import { installRepositoryPresentation } from "../test-helpers/repository-presentation.test-support.ts";
import { flush } from "../test-helpers/solid-settle.ts";
import type { SidebarSessionHovercardRow } from "./app-sidebar-session-types.ts";
import type { SessionProgressHovercardProvider } from "./session-progress-hovercard.runtime.tsx";
import "./session-progress-hovercard.runtime.tsx";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const dispose of cleanups.splice(0)) {
    dispose();
  }
});

function subscriptions<T>() {
  const listeners = new Set<(value: T) => void>();
  return {
    subscribe(this: void, listener: (value: T) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(value: T) {
      listeners.forEach((listener) => listener(value));
    },
  };
}

export function createHovercard({
  sessionKey = "global",
  card,
  holdProgress = false,
  rowDetails: initialRowDetails = {},
  triggerKind = "sidebar",
  browser = false,
}: {
  sessionKey?: string;
  card?: ProgressCard | null;
  holdProgress?: boolean;
  rowDetails?: Partial<SidebarSessionHovercardRow>;
  triggerKind?: "sidebar" | "markdown";
  browser?: boolean;
} = {}) {
  let rowDetails = initialRowDetails;
  let selectedId = "research";
  let releaseProgress: (() => void) | undefined;
  const selection = subscriptions<ApplicationContext["agentSelection"]["state"]>();
  const sessions = subscriptions<void>();
  const events =
    subscriptions<Parameters<Parameters<ApplicationGateway["subscribeEvents"]>[0]>[0]>();
  const emit = (event: string, payload: unknown) => events.emit({ type: "event", event, payload });
  const request = vi.fn(
    async (method: string, params: { sessionKey?: string; agentId?: string }) => {
      if (method === "sessions.list") {
        return sessionsResult([
          {
            key: sessionKey,
            agentId: selectedId,
            kind: "direct",
            displayName: "Synthetic provider session",
            updatedAt: 1,
          },
        ]);
      }
      if (method === "sessions.subscribe") {
        return { subscribed: true };
      }
      if (method === SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD) {
        return { sessions: {} };
      }
      if (method !== "progressCard.get") {
        throw new Error(`Unexpected request: ${method}`);
      }
      const owner = params.agentId ?? params.sessionKey?.split(":")[1];
      if (holdProgress && owner === "research") {
        await new Promise<void>((resolve) => {
          releaseProgress = resolve;
        });
      }
      if (card !== undefined) {
        return { card };
      }
      const key = params.sessionKey?.startsWith("agent:")
        ? params.sessionKey
        : `agent:${params.agentId}:${params.sessionKey}`;
      return {
        card: {
          sessionKey: key,
          revision: 1,
          updatedAt: 1,
          markdown: `${owner} progress`,
          steps: [{ step: `${owner} progress`, status: "in_progress" }],
        },
      };
    },
  );
  // These fixtures implement only the gateway/context surfaces consumed by the provider.
  const gateway = {
    snapshot: {
      phase: "connected",
      sessionKey,
      assistantAgentId: browser ? "research" : "main",
      client: { request },
      hello: {
        auth: { role: "operator", scopes: ["operator.read"] },
        features: { methods: ["progressCard.get", SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD] },
      },
    },
    connection: { gatewayUrl: "ws://example.test", token: "", password: "" },
    subscribe: () => () => undefined,
    subscribeEvents: events.subscribe,
  } as unknown as ApplicationGateway;
  const sessionCapability = createTestSessionCapability(gateway, selectedId);
  const subscribeNative = sessionCapability.subscribe;
  sessionCapability.subscribe = (listener) => {
    const stopNative = subscribeNative(listener);
    const stopFixture = sessions.subscribe(() => listener(sessionCapability.state));
    return () => {
      stopNative();
      stopFixture();
    };
  };
  let context = {
    gateway,
    basePath: "",
    resourceBasePath: "",
    config: createApplicationConfigCapability({ resourceBasePath: "" }),
    agents: {
      state: { agentsList: { agents: [], defaultId: "research" } },
      subscribe: () => () => undefined,
    },
    theme: { subscribe: () => () => undefined },
    sessions: sessionCapability,
    agentSelection: {
      get state() {
        return { selectedId, scopeId: selectedId };
      },
      subscribe: selection.subscribe,
    },
  } as unknown as ApplicationContext;
  let rosterReady = Promise.resolve();
  if (browser || triggerKind === "markdown") {
    const agentsList = { agents: [{ id: "research" }], defaultId: "research", mainKey: "main" };
    Object.assign(context, { agents: { state: { agentsList }, subscribe: () => () => undefined } });
    rosterReady = sessionCapability.refresh();
  }
  const repository = installRepositoryPresentation(context);
  context = repository.context;
  cleanups.push(repository.dispose);
  const provider = document.createElement(
    "openclaw-session-progress-hovercard-provider",
  ) as SessionProgressHovercardProvider;
  Object.assign(provider, { context, gateway });
  cleanups.push(
    listen(provider, "context-request", (event) => {
      // SAFETY: the shared context token identifies this existing native bridge protocol.
      const contextRequest = event as ApplicationContextRequest;
      if (
        contextRequest.context !== applicationContext ||
        contextRequest.contextTarget === provider ||
        !provider.context
      ) {
        return;
      }
      event.stopPropagation();
      contextRequest.callback(provider.context, () => undefined);
    }),
  );
  const sidebar = Object.assign(document.createElement("openclaw-app-sidebar"), {
    expandedAgentId: () => (browser ? "research" : selectedId),
    findSidebarHovercardRowByKey: () => ({
      key: sessionKey,
      agentId: browser ? "research" : selectedId,
      label: browser ? "Synthetic provider session" : `${selectedId} session`,
      kind: "direct",
      hasAutomation: false,
      hasActiveRun: false,
      ...(browser ? { lastMessagePreview: "Synthetic latest turn" } : {}),
      ...rowDetails,
    }),
  });
  provider.lookupSidebarRow = sidebar.findSidebarHovercardRowByKey;
  const row = Object.assign(document.createElement("div"), {
    className: triggerKind === "markdown" ? "chat-thread" : "sidebar-recent-session",
  });
  if (browser && triggerKind !== "markdown") {
    row.style.cssText = "position:fixed;left:20px;top:80px;width:200px;height:32px";
  }
  const trigger = Object.assign(document.createElement("a"), {
    className:
      triggerKind === "markdown" ? "markdown-session-link" : "sidebar-recent-session__link",
    href: browser ? "#synthetic-provider-session" : "#",
    textContent: browser ? "Synthetic provider session" : "Session",
  });
  (triggerKind === "markdown" ? trigger : row).dataset.sessionKey = sessionKey;
  row.append(trigger);
  // Browser triggers are scoped and use lookupSidebarRow; avoid mounting an unrelated native sidebar.
  if (!browser) {
    provider.append(sidebar);
  }
  (browser || triggerKind === "markdown" ? provider : sidebar).append(row);
  const reads = (method: string) =>
    request.mock.calls.filter(([called]) => called === method).length;
  return {
    provider,
    gateway,
    trigger,
    request,
    getReads: () => reads("progressCard.get"),
    getPullRequestReads: () => reads(SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD),
    async mount() {
      await rosterReady;
      await repository.ready;
      document.body.append(provider);
      await provider.updateComplete;
      flush();
    },
    async focus() {
      await rosterReady;
      await repository.ready;
      await provider.updateComplete;
      trigger.dispatchEvent(new FocusEvent("focusin", { bubbles: true, composed: true }));
    },
    select(agentId: string) {
      selectedId = agentId;
      selection.emit(context.agentSelection.state);
    },
    updateRow(details: Partial<SidebarSessionHovercardRow>) {
      rowDetails = { ...rowDetails, ...details };
      sessions.emit();
    },
    emitPullRequests(snapshot: ControlUiSessionPullRequestSnapshot) {
      emit("controlUi.sessionPullRequests.changed", { sessions: { [sessionKey]: snapshot } });
    },
    emitPullRequestStatus(status: "ready" | "rate-limited" | "unavailable") {
      emit("controlUi.sessionPullRequests.changed", {
        sessions: {
          [sessionKey]: { status, rateLimited: status === "rate-limited", pullRequests: [] },
        },
      });
    },
    emitProgressChange: (revision = 2) => emit("progressCard.changed", { sessionKey, revision }),
    async releaseProgress() {
      releaseProgress?.();
      await Promise.all(request.mock.results.map((result) => result.value));
    },
  };
}
