import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { onTestFinished, vi } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import { createApplicationConfigCapability } from "../../app/config.ts";
import { createApplicationPlacementStartup } from "../../app/session-placement-startup.ts";
import { createRuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import { sessionsResult } from "../../lib/sessions/session-capability.test-support.ts";
import {
  createTestGatewayClient,
  type GatewayRequestHandler,
} from "../../test-helpers/gateway-client.ts";
import { loadChatHistory } from "./chat-history.ts";
import { ChatPaneRuntime } from "./chat-pane-render.ts";
import {
  createTestChatPane,
  createPaneTestHost,
  type TestChatPane,
} from "./chat-pane.test-support.ts";
import { refreshPageChat } from "./chat-state-refresh.ts";

export function createMountedPanes(
  rows: GatewaySessionRow[],
  agentId = "main",
  readBarrier?: Promise<void>,
  responses?: Partial<
    Record<
      | "chat.history"
      | "chat.startup"
      | "models.authStatus"
      | "models.list"
      | "sessions.describe"
      | "sessions.list"
      | "sessions.patch"
      | "environments.status",
      GatewayRequestHandler
    >
  >,
) {
  const client = createTestGatewayClient(async (method, raw, requestOptions) => {
    if (
      method === "chat.history" ||
      method === "chat.startup" ||
      method === "models.authStatus" ||
      method === "models.list" ||
      method === "sessions.describe" ||
      method === "sessions.list" ||
      method === "sessions.patch" ||
      method === "environments.status"
    ) {
      const response = responses?.[method];
      if (response) {
        return response(method, raw, requestOptions);
      }
    }
    const params = asOptionalRecord(raw);
    const row = rows.find(
      (entry) =>
        entry.key === (params?.sessionKey ?? params?.key) &&
        (!params?.agentId || entry.agentId === params.agentId),
    );
    if (method === "users.list") {
      return { profiles: [] };
    }
    if (method === "models.list") {
      return { models: [] };
    }
    if (method === "agents.list") {
      return { defaultId: "main", mainKey: "main", agents: [{ id: "main" }, { id: "research" }] };
    }
    if (method === "agent.identity.get") {
      return { agentId: params?.agentId, name: "Assistant" };
    }
    if (method === "sessions.list") {
      await readBarrier;
      return sessionsResult(
        rows.filter((entry) => entry.agentId === "main"),
        1,
      );
    }
    if (method === "sessions.subscribe") {
      return { subscribed: true };
    }
    if (method === "sessions.describe") {
      await readBarrier;
      return { session: row ?? null };
    }
    if (method === "chat.history" || method === "chat.startup") {
      await readBarrier;
      return { messages: [], sessionInfo: row, sessionId: row?.sessionId };
    }
    return {};
  });
  const fixture = createTestChatPane({ client });
  const context = fixture.pane.context;
  const runtimeConfig = createRuntimeConfigCapability(context.gateway);
  const placementStartup = createApplicationPlacementStartup(context);
  Object.assign(context, {
    config: createApplicationConfigCapability({ resourceBasePath: "" }),
    runtimeConfig,
    placementStartup,
  });
  const panes: TestChatPane[] = [];
  const mount = (sessionKey: string, paneAgentId = agentId) => {
    const pane =
      panes.length === 0
        ? fixture.pane
        : (createPaneTestHost(
            "openclaw-chat-runtime-test",
            ChatPaneRuntime,
          ) as unknown as TestChatPane);
    // Configure the detached owner before the view starts its connection lifecycle.
    Object.defineProperty(pane, "isConnected", { configurable: true, value: false });
    pane.context = context;
    pane.sessionKey = sessionKey;
    // Composer and transcript state belongs to each mounted presentation.
    pane.presentationId = crypto.randomUUID();
    Object.assign(pane, { agentId: paneAgentId });
    panes.push(pane);
    Reflect.set(pane, "state", undefined);
    pane.connectedCallback();
    return pane;
  };
  onTestFinished(async () => {
    for (const pane of panes) {
      pane.disconnectedCallback();
    }
    runtimeConfig.dispose();
    placementStartup.dispose();
    await vi.dynamicImportSettled();
  });
  return { ...fixture, context, mount };
}

export function refreshPane(pane: TestChatPane) {
  return refreshPageChat(pane.state, {
    historyLoad: loadChatHistory(pane.state, { deferBranches: true }),
    awaitHistory: true,
    scheduleScroll: false,
  });
}
