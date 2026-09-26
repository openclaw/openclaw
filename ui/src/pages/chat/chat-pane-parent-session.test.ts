/* @vitest-environment jsdom */

import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import { sessionsResult } from "../../lib/sessions/session-capability.test-support.ts";
import { createMountedPanes, refreshPane } from "./chat-pane-mounted.test-support.ts";
import type { TestChatPane } from "./chat-pane.test-support.ts";
import { selectedChatSessionRow } from "./chat-state-route.ts";
import { createBackgroundTasksProps } from "./components/chat-background-tasks.ts";
import { createSessionWorkspaceProps } from "./components/chat-session-workspace.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";

beforeEach(installTranscriptDomMocks);
afterEach(resetTranscriptTestDom);

function parentBreadcrumb(pane: TestChatPane) {
  const container = document.createElement("div");
  render(
    pane.renderPaneHeader(
      createSessionWorkspaceProps(pane.state),
      createBackgroundTasksProps(pane.state),
      selectedChatSessionRow(pane.state),
      false,
      undefined,
      false,
      null,
    ),
    container,
  );
  return container.querySelector<HTMLButtonElement>(".chat-pane__parent-session");
}

describe("mounted pane parent session", () => {
  it.each([false, true])(
    "keeps the parent breadcrumb across roster refresh (incognito: %s)",
    async (incognito) => {
      const parent: GatewaySessionRow = {
        key: `agent:main:dashboard:${incognito ? "incognito-" : ""}parent`,
        agentId: "main",
        sessionId: "parent",
        kind: "direct",
        updatedAt: 1,
        displayName: "Release prep — café 雪",
        incognito: incognito || undefined,
      };
      const child: GatewaySessionRow = {
        ...parent,
        key: `agent:main:dashboard:${incognito ? "incognito-" : ""}child`,
        sessionId: "child",
        displayName: "Implementation",
        parentSessionKey: parent.key,
      };
      const { sessions, mount, emitGatewayEvent } = createMountedPanes(
        [parent, child],
        "main",
        undefined,
        {
          "sessions.list": async () => sessionsResult(incognito ? [] : [parent, child], 1),
        },
      );
      await sessions.refresh({ agentId: "main", force: true });
      const pane = mount(child.key);
      await refreshPane(pane);
      await vi.dynamicImportSettled();
      pane.paneId = "pane-child";
      pane.onPaneSessionChange = vi.fn();
      const draw = () => parentBreadcrumb(pane);
      expect(draw()?.textContent).toContain(parent.displayName);
      await sessions.refresh({ agentId: "main", force: true });
      await refreshPane(pane);
      expect(draw()?.textContent).toContain(parent.displayName);
      draw()?.click();
      expect(pane.onPaneSessionChange).toHaveBeenCalledExactlyOnceWith("pane-child", parent.key);
      if (incognito) {
        expect(sessions.state.result?.sessions.some((row) => row.key === parent.key)).toBe(false);
        expect(pane.state.sessionsResult?.sessions.some((row) => row.key === parent.key)).toBe(
          false,
        );
      }
      emitGatewayEvent("sessions.changed", {
        sessionKey: parent.key,
        agentId: "main",
        sessionId: parent.sessionId,
        reason: "update",
        session: { ...parent, updatedAt: 2, displayName: "Renamed parent" },
      });
      expect(draw()?.textContent).toContain("Renamed parent");
      emitGatewayEvent("sessions.changed", {
        sessionKey: parent.key,
        agentId: "main",
        sessionId: parent.sessionId,
        reason: "delete",
      });
      expect(draw()).toBeNull();
    },
  );

  it("ignores a late parent descriptor after the child lineage changes", async () => {
    const parent: GatewaySessionRow = {
      key: "agent:main:parent",
      agentId: "main",
      sessionId: "parent",
      kind: "direct",
      updatedAt: 1,
      displayName: "Old parent",
    };
    const replacement: GatewaySessionRow = {
      ...parent,
      key: "agent:main:replacement",
      sessionId: "replacement",
      displayName: "Current parent",
    };
    const child: GatewaySessionRow = {
      ...parent,
      key: "agent:main:child",
      sessionId: "child",
      displayName: "Child",
      parentSessionKey: parent.key,
    };
    const oldParent = createDeferred<{ session: GatewaySessionRow }>();
    const parentRequested = createDeferred();
    const { sessions, mount, emitGatewayEvent } = createMountedPanes([child], "main", undefined, {
      "sessions.describe": async (_method, raw) => {
        const key = asOptionalRecord(raw)?.key;
        if (key === parent.key) {
          parentRequested.resolve();
          return oldParent.promise;
        }
        return { session: key === replacement.key ? replacement : child };
      },
    });
    await sessions.refresh({ agentId: "main", force: true });
    const pane = mount(child.key);
    await refreshPane(pane);
    await parentRequested.promise;
    emitGatewayEvent("sessions.changed", {
      sessionKey: child.key,
      agentId: "main",
      sessionId: child.sessionId,
      reason: "update",
      session: { ...child, updatedAt: 2, parentSessionKey: replacement.key },
    });
    oldParent.resolve({ session: parent });
    await vi.dynamicImportSettled();
    expect(parentBreadcrumb(pane)?.textContent).toContain("Current parent");
    expect(parentBreadcrumb(pane)?.textContent).not.toContain("Old parent");
  });

  it("recovers a failed parent descriptor on the next roster refresh", async () => {
    const parent: GatewaySessionRow = {
      key: "agent:main:dashboard:incognito-parent",
      agentId: "main",
      sessionId: "parent",
      kind: "direct",
      updatedAt: 1,
      displayName: "Recovered parent",
      incognito: true,
    };
    const child: GatewaySessionRow = {
      ...parent,
      key: "agent:main:dashboard:incognito-child",
      sessionId: "child",
      displayName: "Child",
      parentSessionKey: parent.key,
    };
    const firstParent = createDeferred<{ session: GatewaySessionRow }>();
    const parentRequested = createDeferred();
    let parentReads = 0;
    const { sessions, mount } = createMountedPanes([child], "main", undefined, {
      "sessions.describe": async (_method, raw) => {
        if (asOptionalRecord(raw)?.key === parent.key) {
          parentReads += 1;
          if (parentReads === 1) {
            parentRequested.resolve();
            return firstParent.promise;
          }
          return { session: parent };
        }
        return { session: child };
      },
    });
    await sessions.refresh({ agentId: "main", force: true });
    const pane = mount(child.key);
    await refreshPane(pane);
    await parentRequested.promise;
    firstParent.reject(new Error("Temporary descriptor outage"));
    await vi.dynamicImportSettled();
    expect(parentBreadcrumb(pane)).toBeNull();
    expect(parentReads).toBe(1);

    await sessions.refresh({ agentId: "main", force: true });
    await refreshPane(pane);
    await vi.dynamicImportSettled();
    expect(parentBreadcrumb(pane)?.textContent).toContain("Recovered parent");
    expect(parentReads).toBe(2);
  });
});
