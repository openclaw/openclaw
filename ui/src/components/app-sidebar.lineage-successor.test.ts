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

describe("selected lineage after managed list admission", () => {
  it.each(["metadata", "successor", "pending incarnation", "known parent"] as const)(
    "%s updates preserve current ancestry before the primary response settles",
    async (kind) => {
      const pendingIncarnation = kind === "pending incarnation";
      const changesParent = kind === "successor" || kind === "known parent";
      const changesSessionId = kind === "successor" || pendingIncarnation;
      const knownParent = kind === "known parent";
      const key = "agent:main:ordinary-child";
      const p1 = "agent:main:original-parent";
      const p2 = "agent:main:successor-parent";
      const expectedParent = changesParent ? p2 : p1;
      const ada = { type: "human" as const, id: "ada", label: "Ada" };
      const bob = { type: "human" as const, id: "bob", label: "Bob" };
      const child: GatewaySessionRow = {
        key,
        sessionId: "ordinary-child-original-session",
        agentId: "main",
        kind: "direct",
        archived: false,
        parentSessionKey: p1,
        label: "Original selected conversation",
        updatedAt: 10,
        owner: { actor: ada },
      };
      const oldParent: GatewaySessionRow = {
        key: p1,
        sessionId: "original-parent-session",
        agentId: "main",
        kind: "direct",
        archived: false,
        childSessions: [key],
        label: "Original ancestor",
        updatedAt: 5,
        owner: { actor: bob },
      };
      const newParent: GatewaySessionRow = {
        ...oldParent,
        key: p2,
        sessionId: "successor-parent-session",
        label: "Successor ancestor",
        owner: { actor: knownParent ? ada : bob },
      };
      const freshParent = { ...oldParent, label: "Current ancestor", updatedAt: 30 };
      const oldParentRead = deferred<{ session: GatewaySessionRow }>();
      let parentReads = 0;
      let current = child;
      let changed = false;
      let primaryReleased = false;
      let primaryReads = 0;
      let managedReads = 0;
      const primary = deferred<SessionsListResult>();
      const result = () => ({
        ...sessionsResult(knownParent ? [current, newParent] : [current], changed ? 30 : 10),
        owners: [ada, bob],
      });
      const request = vi.fn(async (method: string, raw?: unknown) => {
        const params = asOptionalRecord(raw);
        if (method === "sessions.subscribe") {
          return { subscribed: true, list: result() };
        }
        if (method === "sessions.list") {
          if (params?.spawnedBy === p1) {
            return sessionsResult(changed && changesParent ? [] : [current], 30);
          }
          if (params?.spawnedBy === p2) {
            return sessionsResult([current], 30);
          }
          if (params?.involvingMe === true) {
            managedReads += 1;
            return result();
          }
          if (changed && !primaryReleased) {
            primaryReads += 1;
            return primary.promise;
          }
          return result();
        }
        if (method === "sessions.describe") {
          if (params?.key === key) {
            return { session: current };
          }
          if (params?.key === p1) {
            parentReads += 1;
            if (pendingIncarnation && parentReads === 1) {
              return oldParentRead.promise;
            }
            return { session: pendingIncarnation ? freshParent : oldParent };
          }
          if (params?.key === p2) {
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
      const parentOfSelected = () =>
        row(key)
          ?.closest("[data-session-tree]")
          ?.parentElement?.closest("[data-session-tree]")
          ?.getAttribute("data-session-tree") ?? null;
      const expand = async (rowKey: string) => {
        const toggle = sidebar.querySelector<HTMLButtonElement>(
          `[data-child-session-toggle="${rowKey}"][aria-expanded="false"]`,
        );
        toggle?.click();
        await sidebar.updateComplete;
      };
      let originalLineage: Promise<void> | undefined;
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
            knownParent ? [key, p2] : [key],
          );
        });
        sidebar.activeRouteId = "chat";
        sidebar.sessionKey = key;
        await waitForFast(() => expect(parentReads).toBe(1));
        originalLineage = sidebar.sessionData.loadActiveSessionLineage(key);
        if (!pendingIncarnation) {
          await originalLineage;
          await waitForFast(() => expect(row(p1)).not.toBeNull());
          await expand(p1);
          await waitForFast(() => expect(parentOfSelected()).toBe(p1));
        }
        const originalRevision = sessions.canonicalListRevision;
        const originalManagedReads = managedReads;
        changed = true;
        current = {
          ...child,
          sessionId: changesSessionId ? "ordinary-child-successor-session" : child.sessionId,
          parentSessionKey: expectedParent,
          label: "Current selected conversation",
          updatedAt: 30,
        };
        harness.publishEvent("sessions.changed", {
          ...current,
          sessionKey: key,
          session: current,
          reason: kind === "metadata" ? "patch" : "create",
          ts: 30,
        });
        await waitForFast(() => {
          expect(primaryReads).toBeGreaterThan(0);
          expect(managedReads).toBeGreaterThan(originalManagedReads);
          expect(sidebar.sessionData.sessionsLoading).toBe(false);
          expect(sidebar.sessionData.sessionsResult?.sessions[0]).toMatchObject({
            sessionId: current.sessionId,
            parentSessionKey: current.parentSessionKey,
            label: current.label,
          });
        });
        expect(sessions.canonicalListRevision).toBe(originalRevision);
        await sidebar.updateComplete;
        if (pendingIncarnation) {
          await waitForFast(() => expect(parentReads).toBe(2));
        }
        await sidebar.sessionData.loadActiveSessionLineage(key);
        await sidebar.updateComplete;
        await expand(expectedParent);
        const beforePrimary = {
          selectedSessionId: sidebar.findSidebarSessionByKey(key)?.sessionId,
          selectedText: row(key)?.textContent?.replace(/\s+/g, " ").trim(),
          parentOfSelected: parentOfSelected(),
          originalParentVisible: row(p1) !== null,
          successorParentVisible: row(p2) !== null,
          parentReads,
          successorDescribeReads: request.mock.calls.filter(
            ([method, params]) =>
              method === "sessions.describe" && asOptionalRecord(params)?.key === p2,
          ).length,
        };
        if (pendingIncarnation) {
          oldParentRead.resolve({ session: oldParent });
          await originalLineage;
          await sidebar.updateComplete;
          expect(row(p1)?.textContent).toContain("Current ancestor");
          expect(sidebar.findSidebarSessionByKey(key)?.sessionId).toBe(current.sessionId);
        }
        primaryReleased = true;
        primary.resolve(result());
        await waitForFast(() =>
          expect(sessions.canonicalListRevision).toBeGreaterThan(originalRevision),
        );
        await waitForFast(() => expect(row(expectedParent)).not.toBeNull());
        await expand(expectedParent);
        await waitForFast(() => expect(parentOfSelected()).toBe(expectedParent));
        expect(beforePrimary.selectedSessionId).toBe(current.sessionId);
        expect(beforePrimary.selectedText).toContain("Current selected conversation");
        expect(beforePrimary.parentOfSelected).toBe(expectedParent);
        expect(beforePrimary.parentReads).toBe(pendingIncarnation ? 2 : 1);
        expect(beforePrimary.successorParentVisible).toBe(changesParent);
        if (changesParent) {
          expect(beforePrimary.originalParentVisible).toBe(false);
          expect(beforePrimary.successorDescribeReads).toBe(knownParent ? 0 : 1);
        }
      } finally {
        primaryReleased = true;
        primary.resolve(result());
        oldParentRead.resolve({ session: oldParent });
        provider.remove();
        sessions.dispose();
        await originalLineage;
      }
    },
  );
});
