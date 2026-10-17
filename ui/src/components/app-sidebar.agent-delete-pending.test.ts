/* @vitest-environment jsdom */
import { expect, it, onTestFinished, vi } from "vitest";
import {
  MockWebSocket,
  getLatestWebSocket,
  useNodeFakeTimers,
} from "../api/gateway-socket.test-support.ts";
import { GatewayBrowserClient } from "../api/gateway.ts";
import type { AgentsListResult, SessionsListResult } from "../api/types.ts";
import { createAgentCapability } from "../lib/agents/index.ts";
import "../test-helpers/app-sidebar-suite.ts";
import "../lib/toast-host.ts";
import { agentIds, settleRoster } from "../test-helpers/app-sidebar-cases/roster.test-support.ts";
import {
  createContext,
  createGatewayHarness,
  createSessions,
  mountSidebarContext,
} from "../test-helpers/app-sidebar.ts";
import {
  gatewayHelloForMethods,
  SESSION_MUTATION_TEST_METHODS,
} from "../test-helpers/gateway-methods.ts";

it.each([
  { outcome: "success", pinned: false },
  { outcome: "error", pinned: false },
  { outcome: "success", pinned: true },
] as const)(
  "shows pending deletion until a slow request finishes with $outcome (pinned: $pinned)",
  async ({ outcome, pinned }) => {
    useNodeFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    });
    let agentsList: AgentsListResult = {
      defaultId: "main",
      mainKey: "main",
      scope: "per-sender",
      agents: [
        { id: "main", name: "Harbor" },
        { id: "research", name: "Research briefing 8" },
      ],
    };
    const sessionsList: SessionsListResult = {
      ts: 1,
      path: "",
      count: 0,
      sessions: [],
      defaults: { model: null, modelProvider: null, contextTokens: null },
    };
    const hello = gatewayHelloForMethods([...SESSION_MUTATION_TEST_METHODS, "agents.delete"]);
    class DeletionSocket extends MockWebSocket {
      override send(data: string) {
        super.send(data);
        // SAFETY: The production client writes request envelopes into this socket fixture.
        const frame = JSON.parse(data) as { id: string; method: string };
        const respond = (payload: unknown) =>
          this.emitMessage({ type: "res", id: frame.id, ok: true, payload });
        if (frame.method === "agents.delete") {
          setTimeout(() => {
            if (outcome === "success") {
              agentsList = { ...agentsList, agents: [{ id: "main", name: "Harbor" }] };
              respond({ ok: true, agentId: "research", removedBindings: 0 });
            } else {
              this.emitMessage({
                type: "res",
                id: frame.id,
                ok: false,
                error: { code: "UNAVAILABLE", message: "Agent cleanup failed" },
              });
            }
          }, 67_048);
          return;
        }
        const payload =
          frame.method === "connect"
            ? { ...hello, type: "hello-ok", protocol: 4, policy: { tickIntervalMs: 120_000 } }
            : frame.method === "agents.list"
              ? structuredClone(agentsList)
              : frame.method === "sessions.list"
                ? sessionsList
                : frame.method === "sessions.subscribe"
                  ? { subscribed: true }
                  : {};
        queueMicrotask(() => respond(payload));
      }
    }
    vi.stubGlobal("WebSocket", DeletionSocket);
    let sequence = 0;
    vi.stubGlobal("crypto", { randomUUID: () => `request-${++sequence}` });
    const client = new GatewayBrowserClient({ url: "ws://127.0.0.1:18789" });
    onTestFinished(() => client.stop());
    client.start();
    const socket = getLatestWebSocket();
    socket.emitOpen();
    socket.emitMessage({
      type: "event",
      event: "connect.challenge",
      payload: { nonce: "deletion-test", ts: 1 },
    });
    await vi.advanceTimersByTimeAsync(1_000);
    const gatewayHarness = createGatewayHarness(client);
    gatewayHarness.publish({
      hello: gatewayHelloForMethods([...SESSION_MUTATION_TEST_METHODS, "agents.delete"]),
    });
    const agents = createAgentCapability(gatewayHarness.gateway);
    onTestFinished(() => agents.dispose());
    await agents.ensureList();
    const context = {
      ...createContext(gatewayHarness.gateway, createSessions("main", []), agentsList),
      agents,
    };
    context.navigation.update({ pinnedAgentIds: pinned ? ["research"] : [] });
    const { sidebar } = await mountSidebarContext(context);
    document.body.append(document.createElement("openclaw-toast-host"));
    sidebar.connected = true;
    sidebar.sidebarAgentsMode = "roster";
    await vi.waitFor(() =>
      expect(sidebar.querySelector('[data-agent-id="research"]')).not.toBeNull(),
    );
    await settleRoster(sidebar);
    sidebar
      .querySelector<HTMLButtonElement>('button[aria-label="Options for Research briefing 8"]')!
      .click();
    await vi.waitFor(() => expect(sidebar.querySelector('[data-value="delete"]')).not.toBeNull());
    sidebar.querySelector<HTMLElement>('[data-value="delete"]')!.click();
    await vi.waitFor(() =>
      expect(document.querySelector("openclaw-modal-dialog")?.textContent).toContain(
        "Delete Research briefing 8?",
      ),
    );
    const confirm = [
      ...document.querySelectorAll<HTMLButtonElement>("openclaw-modal-dialog button"),
    ].find((button) => button.textContent === "Delete")!;
    confirm.click();
    await vi.advanceTimersByTimeAsync(0);
    await settleRoster(sidebar);
    const deletingRow = sidebar.querySelector<HTMLElement>(
      pinned ? '[data-pinned-agent="research"]' : '[data-agent-group="research"]',
    )!;
    expect(deletingRow.textContent).toContain("Deleting");
    expect(deletingRow.getAttribute("aria-busy")).toBe("true");
    deletingRow
      .querySelector<HTMLButtonElement>('button[aria-label="Options for Research briefing 8"]')!
      .click();
    await vi.waitFor(() => expect(sidebar.querySelector('[data-value="delete"]')).not.toBeNull());
    expect(sidebar.querySelector('[data-value="delete"]')?.getAttribute("aria-disabled")).toBe(
      "true",
    );
    sidebar.querySelector<HTMLElement>('[data-value="delete"]')!.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(document.querySelector("openclaw-modal-dialog")).toBeNull();
    await vi.advanceTimersByTimeAsync(67_048);
    if (outcome === "success") {
      await vi.waitFor(() =>
        expect(sidebar.querySelector('[data-agent-id="research"]')).toBeNull(),
      );
      expect(agentIds(sidebar)).toEqual(["main"]);
    } else {
      await vi.waitFor(() => expect(deletingRow.hasAttribute("aria-busy")).toBe(false));
      expect(agentIds(sidebar)).toEqual(["main", "research"]);
      expect(deletingRow.textContent).not.toContain("Deleting");
      expect(
        sidebar.querySelector('[data-value="delete"]')?.getAttribute("aria-disabled"),
      ).not.toBe("true");
      await vi.waitFor(() => expect(document.body.textContent).toContain("Agent cleanup failed"));
    }
  },
);
