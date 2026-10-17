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
  { outcome: "error", pinned: true },
  { outcome: "retry", pinned: false },
] as const)(
  "removes an agent immediately and reconciles slow $outcome (pinned: $pinned)",
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
    let deletionSettled = false;
    let deleteRequests = 0;
    const hello = gatewayHelloForMethods([...SESSION_MUTATION_TEST_METHODS, "agents.delete"]);
    class DeletionSocket extends MockWebSocket {
      override send(data: string) {
        super.send(data);
        // SAFETY: The production client writes request envelopes into this socket fixture.
        const frame = JSON.parse(data) as { id: string; method: string };
        const respond = (payload: unknown) =>
          this.emitMessage({ type: "res", id: frame.id, ok: true, payload });
        if (frame.method === "agents.delete") {
          deleteRequests += 1;
          setTimeout(() => {
            deletionSettled = true;
            if (outcome === "success" || deleteRequests > 1) {
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
        if (frame.method === "agents.list" && deletionSettled) {
          setTimeout(() => respond(payload), 10_000);
        } else {
          queueMicrotask(() => respond(payload));
        }
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
    const deleteOption = (agent: string) =>
      sidebar.querySelector<HTMLElement>(
        `[role="menu"][aria-label="Options for ${agent}"] [data-value="delete"]`,
      );
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
    await vi.waitFor(() => expect(deleteOption("Research briefing 8")).not.toBeNull());
    deleteOption("Research briefing 8")!.click();
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
    expect(sidebar.querySelector('[data-agent-id="research"]')).toBeNull();
    expect(agentIds(sidebar)).toEqual(["main"]);
    // An unrelated roster refresh must not bring back the pending deletion.
    await agents.refreshList();
    await settleRoster(sidebar);
    expect(agentIds(sidebar)).toEqual(["main"]);
    const remainingOptions = sidebar.querySelector<HTMLButtonElement>(
      'button[aria-label="Options for Harbor"]',
    )!;
    remainingOptions.click();
    await vi.waitFor(() => expect(deleteOption("Harbor")).not.toBeNull());
    expect(deleteOption("Harbor")?.getAttribute("aria-disabled")).toBe("true");
    remainingOptions.click();
    await vi.advanceTimersByTimeAsync(67_048);
    expect(deleteRequests).toBe(1);
    if (outcome === "success") {
      await vi.waitFor(() =>
        expect(sidebar.querySelector('[data-agent-id="research"]')).toBeNull(),
      );
      expect(agentIds(sidebar)).toEqual(["main"]);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(sidebar.querySelector('[data-agent-id="research"]')).toBeNull();
    } else {
      await vi.waitFor(() =>
        expect(sidebar.querySelector('[data-agent-id="research"]')).not.toBeNull(),
      );
      expect(sidebar.querySelector('[data-pinned-agent="research"]') !== null).toBe(pinned);
      expect(agentIds(sidebar)).toEqual(pinned ? ["main"] : ["main", "research"]);
      sidebar
        .querySelector<HTMLButtonElement>('button[aria-label="Options for Research briefing 8"]')!
        .click();
      await vi.waitFor(() => expect(deleteOption("Research briefing 8")).not.toBeNull());
      expect(deleteOption("Research briefing 8")?.getAttribute("aria-disabled")).not.toBe("true");
      await vi.waitFor(() => expect(document.body.textContent).toContain("Agent cleanup failed"));
      if (outcome === "retry") {
        deleteOption("Research briefing 8")!.click();
        await vi.waitFor(() =>
          expect(document.querySelector("openclaw-modal-dialog")).not.toBeNull(),
        );
        [...document.querySelectorAll<HTMLButtonElement>("openclaw-modal-dialog button")]
          .find((button) => button.textContent === "Delete")!
          .click();
        await vi.advanceTimersByTimeAsync(0);
        await settleRoster(sidebar);
        expect(sidebar.querySelector('[data-agent-id="research"]')).toBeNull();
        // The failed attempt's refresh must not undo the newer pending deletion.
        await vi.advanceTimersByTimeAsync(10_000);
        expect(sidebar.querySelector('[data-agent-id="research"]')).toBeNull();
        await vi.advanceTimersByTimeAsync(67_048);
        expect(sidebar.querySelector('[data-agent-id="research"]')).toBeNull();
        expect(deleteRequests).toBe(2);
      } else {
        await vi.advanceTimersByTimeAsync(10_000);
        expect(sidebar.querySelector('[data-agent-id="research"]')).not.toBeNull();
      }
    }
  },
);
