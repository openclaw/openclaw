import { describe, expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import { rosterActivityStore } from "../../lib/agents/roster-activity-store.ts";
import { createGatewayHarness, type TestSessionMenu } from "../app-sidebar.ts";
import { createTestGatewayClient } from "../gateway-client.ts";
import { settleLitElement } from "../lit-settle.ts";
import { waitForFast } from "../wait-for.ts";
import { mountRoster, roster, session } from "./roster.test-support.ts";
import { sessionFixture, expectAbsent, describedText } from "./session-suite.test-support.ts";

const parentKey = "agent:main:dashboard:release";
const runKey = "agent:main:subagent:review";
const ring = ".session-glyph__ring";
const workingRing = `${ring}[aria-label="Subagents working"]`;

function delegation(
  parent: string,
  child: string,
  running = true,
): [Partial<GatewaySessionRow>, Partial<GatewaySessionRow>] {
  return [
    {
      key: parent,
      label: "Prepare release",
      status: "done",
      hasActiveRun: false,
      childSessions: [child],
    },
    {
      key: child,
      label: "Review changes",
      spawnedBy: parent,
      status: running ? "running" : "done",
      hasActiveRun: running,
    },
  ];
}

function runFixture(parent = parentKey, child = runKey, running = true, hidden = false) {
  const fixture = sessionFixture(hidden ? [parent] : [parent, child]);
  const [parentFields, childFields] = delegation(parent, child, running);
  const parentRow: GatewaySessionRow = Object.assign(fixture.row(parent), parentFields);
  const runRow: GatewaySessionRow = Object.assign(
    hidden ? { key: child, kind: "direct" as const, updatedAt: 2 } : fixture.row(child),
    childFields,
  );
  if (hidden) {
    fixture.list.mockResolvedValue({ ...fixture.result, sessions: [runRow] });
  }
  return { ...fixture, parentRow, runRow };
}

async function runRoster(rows: GatewaySessionRow[], parent: string) {
  const mounted = await mountRoster(
    roster,
    rows,
    undefined,
    rows,
    [],
    rows.filter((row) => row.key !== parent),
  );
  mounted.sidebar.sidebarAgentsMode = "roster";
  return mounted;
}

function expectHidden(sidebar: ParentNode, ...keys: string[]) {
  expectAbsent(sidebar, ...keys.map((key) => `[data-session-key="${key}"]`));
}

describe("AppSidebar delegated activity", () => {
  it("loads hidden subagent activity for the selected parent without adding navigation rows", async () => {
    const parent = "agent:main:review-parent";
    const child = "agent:main:subagent:review-child";
    const sessions = runFixture(parent, child, true, true);
    sessions.parentRow.label = "Review release";
    const gateway = createGatewayHarness(
      createTestGatewayClient(async () => ({ session: sessions.parentRow })),
    );
    const { sidebar, query } = await sessions.mount(gateway.gateway);
    sidebar.activeRouteId = "chat";
    sidebar.sessionKey = parent;
    await waitForFast(() => expect(query(parent, workingRing)).not.toBeNull());
    expectHidden(sidebar, child);
    expectAbsent(sidebar, "[data-child-session-toggle]");

    const finished = {
      ...sessions.runRow,
      status: "done" as const,
      hasActiveRun: false,
      updatedAt: 3,
    };
    sessions.list.mockResolvedValue({ ...sessions.result, ts: 3, sessions: [finished] });
    vi.useFakeTimers();
    gateway.publishEvent("sessions.changed", { sessionKey: child, session: finished });
    await vi.advanceTimersByTimeAsync(5_000);
    await waitForFast(() => expect(query(parent, ring)).toBeNull());
  });

  it("keeps subagent runs out of the session tree while preserving parent activity and failure attention", async () => {
    const sessions = runFixture();
    const { parentRow, runRow, result } = sessions;
    const { sidebar, provider, query } = await sessions.mount();
    const expectHiddenRun = () => {
      expectHidden(sidebar, runKey);
      expectAbsent(sidebar, "[data-child-session-toggle], [data-show-more-children]");
      expect(sessions.list).not.toHaveBeenCalled();
    };
    expect(query(parentKey, workingRing)).not.toBeNull();
    expect(query(parentKey)?.classList.contains("session-row-host--running")).toBe(true);
    expectHiddenRun();

    const failedRun: GatewaySessionRow = {
      ...runRow,
      hasActiveRun: false,
      status: "failed",
      endedAt: 3,
      updatedAt: 3,
      lastRunError: "Review failed",
    };
    sessions.publishList({ result: { ...result, ts: 3, sessions: [parentRow, failedRun] } });
    await settleLitElement(sidebar);
    expect(query(parentKey, ring)).toBeNull();
    const attention = query(parentKey, '[data-session-attention="error"]')!;
    expect(attention).not.toBeNull();
    await attention.closest<HTMLElementTagNameMap["openclaw-tooltip"]>("openclaw-tooltip")!
      .updateComplete;
    const description = describedText(attention);
    expect(description).toContain("Child session Review changes failed: Review failed");
    expectHiddenRun();
    provider.remove();

    const persistentKey = "agent:main:dashboard:implementation";
    const rows = [
      { ...parentRow, agentId: "main", unread: false, childSessions: [runKey, persistentKey] },
      { ...runRow, agentId: "main", unread: true },
      session("main", 2, {
        key: persistentKey,
        isMain: false,
        spawnedBy: parentKey,
        label: "Implement release",
        status: "done",
        hasActiveRun: false,
      }),
    ];
    const mixed = await runRoster(rows, parentKey);
    const agent = () => mixed.sidebar.querySelector('[data-agent-group="main"]')!;
    const avatarRing = () => agent().querySelector(`.sidebar-agent-roster__avatar ${ring}`);
    await waitForFast(() => expect(agent()).not.toBeNull(), { timeout: 5_000 });
    await waitForFast(() => expect(avatarRing()).not.toBeNull(), { timeout: 5_000 });
    expectAbsent(mixed.sidebar, "[data-agent-collapse]");
    expectHidden(mixed.sidebar, parentKey, runKey, persistentKey);

    mixed.result.ts += 1;
    mixed.result.sessions = [rows[0]!, { ...failedRun, agentId: "main", unread: true }, rows[2]!];
    mixed.sessions.publishList({ result: mixed.result });
    await rosterActivityStore(mixed.context).refresh();
    await waitForFast(() => expect(avatarRing()).toBeNull(), { timeout: 5_000 });
    expectHidden(mixed.sidebar, runKey);
    expect(mixed.sidebar.querySelectorAll(".sidebar-recent-session--child")).toHaveLength(0);
  });

  it("offers Mark as read on a read parent whose only unread state is a hidden run", async () => {
    const sessions = runFixture(parentKey, runKey, false);
    sessions.parentRow.unread = false;
    sessions.runRow.unread = true;
    const { sidebar, query } = await sessions.mount();
    sidebar.connected = true;
    await sidebar.updateComplete;
    expectHidden(sidebar, runKey);
    query(parentKey)!.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
    );
    await sidebar.updateComplete;
    const menu = sidebar.querySelector<TestSessionMenu>("openclaw-session-menu")!;
    await menu.updateComplete;
    const toggle = menu.querySelector<HTMLButtonElement>('[data-shortcut="u"]')!;
    expect(toggle.textContent).toContain("Mark as read");
    toggle.click();
    await waitForFast(() =>
      expect(sessions.patch).toHaveBeenCalledWith(
        runKey,
        { unread: false },
        expect.objectContaining({ expectedMarkedUnreadAt: null }),
      ),
    );
    expect(sessions.patch).not.toHaveBeenCalledWith(parentKey, { unread: true }, expect.anything());
  });

  it("keeps session actions out of the agent-only roster", async () => {
    const fields = delegation(parentKey, runKey, false);
    const rows = fields.map((row, index) =>
      session("main", 2 - index, {
        ...row,
        isMain: false,
        unread: index === 1,
      }),
    );
    const { sidebar } = await runRoster(rows, parentKey);
    await waitForFast(() =>
      expect(sidebar.querySelector('[data-agent-group="main"]')).not.toBeNull(),
    );
    expectHidden(sidebar, parentKey, runKey);
    expectAbsent(sidebar, "openclaw-session-menu");
  });

  it("rings a queued parent and its idle child while a grandchild works", async () => {
    const parent = "agent:main:queued-parent";
    const child = "agent:main:delegating-child";
    const sessions = sessionFixture([parent]);
    Object.assign(sessions.row(parent), {
      hasActiveRun: true,
      status: "queued",
      childSessions: [child],
    });
    sessions.list.mockResolvedValue({
      ...sessions.result,
      sessions: [
        {
          key: child,
          spawnedBy: parent,
          kind: "direct",
          label: "Delegating child",
          updatedAt: 2,
          status: "done",
          hasActiveRun: false,
          hasActiveSubagentRun: true,
          childSessions: ["agent:main:subagent:grandchild"],
        },
      ],
    });
    const { sidebar, query } = await sessions.mount();
    const toggle = () =>
      sidebar.querySelector<HTMLButtonElement>(`[data-child-session-toggle="${parent}"]`)!.click();
    toggle();
    await waitForFast(() => {
      for (const key of [parent, child]) {
        expect(query(key, workingRing)).not.toBeNull();
        expect(query(key, ".session-glyph__ring--queued")).toBeNull();
      }
    });
    toggle();
    await sidebar.updateComplete;
    expectHidden(sidebar, child);
    expect(query(parent, ring)).not.toBeNull();
  });
});
