/* @vitest-environment jsdom */
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import type { GatewaySessionRow, SessionsListResult } from "../api/types.ts";
import {
  createTestSessionCapability,
  sessionsResult,
} from "../lib/sessions/session-capability.test-support.ts";
import "../test-helpers/app-sidebar-suite.ts";
import { createGatewayHarness, deferred, mountSidebar } from "../test-helpers/app-sidebar.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { waitForFast } from "../test-helpers/wait-for.ts";
import "./app-sidebar.ts";

describe("selected ancestry after an independent child-list admission", () => {
  it.each(["child successor", "child metadata", "managed successor"] as const)(
    "%s preserves current ancestry while the primary and old ancestor reads wait",
    async (mode) => {
      const initialAt = Date.now() - 100;
      const currentAt = initialAt + 50;
      const managedSuccessor = mode === "managed successor";
      const successor = mode !== "child metadata";
      const key = "agent:main:subagent:child-admission";
      const p1 = "agent:main:child-controller";
      const p2 = "agent:main:new-navigation-parent";
      const grandparentKey = "agent:main:old-grandparent";
      const expectedParent = successor ? p2 : p1;
      const ada = { type: "human" as const, id: "ada", label: "Ada" };
      const bob = { type: "human" as const, id: "bob", label: "Bob" };
      const child: GatewaySessionRow = {
        key,
        sessionId: "selected-child-original-session",
        agentId: "main",
        kind: "direct",
        archived: false,
        spawnedBy: p1,
        parentSessionKey: p1,
        label: "Original selected child",
        status: "done",
        updatedAt: initialAt,
        owner: { actor: managedSuccessor ? ada : bob },
      };
      const parent: GatewaySessionRow = {
        key: p1,
        sessionId: "runtime-controller-session",
        agentId: "main",
        kind: "direct",
        archived: false,
        parentSessionKey: grandparentKey,
        childSessions: [key],
        label: "Runtime controller",
        updatedAt: initialAt - 10,
        owner: { actor: ada },
      };
      const grandparent: GatewaySessionRow = {
        key: grandparentKey,
        sessionId: "old-grandparent-session",
        agentId: "main",
        kind: "direct",
        archived: false,
        childSessions: [p1],
        label: "Previous ancestor",
        updatedAt: initialAt - 20,
        owner: { actor: bob },
      };
      const newParent: GatewaySessionRow = {
        key: p2,
        sessionId: "new-navigation-parent-session",
        agentId: "main",
        kind: "direct",
        archived: false,
        childSessions: [key],
        label: "Current navigation parent",
        updatedAt: initialAt - 10,
        owner: { actor: bob },
      };
      let current = child;
      let changed = false;
      let primaryReleased = false;
      let childReadFinished = false;
      let childReads = 0;
      let managedReads = 0;
      let primaryReads = 0;
      let grandparentReads = 0;
      let newParentReads = 0;
      const childPage = deferred<SessionsListResult>();
      const oldAncestor = deferred<{ session: GatewaySessionRow }>();
      const primary = deferred<SessionsListResult>();
      const result = (rows: GatewaySessionRow[]) => ({
        ...sessionsResult(rows, changed ? currentAt : initialAt),
        owners: [ada, bob],
      });
      const request = vi.fn(async (method: string, raw?: unknown) => {
        const params = asOptionalRecord(raw);
        if (method === "sessions.subscribe") {
          return { subscribed: true, list: result([parent]) };
        }
        if (method === "sessions.list") {
          if (params?.spawnedBy === p1) {
            childReads += 1;
            return childReadFinished ? result([current]) : childPage.promise;
          }
          if (params?.spawnedBy === p2) {
            return result([current]);
          }
          if (params?.involvingMe === true) {
            managedReads += 1;
            return result(managedSuccessor ? [parent, current] : [parent]);
          }
          if (changed && !primaryReleased) {
            primaryReads += 1;
            return primary.promise;
          }
          return result([parent]);
        }
        if (method === "sessions.describe") {
          if (params?.key === key) {
            return { session: current };
          }
          if (params?.key === grandparentKey) {
            grandparentReads += 1;
            return oldAncestor.promise;
          }
          if (params?.key === p1) {
            return { session: parent };
          }
          if (params?.key === p2) {
            newParentReads += 1;
            return { session: newParent };
          }
          throw new Error(`Unexpected describe key: ${String(params?.key)}`);
        }
        return {};
      });
      const harness = createGatewayHarness(createTestGatewayClient(request));
      harness.publish({ selfUser: { id: ada.id, name: "Ada" } });
      const sessions = createTestSessionCapability(harness.gateway);
      await sessions.refresh({ agentId: "main", force: true });
      const { sidebar, provider } = await mountSidebar(harness.gateway, sessions, "panel", {
        defaultId: "main",
        mainKey: "main",
        scope: "per-sender",
        agents: [{ id: "main" }],
      });
      const row = (rowKey: string) => sidebar.querySelector(`[data-session-key="${rowKey}"]`);
      const directParent = () =>
        row(key)
          ?.closest("[data-session-tree]")
          ?.parentElement?.closest("[data-session-tree]")
          ?.getAttribute("data-session-tree") ?? null;
      const expand = async (rowKey: string) => {
        sidebar
          .querySelector<HTMLButtonElement>(
            `[data-child-session-toggle="${rowKey}"][aria-expanded="false"]`,
          )
          ?.click();
        await sidebar.updateComplete;
      };
      let originalLineage: Promise<void> | undefined;
      let primaryRefresh: ReturnType<typeof sessions.refresh> | undefined;
      try {
        sidebar.querySelector<HTMLButtonElement>(".sidebar-session-sort")!.click();
        await sidebar.updateComplete;
        sidebar.querySelector(".sidebar-session-sort-menu")!.dispatchEvent(
          new CustomEvent("wa-select", {
            bubbles: true,
            detail: { item: { value: "involving-me" } },
          }),
        );
        await waitForFast(() => {
          expect(managedReads).toBeGreaterThan(0);
          expect(sidebar.sessionData.sessionsLoading).toBe(false);
          expect(sidebar.sessionData.sessionsResult?.sessions.map((entry) => entry.key)).toEqual(
            managedSuccessor ? [p1, key] : [p1],
          );
        });
        sidebar.activeRouteId = "chat";
        sidebar.sessionKey = key;
        await waitForFast(() => expect(grandparentReads).toBe(1));
        originalLineage = sidebar.sessionData.loadActiveSessionLineage(key);
        await waitForFast(() => expect(row(p1)).not.toBeNull());
        if (!managedSuccessor) {
          expect(request).toHaveBeenCalledWith("sessions.describe", { key });
          expect(sidebar.findSidebarSessionByKey(key)?.sessionId).toBe(child.sessionId);
          expect(childReads).toBe(0);
          const toggle = sidebar.querySelector<HTMLButtonElement>(
            `[data-child-session-toggle="${p1}"][aria-expanded="false"]`,
          );
          expect(toggle).not.toBeNull();
          toggle!.click();
          await sidebar.updateComplete;
        } else {
          await expand(p1);
        }
        await waitForFast(() => expect(childReads).toBe(1));
        if (managedSuccessor) {
          childReadFinished = true;
          childPage.resolve(result([child]));
          await waitForFast(() =>
            expect(sidebar.sessionData.loadingChildSessionKeys.has(p1)).toBe(false),
          );
        }
        const originalRevision = sessions.canonicalListRevision;
        const managedBefore = managedReads;
        changed = true;
        current = {
          ...child,
          sessionId: successor ? "selected-child-successor-session" : child.sessionId,
          parentSessionKey: expectedParent,
          label: "Current selected child",
          updatedAt: currentAt,
        };
        primaryRefresh = sessions.refresh({ agentId: "main", force: true });
        await waitForFast(() => expect(primaryReads).toBeGreaterThan(0));
        if (!managedSuccessor) {
          expect(sidebar.sessionData.sessionsResult?.sessions.map((entry) => entry.key)).toEqual([
            p1,
          ]);
          childReadFinished = true;
          childPage.resolve(result([current]));
          await waitForFast(() =>
            expect(sidebar.sessionData.loadingChildSessionKeys.has(p1)).toBe(false),
          );
        }
        await sidebar.sessionData.refreshSidebarSessions();
        await waitForFast(() => {
          expect(managedReads).toBeGreaterThan(managedBefore);
          expect(sidebar.sessionData.sessionsLoading).toBe(false);
          expect(sidebar.sessionData.sessionsResult?.sessions.map((entry) => entry.key)).toEqual(
            managedSuccessor ? [p1, key] : [p1],
          );
          expect(sidebar.findSidebarSessionByKey(key)).toMatchObject({
            sessionId: current.sessionId,
            label: current.label,
          });
          expect(sessions.state.result?.sessions.find((entry) => entry.key === key)).toMatchObject({
            sessionId: current.sessionId,
            spawnedBy: p1,
            parentSessionKey: expectedParent,
          });
        });
        expect(sessions.canonicalListRevision).toBe(originalRevision);
        await sidebar.updateComplete;
        await waitForFast(() => expect(row(expectedParent)).not.toBeNull());
        await expand(expectedParent);
        await waitForFast(() => expect(directParent()).toBe(expectedParent));
        expect(row(key)?.textContent).toContain(current.label);
        expect(grandparentReads).toBe(1);
        expect(newParentReads).toBe(successor ? 1 : 0);
        oldAncestor.resolve({ session: grandparent });
        await originalLineage;
        await sidebar.updateComplete;
        expect(sidebar.findSidebarSessionByKey(key)?.sessionId).toBe(current.sessionId);
        expect(directParent()).toBe(expectedParent);
        if (successor) {
          expect(sidebar.sessionData.activeSessionLineageRoot?.key).toBe(p2);
        }
        primaryReleased = true;
        primary.resolve(result([parent]));
        await primaryRefresh;
        await waitForFast(() =>
          expect(sessions.canonicalListRevision).toBeGreaterThan(originalRevision),
        );
        await sidebar.sessionData.loadActiveSessionLineage(key);
        await waitForFast(() => expect(row(expectedParent)).not.toBeNull());
        await expand(expectedParent);
        await waitForFast(() => expect(directParent()).toBe(expectedParent));
      } finally {
        childReadFinished = true;
        childPage.resolve(result([current]));
        oldAncestor.resolve({ session: grandparent });
        primaryReleased = true;
        primary.resolve(result([parent]));
        provider.remove();
        sessions.dispose();
        await Promise.all([originalLineage, primaryRefresh]);
      }
    },
  );
});
