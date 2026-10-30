import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
/* @vitest-environment jsdom */
import { expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../test/helpers/promise.js";
import { createRequireRecord } from "../../../test/helpers/record.js";
import type { AgentsListResult, GatewaySessionRow, SessionsListResult } from "../api/types.ts";
import { selectApplicationSession } from "../app/agent-selection.ts";
import { makeBootRoster } from "../app/bootstrap.test-support.ts";
import { sessionsResult } from "../lib/sessions/session-capability.test-support.ts";
import "../test-helpers/app-sidebar-suite.ts";
import { activateSessionMenuValue } from "../test-helpers/app-sidebar-menu.ts";
import { createGatewayHarness, type SidebarLifecycleState } from "../test-helpers/app-sidebar.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../test-helpers/gateway-methods.ts";
import { waitForFast } from "../test-helpers/wait-for.ts";
import {
  findRow,
  rowElement,
  waitForRequest,
  mountRoster,
  mountSelectedRoster,
  sessionRow,
  human,
  disposeRoster,
} from "./app-sidebar-freshness.test-support.ts";
import { setSessionsStatusFilter } from "./session-organizer-menu.runtime.ts";
import "./app-sidebar.tsx";

const mainAgents: AgentsListResult = makeBootRoster();
const ada = human("ada", "Ada");
const bob = human("bob", "Bob");
type Params = NonNullable<ReturnType<typeof asOptionalRecord>>;
function lineageRequest(
  list: (params: Params) => unknown,
  describe: (params: Params) => unknown,
  subscribe?: () => unknown,
) {
  return vi.fn(async (method: string, raw?: unknown) => {
    const handler =
      method === "sessions.list" ? list : method === "sessions.describe" ? describe : null;
    if (handler) {
      return handler(asOptionalRecord(raw) ?? {});
    }
    return method === "sessions.subscribe" && subscribe ? subscribe() : {};
  });
}
function mainRow(
  key: string,
  sessionId: string,
  updatedAt: number,
  fields: Partial<GatewaySessionRow> = {},
) {
  return sessionRow(key, sessionId, { agentId: "main", archived: false, updatedAt, ...fields });
}

function describeRow({ key }: Params, rows: GatewaySessionRow[]) {
  const session = rows.find((row) => row.key === key);
  if (!session) {
    throw new Error(`Unexpected describe key: ${String(key)}`);
  }
  return { session };
}

function selectChat(sidebar: SidebarLifecycleState, key: string) {
  sidebar.activeRouteId = "chat";
  sidebar.sessionKey = key;
}

function sessionTree(sidebar: SidebarLifecycleState, selected: string) {
  const row = (key: string) => rowElement(sidebar, key);
  const parent = () =>
    row(selected)
      ?.closest("[data-session-tree]")
      ?.parentElement?.closest("[data-session-tree]")
      ?.getAttribute("data-session-tree") ?? null;
  const expand = async (key: string) => {
    sidebar
      .querySelector<HTMLButtonElement>(
        `[data-child-session-toggle="${key}"][aria-expanded="false"]`,
      )
      ?.click();
    await sidebar.updateComplete;
  };
  const reveal = async (key: string) => {
    await waitForFast(() => expect(row(key)).not.toBeNull());
    await expand(key);
    await waitForFast(() => expect(parent()).toBe(key));
  };
  return { row, parent, expand, reveal };
}

it("hides a selected active main child in Archived after fresh lineage completes", async () => {
  const mainKey = "agent:main:main";
  const selected = mainRow("agent:main:selected-active", "selected-active", 10, {
    spawnedBy: mainKey,
  });
  const parent = mainRow(mainKey, "main-parent", 10, {
    childSessions: [selected.key],
  });
  const initialParent = deferred<{ session: GatewaySessionRow }>();
  const request = lineageRequest(
    (params) => sessionsResult(params.archived === true ? [] : [selected], 10),
    (params) => (params.key === mainKey ? initialParent.promise : describeRow(params, [selected])),
  );
  const { sidebar, provider, sessions, data } = await mountRoster(request, mainAgents);
  const row = () => rowElement(sidebar, selected.key);
  try {
    selectChat(sidebar, selected.key);
    await waitForRequest(request, "sessions.describe", { key: mainKey });
    await waitForFast(() => expect(row()).not.toBeNull());

    setSessionsStatusFilter(sidebar.sessionOrganizer, "archived");
    await waitForRequest(request, "sessions.list", { archived: true }, true);
    await waitForFast(() => expect(data.sessionsResult?.sessions).toEqual([]));
    await sidebar.updateComplete;
    expect(row()).toBeNull();

    initialParent.resolve({ session: parent });
    await waitForFast(() => expect(data.activeSessionLineageRoot?.key).toBe(mainKey));
    await sidebar.updateComplete;
    expect(sidebar.sessionKey).toBe(selected.key);
    expect(row()).toBeNull();

    await sessions.refresh({ agentId: "main", force: true });
    await sidebar.updateComplete;
    await data.loadActiveSessionLineage(selected.key);
    await sidebar.updateComplete;
    expect(data.activeSessionLineageSelectedRow?.key).toBe(selected.key);
    expect(data.sessionsResult?.sessions).toEqual([]);
    expect(row()).toBeNull();
  } finally {
    disposeRoster({ provider, sessions });
    initialParent.resolve({ session: parent });
    await sidebar.updateComplete;
  }
});

it.each([
  "pending incarnation",
  "known parent",
  "status-filtered omitted",
  "unfiltered metadata",
] as const)("%s preserves event ancestry through an unavailable primary read", async (mode) => {
  vi.useFakeTimers();
  const pendingIncarnation = mode === "pending incarnation";
  const knownParent = mode === "known parent";
  const failedMode = mode === "status-filtered omitted" || mode === "unfiltered metadata";
  const filtered = mode !== "unfiltered metadata";
  const key = "agent:main:event-child";
  const p1 = "agent:main:original-parent";
  const p2 = "agent:main:successor-parent";
  const expectedParent = knownParent || mode === "status-filtered omitted" ? p2 : p1;
  const initialAt = failedMode ? Date.now() - 100 : 10;
  const child = mainRow(key, "original-child", initialAt, {
    parentSessionKey: p1,
    label: "Original selected conversation",
    owner: { actor: failedMode ? bob : ada },
    ...(failedMode ? { spawnedBy: p1, status: "done" } : {}),
  });
  const oldParent = mainRow(p1, "original-parent", initialAt - (failedMode ? 10 : 5), {
    childSessions: [key],
    label: "Original ancestor",
    owner: { actor: failedMode ? ada : bob },
  });
  const newParent = {
    ...oldParent,
    key: p2,
    sessionId: "successor-parent",
    label: "Successor ancestor",
    owner: { actor: knownParent ? ada : bob },
  };
  const freshParent = { ...oldParent, label: "Current ancestor", updatedAt: 30 };
  const oldParentRead = deferred<{ session: GatewaySessionRow }>();
  const primary = deferred<SessionsListResult>();
  let current = child;
  let changed = false;
  let primaryReleased = false;
  let recovery = false;
  let failedLists = false;
  let parentReads = 0;
  let primaryFailures = 0;
  let managedFailures = 0;
  const primaryRows = () =>
    failedMode
      ? !filtered || recovery
        ? [oldParent, current]
        : [oldParent]
      : knownParent
        ? [current, newParent]
        : [current];
  const result = (rows = primaryRows()) => ({
    ...sessionsResult(rows, current.updatedAt ?? initialAt),
    owners: [ada, bob],
  });
  const request = lineageRequest(
    (params) => {
      if (params.spawnedBy === p1 || params.spawnedBy === p2) {
        return failedMode
          ? result([current])
          : sessionsResult(changed && knownParent && params.spawnedBy === p1 ? [] : [current], 30);
      }
      const managed = params.archived === "all";
      if (failedLists) {
        if (managed) {
          managedFailures += 1;
        } else {
          primaryFailures += 1;
        }
        throw new Error(`Synthetic ${managed ? "managed" : "primary"} refresh failure`);
      }
      if (managed) {
        return result(failedMode ? [oldParent] : primaryRows());
      }
      return changed && !failedMode && !primaryReleased ? primary.promise : result();
    },
    (params) => {
      if (params.key === p1) {
        parentReads += 1;
        if (pendingIncarnation && parentReads === 1) {
          return oldParentRead.promise;
        }
      }
      return describeRow(params, [
        current,
        pendingIncarnation ? freshParent : oldParent,
        newParent,
      ]);
    },
    () => ({ subscribed: true, list: result() }),
  );
  const { sidebar, provider, sessions, harness, data } = await mountRoster(
    request,
    mainAgents,
    ada,
  );
  const { row, parent: directParent, expand, reveal } = sessionTree(sidebar, key);
  let originalLineage: Promise<void> | undefined;
  try {
    if (filtered) {
      await activateSessionMenuValue(sidebar, "status:all");
      await waitForFast(() => {
        expect(data.sessionsLoading).toBe(false);
        expect(data.sessionsResult?.sessions.map((entry) => entry.key)).toEqual(
          failedMode ? [p1] : knownParent ? [key, p2] : [key],
        );
      });
    }
    selectChat(sidebar, key);
    if (failedMode) {
      await waitForFast(() => expect(data.activeSessionLineageRoot?.key).toBe(p1));
      await expand(p1);
      await waitForFast(() => {
        expect(data.loadingChildSessionKeys.has(p1)).toBe(false);
        expect(directParent()).toBe(p1);
        expect(row(key)?.textContent).toContain(child.label);
      });
    } else {
      await waitForFast(() => expect(parentReads).toBe(1));
      originalLineage = data.loadActiveSessionLineage(key);
      if (!pendingIncarnation) {
        await originalLineage;
        await reveal(p1);
      }
    }
    const originalRevision = sessions.canonicalListRevision;
    changed = true;
    failedLists = failedMode;
    current = {
      ...child,
      sessionId: pendingIncarnation ? "successor-child" : child.sessionId,
      parentSessionKey: expectedParent,
      label: "Current selected conversation",
      updatedAt: failedMode ? Date.now() : 30,
    };
    harness.publishEvent("sessions.changed", {
      ...current,
      sessionKey: key,
      reason: "create",
      ts: current.updatedAt,
      ...(failedMode ? { hasActiveRun: false, activeRunIds: [] } : { session: current }),
    });
    await vi.advanceTimersByTimeAsync(5_000);
    const fields = {
      sessionId: current.sessionId,
      parentSessionKey: expectedParent,
      label: current.label,
    };
    await waitForFast(() => {
      if (!failedMode) {
        expect(data.sessionsLoading).toBe(false);
      }
      expect(
        failedMode ? findRow(sessions.state.result, key) : data.sessionsResult?.sessions[0],
      ).toMatchObject(fields);
    });
    if (failedMode) {
      await waitForFast(() => {
        expect(primaryFailures).toBeGreaterThan(0);
        if (filtered) {
          expect(managedFailures).toBeGreaterThan(0);
        }
      });
      await sidebar.updateComplete;
      expect(sessions.canonicalListRevision).toBe(originalRevision);
      if (filtered) {
        expect(data.sessionsResult?.sessions.map((entry) => entry.key)).toEqual([p1]);
      }
      await waitForFast(() => expect(row(key)?.textContent).toContain(current.label));
      await reveal(expectedParent);
    } else {
      expect(sessions.canonicalListRevision).toBe(originalRevision);
      await sidebar.updateComplete;
      if (pendingIncarnation) {
        await waitForFast(() => expect(parentReads).toBe(2));
      }
      await data.loadActiveSessionLineage(key);
      await sidebar.updateComplete;
      await expand(expectedParent);
      expect(sidebar.findSidebarSessionByKey(key)?.sessionId).toBe(current.sessionId);
      expect(row(key)?.textContent?.replace(/\s+/g, " ").trim()).toContain(current.label);
      expect(directParent()).toBe(expectedParent);
      expect(row(p2) !== null).toBe(knownParent);
      if (knownParent) {
        expect(row(p1)).toBeNull();
      }
      if (pendingIncarnation) {
        oldParentRead.resolve({ session: oldParent });
        await originalLineage;
        await sidebar.updateComplete;
        expect(row(p1)?.textContent).toContain("Current ancestor");
        expect(sidebar.findSidebarSessionByKey(key)?.sessionId).toBe(current.sessionId);
      }
    }
    if (failedMode) {
      failedLists = false;
      recovery = true;
      await sessions.refresh({ agentId: "main", force: true });
      if (filtered) {
        await data.refreshSidebarSessions();
      }
      await waitForFast(() => expect(row(expectedParent)).not.toBeNull());
      await expand(expectedParent);
      await waitForFast(() => {
        expect(row(key)?.textContent).toContain(current.label);
        expect(directParent()).toBe(expectedParent);
      });
    } else {
      primaryReleased = true;
      primary.resolve(result());
      await waitForFast(() =>
        expect(sessions.canonicalListRevision).toBeGreaterThan(originalRevision),
      );
      await reveal(expectedParent);
    }
  } finally {
    if (failedMode) {
      vi.useRealTimers();
    }
    failedLists = false;
    primaryReleased = true;
    primary.resolve(result());
    oldParentRead.resolve({ session: oldParent });
    disposeRoster({ provider, sessions });
    await originalLineage;
  }
});

it("resolves the routed child's former global ancestor over a foreign cached row", async () => {
  const agentsList = {
    ...mainAgents,
    agents: [{ id: "main" }, { id: "work" }, { id: "research" }],
  } satisfies AgentsListResult;
  const parent = mainRow("global", "owned-parent-session", 1, {
    agentId: "work",
    kind: "global",
    label: "Owned parent conversation",
  });
  const child = mainRow(
    "agent:work:dashboard:20000000-0000-4000-8000-000000000001",
    "work-fork-session",
    1_000,
    {
      agentId: "work",
      label: "Selected Work fork",
      parentSessionKey: parent.key,
    },
  );
  const foreign: GatewaySessionRow = {
    ...parent,
    agentId: "main",
    sessionId: "main-global-session",
    label: "Foreign Main conversation",
    updatedAt: 900,
  };
  const workRows = [
    child,
    ...Array.from({ length: 199 }, (_, index): GatewaySessionRow => ({
      key: `agent:work:dashboard:30000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      agentId: "work",
      sessionId: `work-page-${index}`,
      kind: "direct",
      updatedAt: 500 - index,
      archived: false,
    })),
  ];
  const workPage: SessionsListResult = {
    ...sessionsResult(workRows, 2_000),
    totalCount: workRows.length + 1,
    limitApplied: 200,
    hasMore: true,
    nextOffset: 200,
  };
  const requireRecord = createRequireRecord("object", "expected-label");
  const request = vi.fn(async (method: string, raw?: unknown) => {
    if (method === "sessions.subscribe") {
      return { subscribed: true };
    }
    if (method === "sessions.groups.list") {
      return { groups: [], sectionOrder: [] };
    }
    if (method === "models.list") {
      return { models: [] };
    }
    const params = requireRecord(raw, `${method} params`);
    if (method === "sessions.list") {
      if (params.spawnedBy) {
        return sessionsResult(
          params.spawnedBy === parent.key && (!params.agentId || params.agentId === child.agentId)
            ? [child]
            : [],
          2_000,
        );
      }
      if (params.agentId === "work") {
        return workPage;
      }
      expect(params.agentId).toBeUndefined();
      return {
        ...workPage,
        ...sessionsResult([child, foreign, ...workRows.slice(1, 199)], 2_001),
      };
    }
    if (method === "sessions.describe") {
      if (params.key === child.key) {
        return { session: child };
      }
      expect(params.key).toBe(parent.key);
      if (!params.agentId) {
        throw new Error(
          'Multiple agents are configured, but session key "global" has no explicit owner. Pass agentId or use an agent-prefixed session key.',
        );
      }
      expect(params.agentId === undefined || params.agentId === parent.agentId).toBe(true);
      return { session: parent };
    }
    throw new Error(`Unexpected Gateway method: ${method}`);
  });
  const harness = createGatewayHarness(createTestGatewayClient(request));
  const { gateway } = harness;
  harness.publish({
    hello: {
      ...gatewayHelloForMethods(["sessions.list", "sessions.describe", "sessions.subscribe"]),
      snapshot: {
        sessionDefaults: {
          defaultAgentId: "main",
          mainKey: "main",
          mainSessionKey: "agent:main:main",
        },
      },
    },
    sessionKey: "agent:work:main",
  });
  const { provider, sidebar, sessions, selection, data } = await mountSelectedRoster(
    harness,
    agentsList,
    "work",
  );
  sidebar.connected = true;
  try {
    harness.publish({});
    await waitForFast(() => expect(sessions.state.result?.sessions).toHaveLength(workRows.length));
    expect(sessions.state.agentId).toBe("work");

    // Startup recovery can publish an unscoped primary snapshot while Work stays selected.
    await sessions.refresh({ force: true, backgroundHydrate: true });
    expect(sessions.state.agentId).toBeNull();
    expect(sessions.state.result?.sessions.find((row) => row.key === "global")?.agentId).toBe(
      "main",
    );
    expect(selection.state.selectedId).toBe("work");

    selectApplicationSession({ selection, gateway, sessionKey: child.key });
    selectChat(sidebar, child.key);
    await data.loadActiveSessionLineage(child.key);
    await sidebar.updateComplete;
    // Reveal the loaded section without fetching the next Gateway page.
    for (let page = 0; page < 20; page += 1) {
      const showMore = sidebar.querySelector<HTMLButtonElement>(
        '.sidebar-session-pagination__button[aria-label="Show more"]',
      );
      if (!showMore) {
        break;
      }
      showMore.click();
      await sidebar.updateComplete;
    }
    expect(
      sidebar.querySelector('.sidebar-session-pagination__button[aria-label="Show more"]'),
    ).toBeNull();

    expect(
      sessions.state.result?.sessions.some(
        (row) => row.key === parent.key && row.agentId === parent.agentId,
      ),
    ).toBe(false);

    const parentRow = rowElement(sidebar, parent.key);
    expect.soft(parentRow?.textContent ?? "").toContain(parent.label);
    expect.soft(sidebar.textContent).not.toContain(foreign.label);
    expect(rowElement(sidebar, child.key)?.textContent ?? "").toContain(child.label);
    expect(sidebar.sessionKey).toBe(child.key);
    expect(selection.state.selectedId).toBe("work");
  } finally {
    disposeRoster({ provider, sessions });
    await sidebar.updateComplete;
  }
});
