import { describe, expect, it } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import { createGatewayHarness, createSessionsHarness, mountSidebar } from "../app-sidebar.ts";
import { waitForFast } from "../wait-for.ts";
import { sidebarDriver } from "./sidebar-driver.test-support.ts";
import "../../components/app-sidebar.tsx";

const runningRow = (key: string, updatedAt: number): GatewaySessionRow => ({
  key,
  kind: "direct",
  updatedAt,
  startedAt: updatedAt,
  status: "running",
  hasActiveRun: true,
});

const NARRATED_KEY = "agent:main:narrated";
const narrationOptions = { agentId: undefined, mode: "narration" };

async function mountNarration(
  rows = [runningRow(NARRATED_KEY, 5)],
  preview = true,
  openKey?: string,
) {
  const gateway = createGatewayHarness({} as GatewayBrowserClient);
  const sessions = createSessionsHarness(
    "main",
    rows.map((row) => row.key),
  );
  const seed = sessions.sessions.state.result!;
  const publishRows = (nextRows: GatewaySessionRow[]) =>
    sessions.publishList({
      result: { ...seed, ts: 10, count: nextRows.length, sessions: nextRows },
      agentId: "main",
    });
  publishRows(rows);
  const { sidebar } = await mountSidebar(gateway.gateway, sessions.sessions);
  const dom = sidebarDriver(sidebar);
  if (openKey) {
    sidebar.activeRouteId = "chat";
    sidebar.sessionKey = openKey;
  }
  sidebar.sessionOrganizer.setSessionsShowPreview(preview);
  await dom.update({ connected: true });
  const row = () => sidebar.querySelector(`[data-session-key="${rows[0]!.key}"]`);
  const subtitle = () => row()?.querySelector(".sidebar-recent-session__subtitle");
  const narrate = (text: string) =>
    gateway.publishEvent("session.narration", {
      sessionKey: NARRATED_KEY,
      runId: "narrated-run",
      text,
    });
  return { gateway, sessions, publishRows, sidebar, dom, row, subtitle, narrate };
}

describe("AppSidebar live narration", () => {
  it("shows tool identity and progress only when the row has a preview line", async () => {
    const { gateway, sessions, sidebar, row, subtitle } = await mountNarration(undefined, false);
    const toolRun = { sessionKey: NARRATED_KEY, runId: "run-tool" };
    const tool = () => row()?.querySelector(".sidebar-session-tool");
    await waitForFast(() => expect(sessions.subscribeMessages).toHaveBeenCalledTimes(1));
    gateway.publishEvent("session.tool", {
      ...toolRun,
      stream: "tool",
      data: { name: "exec", toolCallId: "call-tool", phase: "start" },
    });
    gateway.publishEvent("agent", {
      ...toolRun,
      stream: "item",
      data: {
        kind: "tool",
        itemId: "tool:call-tool",
        name: "exec",
        toolCallId: "call-tool",
        phase: "update",
        progressText: "Running focused tests",
      },
    });
    await sidebar.updateComplete;
    expect(row()?.classList.contains("sidebar-recent-session--single-line")).toBe(true);
    expect(tool()).toBeNull();
    expect(subtitle()).toBeNull();
    sidebar.sessionOrganizer.setSessionsShowPreview(true);
    await sidebar.updateComplete;
    expect(tool()?.getAttribute("aria-label")).toBe("Tool: exec");
    expect(subtitle()?.textContent).toBe("Running focused tests");
    expect(row()?.classList.contains("sidebar-recent-session--single-line")).toBe(false);
    expect(
      row()?.querySelector(".sidebar-recent-session__title-row .sidebar-session-tool"),
    ).toBeNull();
    expect(tool()?.closest(".sidebar-recent-session__details")).not.toBeNull();
    sidebar.sessionOrganizer.setSessionsShowPreview(false);
    await sidebar.updateComplete;
    expect(tool()).toBeNull();
    expect(subtitle()).toBeNull();
  });

  it.each([
    ["roster", { sidebarAgentsMode: "roster" }],
    ["pages", { navigationView: "pages" }],
    ["online", { navigationView: "online" }],
    ["collapsed", { navigationCollapsed: true }],
    ["hidden", { navigationVisible: false }],
  ] as const)(
    "releases narration while %s hides its consumer and resumes visible previews",
    async (_hidden, properties) => {
      const { sessions, sidebar, dom, subtitle, narrate } = await mountNarration();
      await waitForFast(() => expect(sessions.subscribeMessages).toHaveBeenCalledTimes(1));

      Object.assign(sidebar, properties);
      sidebar.invalidate();
      await dom.update();
      expect(sessions.unsubscribeMessages).toHaveBeenCalledTimes(1);

      Object.assign(sidebar, {
        sidebarAgentsMode: "chip",
        navigationCollapsed: false,
        navigationVisible: true,
        navigationView: "sessions",
      });
      sidebar.invalidate();
      await sidebar.updateComplete;
      await waitForFast(() => expect(sessions.subscribeMessages).toHaveBeenCalledTimes(2));
      narrate("Visible work resumed.");
      await sidebar.updateComplete;
      expect(subtitle()?.textContent).toBe("Visible work resumed.");
    },
  );

  it("subscribes for a running row, renders prose, and cleans up when the run ends", async () => {
    const { sessions, sidebar, row, subtitle, publishRows, narrate } = await mountNarration();

    await waitForFast(() => expect(sessions.subscribeMessages).toHaveBeenCalledTimes(1));
    expect(sessions.subscribeMessages).toHaveBeenCalledWith(NARRATED_KEY, narrationOptions);
    narrate("# Earlier work\n\nChecked the inputs. Final **verification** is running.");

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
    const prose = "Checking the remaining files.";

    // Lazy narration drops pre-import events; republish until its consumer is ready.
    await waitForFast(() => {
      gateway.publishEvent("chat", {
        sessionKey: NARRATED_KEY,
        state: "delta",
        message: { role: "assistant", content: [{ type: "text", text: prose }] },
      });
      expect(subtitle()?.textContent).toBe(prose);
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
    expect(questionAttention?.getAttribute("aria-label")).toBe(
      "Waiting for your answer\nContinue?",
    );
    expect(
      questionAttention
        ?.closest("openclaw-tooltip")
        ?.querySelector(".sidebar-session-attention-tooltip__preview")?.textContent,
    ).toBe("Continue?");
    expect(subtitle()).toBeNull();
    expect(row()?.textContent).not.toContain(prose);
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
    const { sessions, sidebar, publishRows } = await mountNarration(rows);

    expect(sessions.subscribeMessages.mock.calls.map(([key]) => key).toSorted()).toEqual(
      keys.slice(1),
    );

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
    const { gateway, sessions, dom } = await mountNarration(
      [runningRow(openKey, 1), runningRow(backgroundKey, 2)],
      true,
      openKey,
    );

    await waitForFast(() => expect(sessions.subscribeMessages).toHaveBeenCalledTimes(2));
    for (const key of [openKey, backgroundKey]) {
      expect(sessions.subscribeMessages).toHaveBeenCalledWith(key, narrationOptions);
    }

    gateway.publish({ phase: "stopped" });
    await dom.update({ connected: false });
    await waitForFast(() => expect(sessions.unsubscribeMessages).toHaveBeenCalledTimes(2));

    gateway.publish({ phase: "connected" });
    await dom.update({ connected: true });
    await waitForFast(() => expect(sessions.subscribeMessages).toHaveBeenCalledTimes(4));
    expect(sessions.subscribeMessages.mock.calls.slice(2)).toEqual(
      expect.arrayContaining([
        [backgroundKey, narrationOptions],
        [openKey, narrationOptions],
      ]),
    );
  });
});
