import type { ProgressCard } from "@openclaw/gateway-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApplicationContext } from "../app/context.ts";
import type { ApplicationGateway } from "../app/gateway.ts";
import { SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD } from "../lib/session-pull-requests.ts";
import { flush, waitForSolid } from "../test-helpers/solid-settle.ts";
import type { SessionProgressHovercardProvider } from "./session-progress-hovercard.runtime.tsx";
import "./session-progress-hovercard.runtime.tsx";

const key = "agent:research:provider-probe";
const buildHref = "https://example.com/build";
const mountedProviders: HTMLElement[] = [];

function fixture(initialCard: ProgressCard | null) {
  let card = initialCard;
  const eventListeners = new Set<Parameters<ApplicationGateway["subscribeEvents"]>[0]>();
  const request = vi.fn(async (method: string) => {
    if (method === "progressCard.get") {
      return { card };
    }
    if (method === SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD) {
      return { sessions: {} };
    }
    throw new Error(`Unexpected synthetic method: ${method}`);
  });
  // SAFETY: The fixture implements the gateway surfaces consumed by this provider.
  const gateway = {
    snapshot: {
      phase: "connected",
      assistantAgentId: "research",
      client: { request },
      hello: {
        auth: { role: "operator", scopes: ["operator.read"] },
        features: { methods: ["progressCard.get", SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD] },
      },
    },
    connection: { token: "", password: "" },
    subscribe: () => () => undefined,
    subscribeEvents: (listener: Parameters<ApplicationGateway["subscribeEvents"]>[0]) => {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
  } as unknown as ApplicationGateway;
  // SAFETY: The provider only reads the gateway and these two subscription owners.
  const context = {
    gateway,
    basePath: "",
    sessions: { subscribe: () => () => undefined },
    agentSelection: {
      state: { selectedId: "research", scopeId: "research" },
      subscribe: () => () => undefined,
    },
  } as unknown as ApplicationContext;
  // SAFETY: Importing the bridge above registers this tag with these properties.
  const provider = document.createElement(
    "openclaw-session-progress-hovercard-provider",
  ) as SessionProgressHovercardProvider;
  provider.context = context;
  provider.gateway = gateway;
  const sidebar = Object.assign(document.createElement("openclaw-app-sidebar"), {
    expandedAgentId: () => "research",
    findSidebarHovercardRowByKey: () => ({
      key,
      agentId: "research",
      label: "Synthetic provider session",
      kind: "direct",
      lastMessagePreview: "Synthetic latest turn",
    }),
  });
  const row = document.createElement("div");
  row.className = "sidebar-recent-session";
  row.dataset.sessionKey = key;
  row.style.cssText = "position:fixed;left:20px;top:80px;width:200px;height:32px";
  const trigger = document.createElement("a");
  trigger.className = "sidebar-recent-session__link";
  trigger.href = "#synthetic-provider-session";
  trigger.textContent = "Synthetic provider session";
  row.append(trigger);
  sidebar.append(row);
  provider.append(sidebar);
  const getReads = () =>
    request.mock.calls.filter(([method]) => method === "progressCard.get").length;
  return {
    gateway,
    provider,
    row,
    trigger,
    getReads,
    async mount() {
      document.body.append(provider);
      mountedProviders.push(provider);
      await provider.updateComplete;
      flush();
    },
    change(next: ProgressCard) {
      card = next;
      for (const listener of eventListeners) {
        listener({
          type: "event",
          event: "progressCard.changed",
          payload: { sessionKey: key, revision: next.revision },
        });
      }
    },
  };
}

async function drainTurn() {
  await vi.advanceTimersByTimeAsync(0);
  flush();
}

function portal() {
  return document.querySelector<HTMLDivElement>(".session-progress-hovercard");
}

function progress(revision: number, markdown: string): ProgressCard {
  return { sessionKey: key, revision, updatedAt: revision, markdown };
}

afterEach(async () => {
  for (const provider of mountedProviders.splice(0)) {
    provider.remove();
  }
  await Promise.resolve();
  flush();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("progress hovercard provider boundary", () => {
  it("keeps caller-owned children connected when the passive provider mounts", async () => {
    let connections = 0;
    let disconnections = 0;
    class ConnectionProbe extends HTMLElement {
      connectedCallback() {
        connections += 1;
      }
      disconnectedCallback() {
        disconnections += 1;
      }
    }
    customElements.define("openclaw-progress-provider-connection-probe", ConnectionProbe);
    const h = fixture(progress(1, "Synthetic progress"));
    const child = document.createElement("openclaw-progress-provider-connection-probe");
    h.provider.append(child);
    await h.mount();
    expect(connections).toBe(1);
    expect(disconnections).toBe(0);
    expect(child.parentElement).toBe(h.provider);
  });

  it("enters by Tab, retains the focused progress href on refresh, and returns focus when removed", async () => {
    const { userEvent } = await import("vitest/browser");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const h = fixture(progress(1, `[Open build log](${buildHref})`));
    await h.mount();
    h.trigger.focus();
    await drainTurn();
    await waitForSolid(() =>
      expect(portal()?.querySelector(`a[href="${buildHref}"]`)).not.toBeNull(),
    );
    expect(h.getReads()).toBe(1);
    const heldPortal = portal();
    expect(document.activeElement).toBe(h.trigger);
    await userEvent.keyboard("{Tab}");
    await drainTurn();
    expect(document.activeElement?.getAttribute("href")).toBe(buildHref);

    // Observe outcomes after the normal full commit; do not invoke or reorder afterCommit.
    h.change(progress(2, `Updated build: [Open build log](${buildHref})`));
    await drainTurn();
    await waitForSolid(() => expect(portal()?.textContent).toContain("Updated build:"));
    expect(portal()).toBe(heldPortal);
    expect(document.activeElement?.getAttribute("href")).toBe(buildHref);
    expect(h.getReads()).toBe(2);

    h.change(progress(3, "Updated build complete"));
    await drainTurn();
    await waitForSolid(() => expect(portal()?.textContent).toContain("Updated build complete"));
    expect(portal()).toBe(heldPortal);
    expect(document.activeElement).toBe(h.trigger);
    expect(h.getReads()).toBe(3);
    await userEvent.keyboard("{Escape}");
    expect(portal()).toBeNull();
    expect(h.trigger.hasAttribute("aria-controls")).toBe(false);
  });
});
