/* @vitest-environment jsdom */
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../api/types.ts";
import {
  createTestSessionCapability,
  sessionsResult,
} from "../lib/sessions/session-capability.test-support.ts";
import "../test-helpers/app-sidebar-suite.ts";
import { createGatewayHarness, mountSidebar } from "../test-helpers/app-sidebar.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { waitForFast } from "../test-helpers/wait-for.ts";
import "./app-sidebar.ts";

describe("selected lineage after a full sessions.changed event", () => {
  it.each(["filtered omitted", "unfiltered metadata", "managed member"] as const)(
    "%s keeps accepted event fields visible after list refresh failures",
    async (mode) => {
      const filtered = mode !== "unfiltered metadata";
      const managedMember = mode === "managed member";
      const reparent = mode !== "unfiltered metadata";
      const key = "agent:main:event-selected";
      const p1 = "agent:main:event-original-parent";
      const p2 = "agent:main:event-new-parent";
      const expectedParent = reparent ? p2 : p1;
      const initialAt = Date.now() - 100;
      const ada = { type: "human" as const, id: "ada", label: "Ada" };
      const bob = { type: "human" as const, id: "bob", label: "Bob" };
      const child: GatewaySessionRow = {
        key,
        sessionId: "event-selected-session",
        agentId: "main",
        kind: "direct",
        archived: false,
        spawnedBy: p1,
        parentSessionKey: p1,
        label: "Earlier selected title",
        updatedAt: initialAt,
        status: "done",
        owner: { actor: managedMember ? ada : bob },
      };
      const parent: GatewaySessionRow = {
        key: p1,
        sessionId: "event-original-parent-session",
        agentId: "main",
        kind: "direct",
        archived: false,
        childSessions: [key],
        label: "Original parent",
        updatedAt: initialAt - 10,
        owner: { actor: ada },
      };
      const newParent: GatewaySessionRow = {
        key: p2,
        sessionId: "event-new-parent-session",
        agentId: "main",
        kind: "direct",
        archived: false,
        childSessions: [key],
        label: "New parent",
        updatedAt: initialAt - 10,
        owner: { actor: bob },
      };
      let current = child;
      let failedLists = false;
      let recovery = false;
      let primaryFailures = 0;
      let managedFailures = 0;
      let controllerChildReads = 0;
      let newParentReads = 0;
      const result = (rows: GatewaySessionRow[]) => ({
        ...sessionsResult(rows, current.updatedAt ?? initialAt),
        owners: [ada, bob],
      });
      const primaryRows = () => (!filtered || recovery ? [parent, current] : [parent]);
      const request = vi.fn(async (method: string, raw?: unknown) => {
        const params = asOptionalRecord(raw);
        if (method === "sessions.subscribe") {
          return { subscribed: true, list: result(primaryRows()) };
        }
        if (method === "sessions.list") {
          if (params?.spawnedBy === p1) {
            controllerChildReads += 1;
            return result([current]);
          }
          if (params?.spawnedBy === p2) {
            return result([current]);
          }
          if (params?.involvingMe === true) {
            if (failedLists) {
              managedFailures += 1;
              throw new Error("Synthetic managed refresh failure");
            }
            return result(managedMember ? [parent, current] : [parent]);
          }
          if (failedLists) {
            primaryFailures += 1;
            throw new Error("Synthetic primary refresh failure");
          }
          return result(primaryRows());
        }
        if (method === "sessions.describe") {
          if (params?.key === key) {
            return { session: current };
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
      try {
        if (filtered) {
          sidebar.querySelector<HTMLButtonElement>(".sidebar-session-sort")!.click();
          await sidebar.updateComplete;
          sidebar.querySelector(".sidebar-session-sort-menu")!.dispatchEvent(
            new CustomEvent("wa-select", {
              bubbles: true,
              detail: { item: { value: "involving-me" } },
            }),
          );
          await waitForFast(() => {
            expect(sidebar.sessionData.sessionsLoading).toBe(false);
            expect(sidebar.sessionData.sessionsResult?.sessions.map((entry) => entry.key)).toEqual(
              managedMember ? [p1, key] : [p1],
            );
          });
        }
        sidebar.activeRouteId = "chat";
        sidebar.sessionKey = key;
        await waitForFast(() => expect(sidebar.sessionData.activeSessionLineageRoot?.key).toBe(p1));
        await expand(p1);
        await waitForFast(() => {
          expect(controllerChildReads).toBe(1);
          expect(sidebar.sessionData.loadingChildSessionKeys.has(p1)).toBe(false);
          expect(directParent()).toBe(p1);
          expect(row(key)?.textContent).toContain(child.label);
        });
        const revisionBefore = sessions.canonicalListRevision;
        failedLists = true;
        current = {
          ...child,
          parentSessionKey: expectedParent,
          label: "Event-updated selected title",
          updatedAt: Date.now(),
        };
        harness.publishEvent("sessions.changed", {
          sessionKey: key,
          agentId: "main",
          reason: "create",
          ts: current.updatedAt,
          sessionId: current.sessionId,
          kind: current.kind,
          updatedAt: current.updatedAt,
          label: current.label,
          parentSessionKey: current.parentSessionKey,
          spawnedBy: current.spawnedBy,
          archived: false,
          archivedAt: null,
          archivedBy: null,
          archiveReason: null,
          owner: current.owner,
          createdActor: null,
          participants: [],
          participantCount: 0,
          pinned: false,
          pinnedAt: null,
          unread: false,
          markedUnreadAt: null,
          agentStatus: null,
          observerDigest: null,
          controlOwnerSessionKey: null,
          icon: null,
          color: null,
          channelAvatarUrl: null,
          category: null,
          displayName: null,
          permissionMode: null,
          permissionModePending: false,
          toolOverrides: null,
          thinkingLevel: null,
          activeModelProvider: null,
          activeModel: null,
          lastRunError: null,
          lastRunId: null,
          hasAutomation: false,
          hasActiveRun: false,
          activeRunIds: [],
          status: "done",
        });
        await waitForFast(() =>
          expect(sessions.state.result?.sessions.find((entry) => entry.key === key)).toMatchObject({
            sessionId: child.sessionId,
            label: current.label,
            parentSessionKey: expectedParent,
          }),
        );
        await waitForFast(() => {
          expect(primaryFailures).toBeGreaterThan(0);
          if (filtered) {
            expect(managedFailures).toBeGreaterThan(0);
          }
        });
        await sidebar.updateComplete;
        expect(sessions.canonicalListRevision).toBe(revisionBefore);
        expect(controllerChildReads).toBe(1);
        if (mode === "filtered omitted") {
          expect(sidebar.sessionData.sessionsResult?.sessions.map((entry) => entry.key)).toEqual([
            p1,
          ]);
        }
        await waitForFast(() => expect(row(key)?.textContent).toContain(current.label));
        await waitForFast(() => expect(row(expectedParent)).not.toBeNull());
        await expand(expectedParent);
        await waitForFast(() => expect(directParent()).toBe(expectedParent));
        expect(newParentReads).toBe(reparent ? 1 : 0);
        failedLists = false;
        recovery = true;
        await sessions.refresh({ agentId: "main", force: true });
        if (filtered) {
          await sidebar.sessionData.refreshSidebarSessions();
        }
        await waitForFast(() => expect(row(expectedParent)).not.toBeNull());
        await expand(expectedParent);
        await waitForFast(() => {
          expect(row(key)?.textContent).toContain(current.label);
          expect(directParent()).toBe(expectedParent);
        });
      } finally {
        failedLists = false;
        provider.remove();
        sessions.dispose();
      }
    },
  );
});
