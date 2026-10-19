import type { ProgressCard } from "@openclaw/gateway-protocol";
import { vi } from "vitest";
import type { ApplicationContext } from "../app/context.ts";
import type { ApplicationGateway } from "../app/gateway.ts";
import { SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD } from "../lib/session-pull-requests.ts";
import { flush } from "../test-helpers/solid-settle.ts";
import type { SidebarSessionHovercardRow } from "./app-sidebar-session-types.ts";
import type { SessionProgressHovercardProvider } from "./session-progress-hovercard.runtime.tsx";
import "./session-progress-hovercard.runtime.tsx";

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
  card: initialCard,
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
  let selectedId = "research";
  let card = initialCard;
  let rowDetails = initialRowDetails;
  let releaseProgress: (() => void) | undefined;
  const selection = subscriptions<ApplicationContext["agentSelection"]["state"]>();
  const sessions = subscriptions<void>();
  const events =
    subscriptions<Parameters<Parameters<ApplicationGateway["subscribeEvents"]>[0]>[0]>();
  const emit = (event: string, payload: unknown) => events.emit({ type: "event", event, payload });
  const request = vi.fn(
    async (method: string, params: { sessionKey?: string; agentId?: string }) => {
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
      return {
        card: {
          sessionKey: params.sessionKey?.startsWith("agent:")
            ? params.sessionKey
            : `agent:${params.agentId}:${params.sessionKey}`,
          revision: 1,
          updatedAt: 1,
          markdown: `${owner} progress`,
        },
      };
    },
  );
  // These fixtures implement only the gateway/context surfaces consumed by the provider.
  const gateway = {
    snapshot: {
      phase: "connected",
      assistantAgentId: browser ? "research" : "main",
      client: { request },
      hello: {
        auth: { role: "operator", scopes: ["operator.read"] },
        features: { methods: ["progressCard.get", SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD] },
      },
    },
    connection: { token: "", password: "" },
    subscribe: () => () => undefined,
    subscribeEvents: events.subscribe,
  } as unknown as ApplicationGateway;
  const context = {
    gateway,
    basePath: "",
    sessions: { subscribe: browser ? () => () => undefined : sessions.subscribe },
    agentSelection: {
      get state() {
        return { selectedId, scopeId: selectedId };
      },
      subscribe: selection.subscribe,
    },
  } as unknown as ApplicationContext;
  if (browser) {
    Object.assign(context, {
      agents: {
        state: {
          agentsList: {
            agents: [{ id: "research" }],
            defaultId: "research",
            mainKey: "main",
          },
        },
      },
    });
    Object.assign(context.sessions, {
      state: {
        result: {
          sessions: [{ key: sessionKey, displayName: "Synthetic provider session" }],
        },
      },
    });
  }
  const provider = document.createElement(
    "openclaw-session-progress-hovercard-provider",
  ) as SessionProgressHovercardProvider;
  Object.assign(provider, { context, gateway });
  const sidebar = Object.assign(document.createElement("openclaw-app-sidebar"), {
    expandedAgentId: () => (browser ? "research" : selectedId),
    findSidebarHovercardRowByKey: () => ({
      key: sessionKey,
      agentId: browser ? "research" : selectedId,
      label: browser ? "Synthetic provider session" : `${selectedId} session`,
      kind: "direct",
      ...(browser ? { lastMessagePreview: "Synthetic latest turn" } : {}),
      ...rowDetails,
    }),
  });
  sidebar.hidden = browser; // A registered real sidebar must not render in the browser fixture.
  const row = Object.assign(document.createElement("div"), { className: "sidebar-recent-session" });
  row.dataset.sessionKey = sessionKey;
  if (browser) {
    row.style.cssText = "position:fixed;left:20px;top:80px;width:200px;height:32px";
  }
  const trigger = Object.assign(document.createElement("a"), {
    className:
      triggerKind === "markdown" ? "markdown-session-link" : "sidebar-recent-session__link",
    href: browser ? "#synthetic-provider-session" : "#",
    textContent: browser ? "Synthetic provider session" : "Session",
  });
  if (triggerKind === "markdown") {
    trigger.dataset.sessionKey = sessionKey;
    const thread = Object.assign(document.createElement("div"), { className: "chat-thread" });
    thread.append(trigger);
    provider.append(sidebar, thread);
  } else {
    row.append(trigger);
    if (browser) {
      provider.append(sidebar, row);
    } else {
      sidebar.append(row);
      provider.append(sidebar);
    }
  }
  const emitProgressChange = (revision = 2) =>
    emit("progressCard.changed", { sessionKey, revision });
  const reads = (method: string) =>
    request.mock.calls.filter(([called]) => called === method).length;
  return {
    provider,
    gateway,
    row,
    trigger,
    request,
    getReads: () => reads("progressCard.get"),
    getPullRequestReads: () => reads(SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD),
    async mount() {
      document.body.append(provider);
      await provider.updateComplete;
      flush();
    },
    async focus() {
      await provider.updateComplete;
      trigger.dispatchEvent(new FocusEvent("focusin", { bubbles: true, composed: true }));
    },
    select(agentId: string) {
      selectedId = agentId;
      selection.emit(context.agentSelection.state);
    },
    change(next: ProgressCard) {
      card = next;
      emitProgressChange(next.revision);
    },
    updateRow(details: Partial<SidebarSessionHovercardRow>) {
      rowDetails = { ...rowDetails, ...details };
      sessions.emit();
    },
    emitPullRequestStatus(status: "ready" | "rate-limited" | "unavailable") {
      emit("controlUi.sessionPullRequests.changed", {
        sessions: {
          [sessionKey]: { status, rateLimited: status === "rate-limited", pullRequests: [] },
        },
      });
    },
    emitProgressChange,
    async releaseProgress() {
      releaseProgress?.();
      await Promise.all(request.mock.results.map((result) => result.value));
    },
  };
}
