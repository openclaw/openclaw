/* @vitest-environment jsdom */

import { expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../test/helpers/promise.js";
import { createRequireRecord } from "../../../test/helpers/record.js";
import type { AgentsListResult, GatewaySessionRow } from "../api/types.ts";
import { selectApplicationSession } from "../app/agent-selection.ts";
import type { SessionRowObservation } from "../lib/sessions/index.ts";
import type { SessionPatch, SessionPatchResult } from "../lib/sessions/patch.ts";
import { sessionsResult } from "../lib/sessions/session-capability.test-support.ts";
import { loadChatRoute } from "../pages/chat/route-loader.ts";
import "../test-helpers/app-sidebar-suite.ts";
import { createGatewayHarness } from "../test-helpers/app-sidebar.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../test-helpers/gateway-methods.ts";
import { settleLitElement } from "../test-helpers/lit-settle.ts";
import { waitForFast } from "../test-helpers/wait-for.ts";
import {
  rowElement,
  waitForRequest,
  mountSelectedRoster,
} from "./app-sidebar-freshness.test-support.ts";
import "./app-sidebar.tsx";

const requireRecord = createRequireRecord("object", "expected-label");
const acknowledgment = (
  entry: Omit<SessionPatchResult["entry"], "sessionId"> = {},
): SessionPatchResult => ({
  ok: true,
  path: "(multiple)",
  key: "global",
  entry: { sessionId: "work-global", ...entry },
});

it.each(["after describe", "while pinning and reading", "after a successor list"] as const)(
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
      ...main,
      agentId: "work",
      sessionId: "work-global",
      updatedAt: 200,
      label: "WORK TARGET DESCRIPTOR",
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
    let currentWork = work;
    const cleanups: Array<() => Promise<unknown>> = [];
    const pending = <T>(fallback: () => T) => {
      const reply = deferred<T>();
      cleanups.push(() => {
        reply.resolve(fallback());
        return reply.promise;
      });
      return reply;
    };
    const list = () => sessionsResult([currentWork], 500);
    const describe = () => ({ session: currentWork });
    const workDescribe = pending(describe);
    const workList = pending(list);
    const recoveryList = pending(list);
    const slowDescribe = pending(describe);
    const pinReply = pending(acknowledgment);
    const readReply = pending(acknowledgment);
    const unpinReply = pending(acknowledgment);
    let workListRequests = 0;
    let describeRequests = 0;
    const request = vi.fn(async (method: string, params?: unknown) => {
      switch (method) {
        case "sessions.subscribe":
          return { subscribed: true };
        case "sessions.groups.list":
          return { names: [], sectionOrder: [] };
        case "models.list":
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
    const { provider, sidebar, sessions, selection, context } = await mountSelectedRoster(
      harness,
      agentsList,
      "main",
    );
    const data = sidebar.sessionData;
    sidebar.connected = true;
    let recovery: Promise<void> | undefined;
    let action: Promise<unknown> | undefined;
    let slowResponse: Promise<{ session: GatewaySessionRow }> | undefined;
    let observation: SessionRowObservation | undefined;
    const publishWork = (row: GatewaySessionRow, terminal = false) => {
      const { key, agentId, ...fields } = row;
      harness.publishEvent("sessions.changed", {
        ...fields,
        sessionKey: key,
        agentId,
        ts: row.updatedAt,
        ...(terminal ? { phase: "end", runId: "work-run", session: row } : { reason: "patch" }),
      });
    };
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
      const key = route.sessionKey;
      selectApplicationSession({ selection, gateway, sessionKey: key });
      sidebar.activeRouteId = "chat";
      sidebar.sessionKey = key;
      await waitForFast(() => expect(workListRequests).toBe(1));
      await waitForFast(() => expect(describeRequests).toBe(1));
      const assertAlias = (expected: GatewaySessionRow) => {
        const row = rowElement(sidebar, key);
        expect.soft(row?.textContent).toContain(expected.label);
        expect
          .soft(row?.classList.contains("session-row-host--running"))
          .toBe(expected.hasActiveRun);
        expect.soft(sidebar.findSidebarSessionByKey(key)).toMatchObject({
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
      workDescribe.resolve({ session: work });
      await data.loadActiveSessionLineage(key);
      await sidebar.updateComplete;
      assertAlias(work);
      expect(sessions.state.loading).toBe(true);
      assertMainUnchanged();

      workList.reject(new Error("Work roster unavailable"));
      await waitForFast(() => {
        expect(sessions.state).toMatchObject({
          loading: false,
          error: "Work roster unavailable",
        });
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
        await data.loadActiveSessionLineage(key);
        await sidebar.updateComplete;
        assertAlias(replacement);
        publishWork(completed, true);
        await sidebar.updateComplete;
        assertAlias(replacement);
        expect(sessions.state.result?.sessions).toHaveLength(1);
        expect(sessions.state.result?.sessions[0]?.sessionId).toBe(replacement.sessionId);
        expect(sidebar.textContent).not.toContain(work.label);
        return;
      }
      if (eventTiming === "while pinning and reading") {
        const visibleRow = () => {
          const row = sidebar.findSidebarSessionByKey(key);
          if (!row) {
            throw new Error("Work alias is missing");
          }
          return row;
        };
        const finishAction = async (expected: Partial<GatewaySessionRow>) => {
          await action;
          await sidebar.updateComplete;
          expect.soft(visibleRow()).toMatchObject(expected);
        };
        observation = sessions.observeRow({ key: "global", agentId: "work" }, () => {});
        const acceptSlow = observation.captureReconcile();
        slowResponse = client.request<{ session: GatewaySessionRow }>("sessions.describe", {
          key,
        });
        await import("./session-organizer-operations.runtime.ts");
        const beginPatch = async (patch: SessionPatch) => {
          action = sidebar.sessionOrganizer.patchSession(visibleRow(), patch);
          await waitForRequest(
            request,
            "sessions.patch",
            {
              key,
              agentId: "work",
              expectedSessionId: "work-global",
              ...patch,
            },
            true,
          );
          await sidebar.updateComplete;
        };
        await beginPatch({ pinned: true });
        expect.soft(visibleRow().pinned).toBe(true);
        assertMainUnchanged();
        pinReply.resolve(acknowledgment({ pinnedAt: 350, updatedAt: 350 }));
        await waitForFast(() => expect(workListRequests).toBe(2));
        recoveryList.reject(new Error("Work roster unavailable"));
        await finishAction({ pinned: true });

        await beginPatch({ unread: false });
        expect.soft(visibleRow()).toMatchObject({ pinned: true, unread: false });
        readReply.resolve(acknowledgment({ pinnedAt: 350, updatedAt: 400, lastReadAt: 400 }));
        await finishAction({ pinned: true, unread: false });

        await beginPatch({ pinned: false });
        expect.soft(visibleRow().pinned).toBe(false);
        unpinReply.reject(new Error("Unpin rejected"));
        await finishAction({ pinned: true, unread: false });
        sessions.reconcileRunTerminal({
          sessionKeys: ["global"],
          agentId: "work",
          runId: "work-run",
          status: "done",
          endedAt: 500,
        });
        await sidebar.updateComplete;
        const settled = { pinned: true, unread: false, hasActiveRun: false };
        expect.soft(visibleRow()).toMatchObject(settled);
        slowDescribe.resolve({ session: work });
        const response = await slowResponse;
        expect(acceptSlow(response.session).status).toBe("current");
        await sidebar.updateComplete;
        expect.soft(visibleRow()).toMatchObject(settled);
        assertMainUnchanged();
        return;
      }
      for (const row of [updated, completed]) {
        currentWork = row;
        publishWork(row, row === completed);
        await settleLitElement(sidebar);
        assertAlias(row);
        assertMainUnchanged();
      }

      recovery = sessions.refresh({ agentId: "work", force: true });
      recoveryList.resolve(sessionsResult([completed], 500));
      await recovery;
      await waitForFast(() => {
        expect(sessions.state.agentId).toBe("work");
        expect(data.sessionsAgentId).toBe("work");
      });
      await sidebar.updateComplete;
      expect(sessions.state.result?.sessions).toHaveLength(1);
      expect(sessions.state.result?.sessions).toMatchObject([completed]);
      assertAlias(completed);
      expect(sidebar.textContent).not.toContain(main.label);
    } finally {
      provider.remove();
      observation?.dispose();
      sessions.dispose();
      await Promise.allSettled([
        ...cleanups.map((cleanup) => cleanup()),
        recovery,
        action,
        slowResponse,
      ]);
      await vi.dynamicImportSettled();
      await sidebar.updateComplete;
    }
  },
);
