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
  const parent = "agent:main:parent";
  const child = (agentId: string, spawnedBy: string): GatewaySessionRow => ({
    key: `agent:${agentId}:subagent:child`,
    agentId,
    sessionId: `${agentId}-child-session`,
    spawnedBy,
    kind: "direct",
    classification: "subagent",
    status: "done",
    sharingRole: "owner",
    label: `${agentId} task`,
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
      return {
        sessionId:
          values?.sessionKey === "agent:worker:subagent:child"
            ? "worker-child-session"
            : "main-child-session",
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
  const view = mountSolid(() => createComponent(ChatSubagentsPanel, { sessionKey: parent }), {
    wrapper: provider.wrapper,
  });
  const panel = view.container.querySelector<
    HTMLElementTagNameMap["openclaw-chat-subagents-panel"]
  >("openclaw-chat-subagents-panel")!;
  onTestFinished(() => {
    view.unmount();
    sessions.dispose();
    disposeSidebarContextLifecycles();
  });
  await waitForSolid(() => expect(panel.querySelector(".chat-subagents__open")).not.toBeNull());
  panel.querySelector<HTMLButtonElement>(".chat-subagents__open")!.click();
  await panel.updateComplete;
  const retained = panel.querySelector("openclaw-chat-pane")!;
  expect(retained.sessionKey).toBe("agent:main:subagent:child");

  panel.presented = false;
  await panel.updateComplete;
  expect(panel.querySelector("openclaw-chat-pane")).toBe(retained);
  panel.presented = true;
  await panel.updateComplete;
  await waitForSolid(() => expect(panel.querySelector("openclaw-chat-pane")).toBe(retained));

  panel.showRequest = () => "agent:worker:subagent:child";
  panel.sessionKey = "global";
  panel.agentId = "worker";
  await panel.updateComplete;
  await waitForSolid(() =>
    expect(panel.querySelector("openclaw-chat-pane")?.sessionKey).toBe(
      "agent:worker:subagent:child",
    ),
  );
  const detail = panel.querySelector("openclaw-chat-pane")!;
  expect(detail.agentId).toBe("worker");
  await waitForSolid(() =>
    expect(request.mock.calls.filter(([method]) => method === "sessions.list")).toContainEqual([
      "sessions.list",
      expect.objectContaining({ spawnedBy: "global", agentId: "worker" }),
    ]),
  );
  detail.onBackToSubagents?.();
  await panel.updateComplete;
  expect(panel.querySelector("openclaw-chat-pane")).toBeNull();
  panel.presented = false;
  await panel.updateComplete;
  panel.presented = true;
  await panel.updateComplete;
  await waitForSolid(() => expect(panel.querySelector(".chat-subagents__open")).not.toBeNull());
  expect(panel.querySelector("openclaw-chat-pane")).toBeNull();
});
