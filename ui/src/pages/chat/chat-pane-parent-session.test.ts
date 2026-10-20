/* @vitest-environment jsdom */

import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import { sessionsResult } from "../../lib/sessions/session-capability.test-support.ts";
import { createMountedPanes, refreshPane } from "./chat-pane-mounted.test-support.ts";
import { createPaneHeaderWorkspaceFixture, type TestChatPane } from "./chat-pane.test-support.ts";
import { selectedChatSessionRow } from "./chat-state-route.ts";
import { renderPaneHeaderInto } from "./components/chat-pane-header.test-support.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";

beforeEach(installTranscriptDomMocks);
afterEach(resetTranscriptTestDom);

function parentBreadcrumb(pane: TestChatPane) {
  const container = document.createElement("div");
  renderPaneHeaderInto(
    pane.renderPaneHeader(
      createPaneHeaderWorkspaceFixture(pane.state),
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

function family(prefix: string, displayName: string, incognito: boolean) {
  const parent: GatewaySessionRow = {
    key: `${prefix}parent`,
    agentId: "main",
    sessionId: "parent",
    kind: "direct",
    updatedAt: 1,
    displayName,
    incognito: incognito || undefined,
  };
  const child = {
    ...parent,
    key: `${prefix}child`,
    sessionId: "child",
    displayName: "Child",
    parentSessionKey: parent.key,
  };
  return { parent, child };
}

it.each([false, true])(
  "keeps the parent breadcrumb across roster refresh (incognito: %s)",
  async (incognito) => {
    const { parent, child } = family(
      `agent:main:dashboard:${incognito ? "incognito-" : ""}`,
      "Release prep — café 雪",
      incognito,
    );
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
      expect(pane.state.sessionsResult?.sessions.some((row) => row.key === parent.key)).toBe(false);
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

it.each(["lineage changes", "descriptor fails"] as const)(
  "reconciles a pending parent when %s",
  async (change) => {
    const recovering = change === "descriptor fails";
    const { parent, child } = family(
      recovering ? "agent:main:dashboard:incognito-" : "agent:main:",
      recovering ? "Recovered parent" : "Old parent",
      recovering,
    );
    const replacement: GatewaySessionRow = {
      ...parent,
      key: "agent:main:replacement",
      sessionId: "replacement",
      displayName: "Current parent",
    };
    const oldParent = createDeferred<{ session: GatewaySessionRow }>();
    const parentRequested = createDeferred();
    let parentReads = 0;
    const { sessions, mount, emitGatewayEvent } = createMountedPanes([child], "main", undefined, {
      "sessions.describe": async (_method, raw) => {
        const key = asOptionalRecord(raw)?.key;
        if (key === parent.key) {
          parentReads += 1;
          if (parentReads === 1) {
            parentRequested.resolve();
            return oldParent.promise;
          }
          return { session: parent };
        }
        return { session: key === replacement.key ? replacement : child };
      },
    });
    await sessions.refresh({ agentId: "main", force: true });
    const pane = mount(child.key);
    await refreshPane(pane);
    await parentRequested.promise;
    await vi.dynamicImportSettled();
    if (recovering) {
      oldParent.reject(new Error("Temporary descriptor outage"));
      await vi.dynamicImportSettled();
      expect(parentBreadcrumb(pane)).toBeNull();
      expect(parentReads).toBe(1);
      sessions.reconcile({ ...child, updatedAt: 2, displayName: "Updated child" });
      await vi.dynamicImportSettled();
      expect(parentBreadcrumb(pane)).toBeNull();
      expect(parentReads).toBe(1);
      await sessions.refresh({ agentId: "main", force: true });
      await refreshPane(pane);
    } else {
      emitGatewayEvent("sessions.changed", {
        sessionKey: child.key,
        agentId: "main",
        sessionId: child.sessionId,
        reason: "update",
        session: { ...child, updatedAt: 2, parentSessionKey: replacement.key },
      });
      oldParent.resolve({ session: parent });
    }
    await vi.dynamicImportSettled();
    expect(parentBreadcrumb(pane)?.textContent).toContain(
      recovering ? "Recovered parent" : "Current parent",
    );
    expect(parentBreadcrumb(pane)?.textContent).not.toContain("Old parent");
    if (recovering) {
      expect(parentReads).toBe(2);
    }
  },
);
