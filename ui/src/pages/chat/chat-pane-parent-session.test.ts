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
  const workspace = createPaneHeaderWorkspaceFixture(pane.state);
  const row = selectedChatSessionRow(pane.state);
  renderPaneHeaderInto(
    pane.renderPaneHeader(workspace, row, false, undefined, false, null),
    container,
  );
  return container.querySelector<HTMLButtonElement>(".chat-pane__parent-session");
}

async function mountChild(harness: ReturnType<typeof createMountedPanes>, key: string) {
  await harness.sessions.refresh({ agentId: "main", force: true });
  const pane = harness.mount(key);
  const refresh = async () => {
    await harness.sessions.refresh({ agentId: "main", force: true });
    await refreshPane(pane);
  };
  await refreshPane(pane);
  const changed = (row: GatewaySessionRow, reason: "update" | "delete" = "update") =>
    harness.emitGatewayEvent("sessions.changed", {
      sessionKey: row.key,
      agentId: "main",
      sessionId: row.sessionId,
      reason,
      ...(reason === "update" ? { session: row } : {}),
    });
  return { pane, refresh, changed, draw: () => parentBreadcrumb(pane) };
}

function family(incognito: boolean, displayName = "Release prep — café 雪", dashboard = true) {
  const prefix = `agent:main:${dashboard ? "dashboard:" : ""}${incognito ? "incognito-" : ""}`;
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
    const { parent, child } = family(incognito);
    const harness = createMountedPanes([parent, child], "main", undefined, {
      "sessions.list": async () => sessionsResult(incognito ? [] : [parent, child], 1),
    });
    const { sessions } = harness;
    const { pane, refresh, changed, draw } = await mountChild(harness, child.key);
    await vi.dynamicImportSettled();
    pane.paneId = "pane-child";
    pane.onPaneSessionChange = vi.fn();
    expect(draw()?.textContent).toContain(parent.displayName);
    await refresh();
    expect(draw()?.textContent).toContain(parent.displayName);
    draw()?.click();
    expect(pane.onPaneSessionChange).toHaveBeenCalledExactlyOnceWith("pane-child", parent.key);
    if (incognito) {
      expect(sessions.state.result?.sessions.some((row) => row.key === parent.key)).toBe(false);
      expect(pane.state.sessionsResult?.sessions.some((row) => row.key === parent.key)).toBe(false);
    }
    changed({ ...parent, updatedAt: 2, displayName: "Renamed parent" });
    expect(draw()?.textContent).toContain("Renamed parent");
    changed(parent, "delete");
    expect(draw()).toBeNull();
  },
);

it.each(["lineage changes", "descriptor fails"] as const)(
  "reconciles a pending parent when %s",
  async (change) => {
    const recovering = change === "descriptor fails";
    const { parent, child } = family(
      recovering,
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
    const harness = createMountedPanes([child], "main", undefined, {
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
    const { sessions } = harness;
    const { refresh, changed, draw } = await mountChild(harness, child.key);
    await parentRequested.promise;
    await vi.dynamicImportSettled();
    if (recovering) {
      oldParent.reject(new Error("Temporary descriptor outage"));
      await vi.dynamicImportSettled();
      expect([draw(), parentReads]).toEqual([null, 1]);
      sessions.reconcile({ ...child, updatedAt: 2, displayName: "Updated child" });
      await vi.dynamicImportSettled();
      expect([draw(), parentReads]).toEqual([null, 1]);
      await refresh();
    } else {
      changed({ ...child, updatedAt: 2, parentSessionKey: replacement.key });
      oldParent.resolve({ session: parent });
    }
    await vi.dynamicImportSettled();
    expect(draw()?.textContent).toContain(recovering ? "Recovered parent" : "Current parent");
    expect(draw()?.textContent).not.toContain("Old parent");
    if (recovering) {
      expect(parentReads).toBe(2);
    }
  },
);
