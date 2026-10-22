/* @vitest-environment jsdom */
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { createComponent } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import type { GatewaySessionRow } from "../../../api/types.ts";
import {
  createTestSessionCapability,
  sessionsResult,
} from "../../../lib/sessions/session-capability.test-support.ts";
import { disposeSidebarContextLifecycles } from "../../../test-helpers/app-sidebar-context-lifecycle.ts";
import { createContext, createGatewayHarness } from "../../../test-helpers/app-sidebar.ts";
import { createTestGatewayClient } from "../../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../../test-helpers/gateway-methods.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../../test-helpers/solid-application-context.tsx";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { ChatSubagentsPanel } from "./chat-subagents-panel.tsx";

it("retains detail while hidden and applies a show request after its complete scope change", async () => {
  const key = (agentId: string) => `agent:${agentId}:subagent:child`;
  const child = (agentId: string, spawnedBy: string): GatewaySessionRow => ({
    key: key(agentId),
    agentId,
    sessionId: `${agentId}-child-session`,
    spawnedBy,
    kind: "direct",
    classification: "subagent",
    status: "done",
    sharingRole: "owner",
    updatedAt: 1,
  });
  const request = vi.fn((method: string, params?: unknown): unknown => {
    const values = asOptionalRecord(params);
    if (method === "sessions.list") {
      const rows =
        typeof values?.spawnedBy === "string"
          ? [child(values.agentId === "worker" ? "worker" : "main", values.spawnedBy)]
          : [];
      return { ...sessionsResult(rows, 1), hasMore: false, nextOffset: null };
    }
    if (method === "chat.history") {
      const agentId = values?.sessionKey === key("worker") ? "worker" : "main";
      return {
        sessionId: `${agentId}-child-session`,
        messages: [],
        hasMore: false,
        totalMessages: 0,
      };
    }
    if (method === "sessions.subscribe" || method === "sessions.unsubscribe") {
      return {};
    }
    throw new Error(`Unexpected method: ${method}`);
  });
  const connection = createGatewayHarness(createTestGatewayClient(request));
  connection.publish({
    hello: gatewayHelloForMethods([
      "sessions.list",
      "sessions.subscribe",
      "sessions.unsubscribe",
      "chat.history",
    ]),
  });
  const sessions = createTestSessionCapability(connection.gateway);
  const provider = createSolidApplicationContextProvider(
    createContext(connection.gateway, sessions),
  );
  const view = mountSolid(
    () => createComponent(ChatSubagentsPanel, { sessionKey: "agent:main:parent" }),
    { wrapper: provider.wrapper },
  );
  const panel = view.container.querySelector<
    HTMLElementTagNameMap["openclaw-chat-subagents-panel"]
  >("openclaw-chat-subagents-panel")!;
  const pane = () => panel.querySelector("openclaw-chat-pane");
  const setPresented = async (presented: boolean) => {
    panel.presented = presented;
    await panel.updateComplete;
  };
  onTestFinished(() => {
    view.unmount();
    sessions.dispose();
    disposeSidebarContextLifecycles();
  });
  await waitForSolid(() => expect(panel.querySelector(".chat-subagents__open")).not.toBeNull());
  panel.querySelector<HTMLButtonElement>(".chat-subagents__open")!.click();
  await panel.updateComplete;
  const retained = pane()!;
  expect(retained.sessionKey).toBe(key("main"));

  await setPresented(false);
  expect(pane()).toBe(retained);
  await setPresented(true);
  await waitForSolid(() => expect(pane()).toBe(retained));

  panel.showRequest = () => key("worker");
  panel.sessionKey = "global";
  panel.agentId = "worker";
  await panel.updateComplete;
  await waitForSolid(() => expect(pane()).toMatchObject({ sessionKey: key("worker") }));
  expect(pane()).toMatchObject({ agentId: "worker" });
  await waitForSolid(() =>
    expect(request).toHaveBeenCalledWith(
      "sessions.list",
      expect.objectContaining({ spawnedBy: "global", agentId: "worker" }),
    ),
  );
  pane()!.onBackToSubagents?.();
  await panel.updateComplete;
  expect(pane()).toBeNull();
  await setPresented(false);
  await setPresented(true);
  await waitForSolid(() => expect(panel.querySelector(".chat-subagents__open")).not.toBeNull());
  expect(pane()).toBeNull();
});
