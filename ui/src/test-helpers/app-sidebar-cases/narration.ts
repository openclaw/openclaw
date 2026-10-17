import { describe, expect, it } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { createGatewayHarness, createSessionsHarness, mountSidebar } from "../app-sidebar.ts";
import { waitForFast } from "../wait-for.ts";
import "../../components/app-sidebar.tsx";

function runningRow(key: string, updatedAt: number): GatewaySessionRow {
  return {
    key,
    kind: "direct",
    label: `Run ${updatedAt}`,
    updatedAt,
    startedAt: updatedAt,
    status: "running",
    hasActiveRun: true,
  };
}

const NARRATED_KEY = "agent:main:narrated";

function narrationFixtures(rows = [runningRow(NARRATED_KEY, 5)]) {
  const gateway = createGatewayHarness({} as GatewayBrowserClient);
  const sessions = createSessionsHarness(
    "main",
    rows.map((row) => row.key),
  );
  const publishRows = (nextRows: GatewaySessionRow[]) =>
    sessions.publishList({
      result: {
        ts: 10,
        path: "",
        count: nextRows.length,
        defaults: { modelProvider: null, model: null, contextTokens: null },
        sessions: nextRows,
      } satisfies SessionsListResult,
      agentId: "main",
    });
  publishRows(rows);
  return { gateway, sessions, publishRows, rowKey: rows[0]!.key };
}

async function mountNarration(fixtures = narrationFixtures(), preview = true) {
  const { gateway, sessions } = fixtures;
  const { sidebar } = await mountSidebar(gateway.gateway, sessions.sessions);
  sidebar.sessionOrganizer.setSessionsShowPreview(preview);
  sidebar.connected = true;
  await sidebar.updateComplete;
  const row = () => sidebar.querySelector(`[data-session-key="${fixtures.rowKey}"]`);
  const subtitle = () => row()?.querySelector(".sidebar-recent-session__subtitle");
  return { ...fixtures, sidebar, row, subtitle };
}

describe("AppSidebar live narration", () => {
  it("shows tool identity and progress only when the row has a preview line", async () => {
    const { gateway, sessions, sidebar, row, subtitle } = await mountNarration(undefined, false);
    await waitForFast(() => expect(sessions.subscribeMessages).toHaveBeenCalledTimes(1));
    gateway.publishEvent("session.tool", {
      sessionKey: NARRATED_KEY,
      runId: "run-tool",
      stream: "tool",
      data: { name: "exec", toolCallId: "call-tool", phase: "start" },
    });
    gateway.publishEvent("agent", {
      sessionKey: NARRATED_KEY,
      runId: "run-tool",
      stream: "item",
      data: {
        kind: "tool",
        itemId: "tool:call-tool",
        name: "exec",
        toolCallId: "call-tool",
        title: "Exec",
        phase: "update",
        progressText: "Running focused tests",
      },
    });
    await sidebar.updateComplete;
    expect(row()?.classList.contains("sidebar-recent-session--single-line")).toBe(true);
    expect(row()?.querySelector(".sidebar-session-tool")).toBeNull();
    expect(subtitle()).toBeNull();
    sidebar.sessionOrganizer.setSessionsShowPreview(true);
    await sidebar.updateComplete;
    expect(row()?.querySelector(".sidebar-session-tool")?.getAttribute("aria-label")).toBe(
      "Tool: exec",
    );
    expect(subtitle()?.textContent).toBe("Running focused tests");
    expect(row()?.classList.contains("sidebar-recent-session--single-line")).toBe(false);
    expect(
      row()?.querySelector(".sidebar-recent-session__title-row .sidebar-session-tool"),
    ).toBeNull();
    expect(
      row()?.querySelector(".sidebar-recent-session__details .sidebar-session-tool"),
    ).not.toBeNull();
    sidebar.sessionOrganizer.setSessionsShowPreview(false);
    await sidebar.updateComplete;
    expect(row()?.querySelector(".sidebar-session-tool")).toBeNull();
    expect(subtitle()).toBeNull();
  });

  it.each(["roster", "pages", "online", "collapsed", "hidden"] as const)(
    "releases narration while %s hides its consumer and resumes visible previews",
    async (hidden) => {
      const fixtures = narrationFixtures();
      const { sessions } = fixtures;
      let acquired = createDeferred();
      sessions.subscribeMessages.mockImplementation((subscribedKey) => {
        acquired.resolve();
        return Promise.resolve({ key: subscribedKey, agentId: null });
      });
      const { gateway, sidebar, subtitle } = await mountNarration(fixtures);
      await acquired.promise;
      expect(sessions.subscribeMessages).toHaveBeenCalledTimes(1);

      if (hidden === "roster") {
        sidebar.sidebarAgentsMode = "roster";
      } else if (hidden === "collapsed") {
        sidebar.navigationCollapsed = true;
      } else if (hidden === "hidden") {
        sidebar.navigationVisible = false;
      } else {
        sidebar.navigationView = hidden;
      }
      sidebar.invalidate();
      await sidebar.updateComplete;
      expect(sessions.unsubscribeMessages).toHaveBeenCalledTimes(1);

      acquired = createDeferred();
      sidebar.sidebarAgentsMode = "chip";
      sidebar.navigationCollapsed = false;
      sidebar.navigationVisible = true;
      sidebar.navigationView = "sessions";
      sidebar.invalidate();
      await sidebar.updateComplete;
      await acquired.promise;
      expect(sessions.subscribeMessages).toHaveBeenCalledTimes(2);
      gateway.publishEvent("session.narration", {
        sessionKey: NARRATED_KEY,
        runId: "visible-run",
        text: "Visible work resumed.",
      });
      await sidebar.updateComplete;
      expect(subtitle()?.textContent).toBe("Visible work resumed.");
    },
  );

  it("subscribes for a running row, renders prose, and cleans up when the run ends", async () => {
    const { gateway, sessions, sidebar, row, subtitle, publishRows } = await mountNarration();

    await waitForFast(() => expect(sessions.subscribeMessages).toHaveBeenCalledTimes(1));
    expect(sessions.subscribeMessages).toHaveBeenCalledWith(NARRATED_KEY, {
      agentId: undefined,
      mode: "narration",
    });

    gateway.publishEvent("session.narration", {
      sessionKey: NARRATED_KEY,
      runId: "narrated-run",
      text: "# Earlier work\n\nChecked the inputs. Final **verification** is running.",
    });

    await waitForFast(() => expect(subtitle()?.textContent).toBe("Final verification is running."));
    const link = row()?.querySelector(".sidebar-recent-session__link");
    expect(link?.hasAttribute("title")).toBe(false);
    expect(link?.querySelector("[aria-live]")).toBeNull();

    publishRows([
      { ...runningRow(NARRATED_KEY, 5), hasActiveRun: false, status: "done", endedAt: 20 },
    ]);
    await waitForFast(() => expect(sessions.unsubscribeMessages).toHaveBeenCalledTimes(1));
    await sidebar.updateComplete;
    expect(subtitle()).toBeNull();
  });

  it("gives a pending question attention priority over a running narration", async () => {
    const { gateway, sidebar, row, subtitle } = await mountNarration();

    // Republish inside the wait: the narration controller chunk loads lazily,
    // so an event raced before its import resolves is intentionally dropped.
    await waitForFast(() => {
      gateway.publishEvent("chat", {
        sessionKey: NARRATED_KEY,
        state: "delta",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Checking the remaining files." }],
        },
      });
      expect(subtitle()?.textContent).toBe("Checking the remaining files.");
    });

    gateway.publishEvent("question.requested", {
      id: "question-narration-priority",
      agentId: "main",
      sessionKey: NARRATED_KEY,
      questions: [{ questionId: "confirm", header: "Confirm", question: "Continue?", options: [] }],
      createdAtMs: Date.now(),
      expiresAtMs: Date.now() + 60_000,
      status: "pending",
    });
    await sidebar.updateComplete;

    const questionAttention = row()?.querySelector("[data-session-attention=question]");
    expect(questionAttention).not.toBeNull();
    expect(questionAttention?.getAttribute("aria-label")).toBe(
      "Waiting for your answer\nContinue?",
    );
    expect(
      questionAttention
        ?.closest("openclaw-tooltip")
        ?.querySelector(".sidebar-session-attention-tooltip__preview")?.textContent,
    ).toBe("Continue?");
    expect(subtitle()).toBeNull();
    expect(row()?.textContent).not.toContain("Checking the remaining files.");
    expect(row()?.querySelector(".sidebar-recent-session__link")?.hasAttribute("title")).toBe(
      false,
    );
  });

  it("retains six running subscriptions across recency changes and fills a settled slot", async () => {
    const keys = Array.from({ length: 7 }, (_, index) => `agent:main:run-${index + 1}`);
    const rows = keys.map((key, index) => ({
      ...runningRow(key, index + 1),
      startedAt: undefined,
    }));
    const { sessions, sidebar, publishRows } = await mountNarration(narrationFixtures(rows));

    expect(sessions.subscribeMessages).toHaveBeenCalledTimes(6);
    expect(sessions.subscribeMessages.mock.calls.map(([key]) => key)).toEqual(
      expect.arrayContaining(keys.slice(1)),
    );
    expect(sessions.subscribeMessages).not.toHaveBeenCalledWith(keys[0], expect.anything());

    const reordered = [{ ...rows[0]!, updatedAt: 100 }, ...rows.slice(1).toReversed()];
    publishRows(reordered);
    await sidebar.updateComplete;
    expect(sessions.subscribeMessages).toHaveBeenCalledTimes(6);
    expect(sessions.unsubscribeMessages).not.toHaveBeenCalled();

    const settled: GatewaySessionRow = { ...rows[1]!, hasActiveRun: false, status: "done" };
    publishRows(reordered.map((row) => (row.key === settled.key ? settled : row)));
    await sidebar.updateComplete;
    expect(sessions.unsubscribeMessages).toHaveBeenCalledTimes(1);
    expect(sessions.subscribeMessages).toHaveBeenCalledTimes(7);
    expect(sessions.unsubscribeMessages.mock.calls[0]?.[0]).toMatchObject({ key: keys[1] });
    expect(sessions.subscribeMessages.mock.calls.at(-1)?.[0]).toBe(keys[0]);
  });

  it("leases open and background running sessions again after reconnect", async () => {
    const openKey = "agent:main:open";
    const backgroundKey = "agent:main:background";
    const fixtures = narrationFixtures([runningRow(openKey, 1), runningRow(backgroundKey, 2)]);
    const { gateway, sessions } = fixtures;
    const { sidebar } = await mountSidebar(gateway.gateway, sessions.sessions);
    sidebar.activeRouteId = "chat";
    sidebar.sessionKey = openKey;
    sidebar.sessionOrganizer.setSessionsShowPreview(true);
    sidebar.connected = true;
    await sidebar.updateComplete;

    await waitForFast(() => expect(sessions.subscribeMessages).toHaveBeenCalledTimes(2));
    expect(sessions.subscribeMessages).toHaveBeenCalledWith(openKey, {
      agentId: undefined,
      mode: "narration",
    });
    expect(sessions.subscribeMessages).toHaveBeenCalledWith(backgroundKey, {
      agentId: undefined,
      mode: "narration",
    });

    gateway.publish({ phase: "stopped" });
    sidebar.connected = false;
    await sidebar.updateComplete;
    await waitForFast(() => expect(sessions.unsubscribeMessages).toHaveBeenCalledTimes(2));

    gateway.publish({ phase: "connected" });
    sidebar.connected = true;
    await sidebar.updateComplete;
    await waitForFast(() => expect(sessions.subscribeMessages).toHaveBeenCalledTimes(4));
    expect(sessions.subscribeMessages.mock.calls.slice(2)).toEqual(
      expect.arrayContaining([
        [backgroundKey, { agentId: undefined, mode: "narration" }],
        [openKey, { agentId: undefined, mode: "narration" }],
      ]),
    );
  });
});
