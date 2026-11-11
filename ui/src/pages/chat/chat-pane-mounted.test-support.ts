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
import { createTestChatPane, createPaneTestHost } from "./chat-pane.test-support.ts";
import { refreshPageChat } from "./chat-state-refresh.ts";

const responseMethods = [
  "chat.history",
  "chat.send",
  "chat.startup",
  "models.authStatus",
  "models.list",
  "sessions.describe",
  "sessions.list",
  "sessions.patch",
  "environments.status",
] as const;

export function createMountedPanes(
  rows: GatewaySessionRow[],
  agentId = "main",
  readBarrier?: Promise<void>,
  responses?: Partial<Record<(typeof responseMethods)[number], GatewayRequestHandler>>,
) {
  const client = createTestGatewayClient(async (method, raw, requestOptions) => {
    const key = responseMethods.find((candidate) => candidate === method);
    const response = key && responses?.[key];
    if (response) {
      return response(method, raw, requestOptions);
    }
    const params = asOptionalRecord(raw);
    const row = rows.find(
      (entry) =>
        entry.key === (params?.sessionKey ?? params?.key) &&
        (!params?.agentId || entry.agentId === params.agentId),
    );
    switch (method) {
      case "users.list":
        return { profiles: [] };
      case "models.list":
        return { models: [] };
      case "agents.list":
        return { defaultId: "main", mainKey: "main", agents: [{ id: "main" }, { id: "research" }] };
      case "agent.identity.get":
        return { agentId: params?.agentId, name: "Assistant" };
      case "sessions.subscribe":
        return { subscribed: true };
      case "sessions.list":
        await readBarrier;
        return sessionsResult(
          rows.filter((entry) => entry.agentId === "main"),
          1,
        );
      case "sessions.describe":
        await readBarrier;
        return { session: row ?? null };
      case "chat.history":
      case "chat.startup":
        await readBarrier;
        return { messages: [], sessionInfo: row, sessionId: row?.sessionId };
      default:
        return {};
    }
  });
  const fixture = createTestChatPane({ client });
  const context = fixture.pane.context;
  const { runtimeConfig, placementStartup } = Object.assign(context, {
    config: createApplicationConfigCapability({ resourceBasePath: "" }),
    runtimeConfig: createRuntimeConfigCapability(context.gateway),
    placementStartup: createApplicationPlacementStartup(context),
  });
  const panes: (typeof fixture.pane)[] = [];
  const mount = (sessionKey: string, paneAgentId = agentId) => {
    const pane = (panes.length === 0
      ? fixture.pane
      : createPaneTestHost(
          "openclaw-chat-runtime-test",
          ChatPaneRuntime,
        )) as unknown as typeof fixture.pane;
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
    panes.forEach((pane) => pane.disconnectedCallback());
    runtimeConfig.dispose();
    placementStartup.dispose();
    await vi.dynamicImportSettled();
  });
  return { ...fixture, context, mount };
}

export function refreshPane(pane: ReturnType<typeof createTestChatPane>["pane"]) {
  return refreshPageChat(pane.state, {
    historyLoad: loadChatHistory(pane.state, { deferBranches: true }),
    awaitHistory: true,
    scheduleScroll: false,
  });
}
