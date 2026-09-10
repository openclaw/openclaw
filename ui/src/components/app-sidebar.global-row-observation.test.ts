/* @vitest-environment jsdom */

import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it, vi } from "vitest";
import type { AgentsListResult, GatewaySessionRow, SessionsListResult } from "../api/types.ts";
import {
  createAgentSelectionCapability,
  selectApplicationSession,
} from "../app/agent-selection.ts";
import { createSessionCapability, type SessionRowObservation } from "../lib/sessions/index.ts";
import type { SessionPatchResult } from "../lib/sessions/patch.ts";
import { sessionsResult } from "../lib/sessions/session-capability.test-support.ts";
import { loadChatRoute } from "../pages/chat/route-loader.ts";
import "../test-helpers/app-sidebar-suite.ts";
import {
  createContext,
  createGatewayHarness,
  deferred,
  mountSidebarContext,
} from "../test-helpers/app-sidebar.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../test-helpers/gateway-methods.ts";
import { waitForFast } from "../test-helpers/wait-for.ts";
import "./app-sidebar.ts";

const requireRecord = createRequireRecord("object", "expected-label");

describe("sidebar global row observation", () => {
  it.each([
    "during describe",
    "after list failure",
    "after route retirement",
    "after disposal",
    "while pinning and reading",
    "after a successor list",
  ] as const)(
    "keeps the routed Work alias scoped while reads and ownership change (%s)",
    async (eventTiming) => {
      const agentsList = {
        defaultId: "main",
        mainKey: "workspace",
        scope: "global",
        agents: [{ id: "main" }, { id: "work" }],
      } satisfies AgentsListResult;
      const main: GatewaySessionRow = {
        key: "global",
        agentId: "main",
        sessionId: "main-global",
        kind: "global",
        updatedAt: 300,
        label: "MAIN HELD DESCRIPTOR",
        archived: false,
        pinned: false,
        unread: false,
        status: "done",
        hasActiveRun: false,
      };
      const work: GatewaySessionRow = {
        key: "global",
        agentId: "work",
        sessionId: "work-global",
        kind: "global",
        updatedAt: 200,
        label: "WORK TARGET DESCRIPTOR",
        archived: false,
        pinned: false,
        unread: eventTiming === "while pinning and reading",
        startedAt: 200,
        status: "running",
        hasActiveRun: true,
        activeRunIds: ["work-run"],
      };
      const updated = { ...work, updatedAt: 250, label: "WORK LIVE UPDATE" };
      const completed: GatewaySessionRow = {
        ...updated,
        updatedAt: 500,
        endedAt: 500,
        runtimeMs: 300,
        status: "done",
        hasActiveRun: false,
        activeRunIds: [],
        lastRunId: "work-run",
      };
      const workList = deferred<SessionsListResult>();
      const recoveryList = deferred<SessionsListResult>();
      const workDescribe = deferred<{ session: GatewaySessionRow }>();
      const slowDescribe = deferred<{ session: GatewaySessionRow }>();
      const pinReply = deferred<SessionPatchResult>();
      const readReply = deferred<SessionPatchResult>();
      const unpinReply = deferred<SessionPatchResult>();
      let workListRequests = 0;
      let describeRequests = 0;
      let currentWork = work;
      const request = vi.fn(async (method: string, params?: unknown) => {
        if (method === "sessions.subscribe") {
          return { subscribed: true };
        }
        if (method === "sessions.groups.list") {
          return { names: [], sectionOrder: [] };
        }
        if (method === "models.list") {
          return { models: [] };
        }
        const query = requireRecord(params, `${method} params`);
        if (method === "sessions.list") {
          if (query.agentId !== "work") {
            return sessionsResult([main], 300);
          }
          workListRequests += 1;
          return workListRequests === 1 ? workList.promise : recoveryList.promise;
        }
        if (method === "sessions.describe") {
          expect(query).toEqual({ key: "agent:work:workspace" });
          describeRequests += 1;
          if (eventTiming === "while pinning and reading" && describeRequests === 2) {
            return slowDescribe.promise;
          }
          return describeRequests === 1 ? workDescribe.promise : { session: currentWork };
        }
        if (method === "sessions.patch") {
          expect(query).toMatchObject({
            key: "agent:work:workspace",
            agentId: "work",
            expectedSessionId: "work-global",
          });
          if (query.pinned === true) {
            return pinReply.promise;
          }
          if (query.pinned === false) {
            return unpinReply.promise;
          }
          if (query.unread === false) {
            return readReply.promise;
          }
        }
        throw new Error(`Unexpected Gateway method: ${method}`);
      });
      const client = createTestGatewayClient(request);
      const harness = createGatewayHarness(client);
      const { gateway } = harness;
      harness.publish({
        hello: {
          ...gatewayHelloForMethods([
            "sessions.list",
            "sessions.describe",
            "sessions.subscribe",
            "sessions.patch",
          ]),
          snapshot: {
            sessionDefaults: {
              defaultAgentId: "main",
              mainKey: "workspace",
              mainSessionKey: "global",
            },
          },
        },
        sessionKey: "agent:main:workspace",
      });
      gateway.setSessionKey = (sessionKey) => harness.publish({ sessionKey });
      const selection = createAgentSelectionCapability(
        gateway,
        {
          state: { agentsList },
          subscribe: () => () => undefined,
        },
        { load: () => "main", save: () => undefined },
      );
      const sessions = createSessionCapability(gateway, selection);
      const context = {
        ...createContext(gateway, sessions, agentsList),
        agentSelection: selection,
      };
      const { provider, sidebar } = await mountSidebarContext(context, "panel", "sessions");
      sidebar.connected = true;
      let recovery: Promise<void> | undefined;
      let action: Promise<unknown> | undefined;
      let slowResponse: Promise<{ session: GatewaySessionRow }> | undefined;
      let observation: SessionRowObservation | undefined;
      try {
        harness.publish({});
        await waitForFast(() =>
          expect(sessions.state.result?.sessions[0]?.sessionId).toBe(main.sessionId),
        );
        const primary = sessions.state.result;
        const primaryRows = primary?.sessions;
        const primaryDefaults = primary?.defaults;
        const revision = sessions.canonicalListRevision;
        const route = await loadChatRoute(
          context,
          { pathname: "/chat/work", search: "", hash: "" },
          "chat",
          new AbortController().signal,
        );
        if (!("kind" in route) || route.kind !== "session") {
          throw new Error("Work route did not resolve to a session");
        }
        expect(route.sessionKey).toBe("agent:work:workspace");
        selectApplicationSession({ selection, gateway, sessionKey: route.sessionKey });
        sidebar.activeRouteId = "chat";
        sidebar.sessionKey = route.sessionKey;
        await waitForFast(() => expect(workListRequests).toBe(1));
        await waitForFast(() => expect(describeRequests).toBe(1));
        if (eventTiming === "after route retirement" || eventTiming === "after disposal") {
          const lineage = sidebar.sessionData.loadActiveSessionLineage(route.sessionKey);
          const { key, agentId, ...fields } = updated;
          harness.publishEvent("sessions.changed", {
            ...fields,
            sessionKey: key,
            agentId,
            reason: "patch",
            ts: 250,
          });
          if (eventTiming === "after disposal") {
            provider.remove();
          } else {
            const next = await loadChatRoute(
              context,
              { pathname: "/chat/main", search: "", hash: "" },
              "chat",
              new AbortController().signal,
            );
            if (!("kind" in next) || next.kind !== "session") {
              throw new Error("Main route did not resolve to a session");
            }
            selectApplicationSession({ selection, gateway, sessionKey: next.sessionKey });
            sidebar.sessionKey = next.sessionKey;
          }
          workDescribe.resolve({ session: work });
          await lineage;
          if (eventTiming === "after route retirement") {
            workList.resolve(sessionsResult([updated], 250));
            await waitForFast(() => expect(sessions.state.agentId).toBe("main"));
            await sidebar.sessionData.loadActiveSessionLineage(sidebar.sessionKey);
            await sidebar.updateComplete;
            expect(sidebar.querySelector(`[data-session-key="${route.sessionKey}"]`)).toBeNull();
            expect(sidebar.textContent).not.toContain(work.label);
            expect(sidebar.textContent).not.toContain(updated.label);
          } else {
            expect(document.body.contains(sidebar)).toBe(false);
          }
          expect(describeRequests).toBe(1);
          return;
        }
        const assertAlias = (expected: GatewaySessionRow) => {
          const row = sidebar.querySelector(`[data-session-key="${route.sessionKey}"]`);
          expect.soft(row?.textContent).toContain(expected.label);
          expect
            .soft(row?.classList.contains("session-row-host--running"))
            .toBe(expected.hasActiveRun);
          expect.soft(sidebar.findSidebarSessionByKey(route.sessionKey)).toMatchObject({
            label: expected.label,
            hasActiveRun: expected.hasActiveRun,
          });
        };
        const assertMainUnchanged = () => {
          expect(sessions.state.result).toBe(primary);
          expect(sessions.state.result?.sessions).toBe(primaryRows);
          expect(sessions.state.result?.defaults).toBe(primaryDefaults);
          expect(sessions.state.agentId).toBe("main");
          expect(sessions.canonicalListRevision).toBe(revision);
          expect(sidebar.textContent).not.toContain(main.label);
        };
        const publishWorkPatch = () => {
          currentWork = updated;
          const { key, agentId, ...fields } = updated;
          harness.publishEvent("sessions.changed", {
            ...fields,
            sessionKey: key,
            agentId,
            reason: "patch",
            ts: 250,
          });
        };
        if (eventTiming === "during describe") {
          publishWorkPatch();
        }
        workDescribe.resolve({ session: work });
        await sidebar.sessionData.loadActiveSessionLineage(route.sessionKey);
        await sidebar.updateComplete;
        assertAlias(eventTiming === "during describe" ? updated : work);
        expect(sessions.state.loading).toBe(true);
        assertMainUnchanged();

        workList.reject(new Error("Work roster unavailable"));
        await waitForFast(() => {
          expect(sessions.state.loading).toBe(false);
          expect(sessions.state.error).toBe("Work roster unavailable");
        });
        if (eventTiming === "after a successor list") {
          const replacement = {
            ...completed,
            sessionId: "work-replacement",
            label: "NEW WORK INCARNATION",
            updatedAt: 600,
          };
          currentWork = replacement;
          recovery = sessions.refresh({ agentId: "work", force: true });
          recoveryList.resolve(sessionsResult([replacement], 600));
          await recovery;
          await sidebar.sessionData.loadActiveSessionLineage(route.sessionKey);
          await sidebar.updateComplete;
          assertAlias(replacement);
          const { key, agentId, ...fields } = completed;
          harness.publishEvent("sessions.changed", {
            ...fields,
            sessionKey: key,
            agentId,
            phase: "end",
            runId: "work-run",
            ts: 500,
            session: completed,
          });
          await sidebar.updateComplete;
          assertAlias(replacement);
          expect(sessions.state.result?.sessions).toHaveLength(1);
          expect(sessions.state.result?.sessions[0]?.sessionId).toBe(replacement.sessionId);
          expect(sidebar.textContent).not.toContain(work.label);
          return;
        }
        if (eventTiming === "while pinning and reading") {
          const visibleRow = () => {
            const row = sidebar.findSidebarSessionByKey(route.sessionKey);
            if (!row) {
              throw new Error("Work alias is missing");
            }
            return row;
          };
          observation = sessions.observeRow({ key: "global", agentId: "work" }, () => {});
          const acceptSlow = observation.captureReconcile();
          slowResponse = client.request<{ session: GatewaySessionRow }>("sessions.describe", {
            key: route.sessionKey,
          });
          action = sidebar.sessionOrganizer.patchSession(visibleRow(), { pinned: true });
          await waitForFast(() =>
            expect(request).toHaveBeenCalledWith(
              "sessions.patch",
              expect.objectContaining({
                key: route.sessionKey,
                pinned: true,
                agentId: "work",
                expectedSessionId: "work-global",
              }),
            ),
          );
          await sidebar.updateComplete;
          expect.soft(visibleRow().pinned).toBe(true);
          assertMainUnchanged();
          pinReply.resolve({
            ok: true,
            path: "(multiple)",
            key: "global",
            entry: { sessionId: "work-global", pinnedAt: 350, updatedAt: 350 },
          });
          await waitForFast(() => expect(workListRequests).toBe(2));
          recoveryList.reject(new Error("Work roster unavailable"));
          await action;
          await sidebar.updateComplete;
          expect.soft(visibleRow().pinned).toBe(true);

          action = sidebar.sessionOrganizer.patchSession(visibleRow(), { unread: false });
          await waitForFast(() =>
            expect(request).toHaveBeenCalledWith(
              "sessions.patch",
              expect.objectContaining({
                key: route.sessionKey,
                unread: false,
                agentId: "work",
                expectedSessionId: "work-global",
              }),
            ),
          );
          await sidebar.updateComplete;
          expect.soft(visibleRow()).toMatchObject({ pinned: true, unread: false });
          readReply.resolve({
            ok: true,
            path: "(multiple)",
            key: "global",
            entry: { sessionId: "work-global", pinnedAt: 350, updatedAt: 400, lastReadAt: 400 },
          });
          await action;
          await sidebar.updateComplete;
          expect.soft(visibleRow()).toMatchObject({ pinned: true, unread: false });

          action = sidebar.sessionOrganizer.patchSession(visibleRow(), { pinned: false });
          await waitForFast(() =>
            expect(request).toHaveBeenCalledWith(
              "sessions.patch",
              expect.objectContaining({
                key: route.sessionKey,
                pinned: false,
                agentId: "work",
                expectedSessionId: "work-global",
              }),
            ),
          );
          await sidebar.updateComplete;
          expect.soft(visibleRow().pinned).toBe(false);
          unpinReply.reject(new Error("Unpin rejected"));
          await action;
          await sidebar.updateComplete;
          expect.soft(visibleRow()).toMatchObject({ pinned: true, unread: false });
          sessions.reconcileRunTerminal({
            sessionKeys: ["global"],
            agentId: "work",
            runId: "work-run",
            status: "done",
            endedAt: 500,
          });
          await sidebar.updateComplete;
          expect
            .soft(visibleRow())
            .toMatchObject({ pinned: true, unread: false, hasActiveRun: false });
          slowDescribe.resolve({ session: work });
          const response = await slowResponse;
          expect(acceptSlow(response.session).status).toBe("current");
          await sidebar.updateComplete;
          expect
            .soft(visibleRow())
            .toMatchObject({ pinned: true, unread: false, hasActiveRun: false });
          assertMainUnchanged();
          return;
        }
        if (eventTiming === "after list failure") {
          publishWorkPatch();
        }
        await sidebar.updateComplete;
        assertAlias(updated);
        assertMainUnchanged();
        currentWork = completed;
        const { key, agentId, ...terminalFields } = completed;
        harness.publishEvent("sessions.changed", {
          ...terminalFields,
          sessionKey: key,
          agentId,
          phase: "end",
          runId: "work-run",
          ts: 500,
          session: completed,
        });
        await sidebar.updateComplete;
        assertAlias(completed);
        assertMainUnchanged();

        recovery = sessions.refresh({ agentId: "work", force: true });
        recoveryList.resolve(sessionsResult([completed], 500));
        await recovery;
        await waitForFast(() => {
          expect(sessions.state.agentId).toBe("work");
          expect(sidebar.sessionData.sessionsAgentId).toBe("work");
        });
        await sidebar.updateComplete;
        expect(sessions.state.result?.sessions).toHaveLength(1);
        expect(sessions.state.result?.sessions).toMatchObject([completed]);
        expect(
          sidebar.querySelector(`[data-session-key="${route.sessionKey}"]`)?.textContent,
        ).toContain(completed.label);
        expect(sidebar.textContent).not.toContain(main.label);
        expect(
          sidebar
            .querySelector(`[data-session-key="${route.sessionKey}"]`)
            ?.classList.contains("session-row-host--running"),
        ).toBe(false);
      } finally {
        provider.remove();
        observation?.dispose();
        sessions.dispose();
        workDescribe.resolve({ session: currentWork });
        workList.resolve(sessionsResult([currentWork], 500));
        recoveryList.resolve(sessionsResult([currentWork], 500));
        slowDescribe.resolve({ session: currentWork });
        const acknowledgment: SessionPatchResult = {
          ok: true,
          path: "(multiple)",
          key: "global",
          entry: { sessionId: "work-global" },
        };
        pinReply.resolve(acknowledgment);
        readReply.resolve(acknowledgment);
        unpinReply.resolve(acknowledgment);
        await Promise.allSettled([
          workDescribe.promise,
          workList.promise,
          recoveryList.promise,
          recovery,
          action,
          slowResponse,
          pinReply.promise,
          readReply.promise,
          unpinReply.promise,
        ]);
        await vi.dynamicImportSettled();
        await sidebar.updateComplete;
      }
    },
  );
});
