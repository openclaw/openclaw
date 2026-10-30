import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { ExecApprovalRequest } from "../../app/exec-approval.ts";
import { getAppSidebarOwner } from "../../components/app-sidebar.tsx";
import { setSessionsShowPreview } from "../../components/session-organizer-menu.runtime.ts";
import { rosterActivityStore } from "../../lib/agents/roster-activity-store.ts";
import {
  createGateway,
  createGatewayHarness,
  createSessionsHarness,
  mountSidebar,
  TWO_AGENTS,
} from "../app-sidebar.ts";
import { domProbe } from "../dom-probe.ts";
import { settleLitElement } from "../lit-settle.ts";
import { waitForFast } from "../wait-for.ts";
import {
  publishQuestion,
  confirmQuestion,
  approvalRequest,
  attentionLabel,
  sessionList,
} from "./compact.test-support.ts";
import { mountRoster, settleRoster } from "./roster.test-support.ts";

const sessionKey = "agent:main:attention";

function directRow(
  key: string,
  label: string,
  updatedAt: number,
  extra: Partial<GatewaySessionRow> = {},
): GatewaySessionRow {
  return { key, kind: "direct", label, updatedAt, ...extra };
}

function setRows(
  harness: ReturnType<typeof createSessionsHarness>,
  rows: GatewaySessionRow[],
): void {
  harness.publishList({ result: sessionList(rows) });
}

function failedRow(
  key = sessionKey,
  overrides: Partial<GatewaySessionRow> = {},
): GatewaySessionRow {
  return directRow(key, "Blocked investigation", 2, {
    endedAt: 2,
    status: "failed",
    lastRunError: "Provider credits exhausted",
    ...overrides,
  });
}

function agentAttentionRow(
  key = sessionKey,
  overrides: Partial<GatewaySessionRow> = {},
  attention: "key" | "hourglass" = "key",
): GatewaySessionRow {
  return failedRow(key, {
    agentStatus: {
      note: "Blocked: need the staging password",
      attention,
      expiresAt: Date.now() + 60_000,
    },
    ...overrides,
  });
}

async function errorDescription(container: ParentNode): Promise<string> {
  const attention = container.querySelector('[data-session-attention="error"]')!;
  await attention.closest("openclaw-tooltip")!.updateComplete;
  return (attention.getAttribute("aria-describedby") ?? "")
    .split(/\s+/u)
    .map((id) => attention.ownerDocument.getElementById(id)?.textContent ?? "")
    .join(" ");
}

function questionsGateway() {
  return createGatewayHarness({
    request: vi.fn().mockResolvedValue({ questions: [] }),
  } as unknown as GatewayBrowserClient);
}

async function mountAttention(
  rows: GatewaySessionRow[],
  gateway = createGateway({} as GatewayBrowserClient),
  agents: Parameters<typeof mountSidebar>[3] = null,
  approvals: readonly ExecApprovalRequest[] = [],
) {
  const sessions = createSessionsHarness("main", [rows[0]!.key]);
  setRows(sessions, rows);
  const mounted = await mountSidebar(gateway, sessions.sessions, "panel", agents, approvals);
  return {
    ...mounted,
    dom: domProbe(mounted.sidebar),
    sessions,
  };
}

function deploymentRow(): GatewaySessionRow {
  return directRow(sessionKey, "Deploy", 2, {
    agentStatus: { note: "Deploying to staging", expiresAt: Date.now() + 60_000 },
  });
}

function peerRow(updatedAt: number): GatewaySessionRow {
  return {
    key: "agent:main:peer",
    kind: "direct",
    updatedAt,
    worktree: { id: "peer", branch: "main", repoRoot: "/repo" },
  };
}

describe("AppSidebar session attention", () => {
  it("keeps an active waiting session hand-only and restores its ring after resolution", async () => {
    const gatewayHarness = questionsGateway();
    const { sidebar, dom } = await mountAttention(
      [
        directRow(sessionKey, "Waiting session", 2, {
          status: "running",
          hasActiveRun: true,
        }),
      ],
      gatewayHarness.gateway,
    );
    const row = dom.query(`[data-session-key="${sessionKey}"]`)!;
    expect(row.querySelector(".session-glyph__ring")).not.toBeNull();
    publishQuestion(gatewayHarness, "question-active", sessionKey, {
      questions: [confirmQuestion([{ label: "Continue" }])],
    });
    await settleLitElement(sidebar);
    expect(
      row.querySelector('[data-session-attention="question"]')?.getAttribute("aria-label"),
    ).toBe("Waiting for your answer\nContinue?");
    expect.soft(row.querySelector(".session-glyph__ring")).toBeNull();
    expect.soft(row.classList.contains("sidebar-recent-session--attention-amber")).toBe(false);
    gatewayHarness.publishEvent("question.resolved", {
      id: "question-active",
      status: "cancelled",
    });
    await settleLitElement(sidebar);
    expect(row.querySelector('[data-session-attention="question"]')).toBeNull();
    expect(row.querySelector(".session-glyph__ring")).not.toBeNull();
  });
  it("preserves diagnostic paths in failed-run previews", async () => {
    const { dom } = await mountAttention([
      failedRow(sessionKey, {
        lastRunError:
          "Cannot find module '/Users/example/.local/share/openclaw/dist/status-text-old.mjs' imported from /Users/example/.local/share/openclaw/dist/openclaw-tools-old.mjs",
      }),
    ]);
    const row = dom.query(`[data-session-key="${sessionKey}"]`)!;

    expect(await errorDescription(row)).toContain(
      "Cannot find module '/Users/example/.local/share/openclaw/dist/status-text-old.mjs' imported from /Users/example/.local/share/openclaw/dist/openclaw-tools-old.mjs",
    );
  });

  it("projects canonical main attention onto the agent header across row refresh ordering", async () => {
    const mainKey = "agent:main:main";
    const gatewayHarness = questionsGateway();
    const { sidebar, context, sessions, dom } = await mountAttention(
      [agentAttentionRow(mainKey)],
      gatewayHarness.gateway,
      TWO_AGENTS,
    );
    sidebar.connected = true;
    sidebar.sidebarAgentsMode = "roster";
    await settleRoster(sidebar);
    const publishRows = async (rows: GatewaySessionRow[]) => {
      setRows(sessions, rows);
      await rosterActivityStore(context).refresh();
      await settleRoster(sidebar);
    };
    const home = () => dom.query('[data-agent-group="main"] .sidebar-agent-roster__header');

    expect(home()?.querySelector('[data-session-attention="agent"]')).not.toBeNull();

    publishQuestion(gatewayHarness, "question-home", mainKey, {
      questions: [confirmQuestion([{ label: "Continue", description: "Resume the run." }])],
    });
    await settleLitElement(sidebar);
    expect(home()?.querySelector('[data-session-attention="question"]')).not.toBeNull();

    await publishRows([]);
    await settleLitElement(sidebar);
    expect(home()?.querySelector('[data-session-attention="question"]')).not.toBeNull();

    gatewayHarness.publishEvent("question.resolved", {
      id: "question-home",
      status: "cancelled",
    });
    await publishRows([
      failedRow(mainKey, {
        lastRunError: "⚠️ ✉️ Message failed:  delivery unavailable",
      }),
    ]);
    await settleLitElement(sidebar);
    expect(attentionLabel(home(), "error")).toBe(
      "Run failed:   Message failed:  delivery unavailable",
    );

    await publishRows([directRow(mainKey, "Home", 3, { status: "done" })]);
    await settleLitElement(sidebar);
    expect(home()?.querySelector("[data-session-attention]")).toBeNull();
  });

  it("shows question attention ahead of a run error and clears it on resolution", async () => {
    const gatewayHarness = questionsGateway();
    const { sidebar, dom } = await mountAttention([agentAttentionRow()], gatewayHarness.gateway);

    publishQuestion(gatewayHarness, "question-1", sessionKey, {
      questions: [confirmQuestion([{ label: "Continue", description: "Resume the run." }])],
    });
    await settleLitElement(sidebar);

    const questionAttention = dom.query('[data-session-attention="question"]');
    expect(questionAttention).toMatchObject({
      ariaLabel: "Waiting for your answer\nContinue?",
      tabIndex: 0,
    });
    expect(
      questionAttention
        ?.closest("openclaw-tooltip")
        ?.querySelector(".sidebar-session-attention-tooltip__preview")?.textContent,
    ).toBe("Continue?");
    expect(
      dom.query(`[data-session-key="${sessionKey}"] .sidebar-recent-session__subtitle`),
    ).toBeNull();
    expect(sidebar.textContent).not.toContain("Run failed:");

    gatewayHarness.publishEvent("question.resolved", {
      id: "question-1",
      status: "cancelled",
    });
    await settleLitElement(sidebar);
    expect(dom.query('[data-session-attention="question"]')).toBeNull();
    expect(attentionLabel(sidebar, "agent")).toBe("Blocked: need the staging password");
  });

  it("shows hourglass attention ahead of a run error", async () => {
    const { sidebar, dom } = await mountAttention([agentAttentionRow(sessionKey, {}, "hourglass")]);

    const glyph = dom.query<HTMLElement>('[data-session-attention="agent"] .session-css-icon');
    const mask = glyph?.style.maskImage.match(/data:image\/svg\+xml,([^"\s]+)"/u)?.[1];
    expect(mask).toBeDefined();
    const artwork = new DOMParser().parseFromString(decodeURIComponent(mask!), "image/svg+xml");
    expect(artwork.querySelector('circle[cx="12"][cy="12"][r="10"]')).not.toBeNull();
    expect(attentionLabel(sidebar, "agent")).toBe("Blocked: need the staging password");
    // The default sidebar keeps the note on the icon; it does not add a second line.
    expect(
      dom.query(`[data-session-key="${sessionKey}"] .sidebar-recent-session__subtitle`),
    ).toBeNull();
    expect(sidebar.textContent).not.toContain("Run failed:");
  });

  it("shows an unflagged agent status note in the subtitle slot", async () => {
    const { sidebar, dom } = await mountAttention([deploymentRow()]);

    setSessionsShowPreview(sidebar.sessionOrganizer, true);
    await settleLitElement(sidebar);
    expect(sidebar.textContent).toContain("Deploying to staging");
    expect(dom.query('[data-session-attention="agent"]')).toBeNull();
  });

  it("defaults to one line without hiding attention", async () => {
    const { sidebar, sessions, dom } = await mountAttention([deploymentRow()]);

    const previewRow = dom.query(`[data-session-key="${sessionKey}"]`);
    expect(previewRow?.textContent).not.toContain("Deploying to staging");
    expect(previewRow?.classList.contains("sidebar-recent-session--single-line")).toBe(true);

    setRows(sessions, [failedRow()]);
    await settleLitElement(sidebar);

    const attentionRow = dom.query(`[data-session-key="${sessionKey}"]`);
    expect(attentionRow?.classList.contains("sidebar-recent-session--single-line")).toBe(true);
    expect(attentionRow?.querySelector(".sidebar-recent-session__subtitle")).toBeNull();
    expect(
      attentionRow?.querySelector('[data-session-attention="error"]')?.getAttribute("aria-label"),
    ).toBe("Run failed: Provider credits exhausted");
    expect(sidebar.findSidebarHovercardRowByKey(sessionKey)?.attention).toEqual({
      kind: "error",
      reason: "Provider credits exhausted",
      sourceSessionKey: sessionKey,
    });
  });

  it("keeps status expiry retired through queued updates after disconnect", async () => {
    vi.useFakeTimers();
    const { sidebar, provider, sessions, dom } = await mountAttention([agentAttentionRow()]);
    expect(dom.query('[data-session-attention="agent"]')).not.toBeNull();

    const owner = getAppSidebarOwner(sidebar.hostElement)!;
    sidebar.invalidate();
    provider.remove();
    await settleLitElement(sidebar);
    const invalidate = vi.spyOn(owner, "invalidate");
    await vi.advanceTimersByTimeAsync(60_001);
    expect(invalidate).not.toHaveBeenCalled();

    document.body.append(provider);
    await settleLitElement(sidebar);
    expect(dom.query('[data-session-attention="agent"]')).toBeNull();

    setRows(sessions, [agentAttentionRow()]);
    await settleLitElement(sidebar);
    expect(dom.query('[data-session-attention="agent"]')).not.toBeNull();
    await vi.advanceTimersByTimeAsync(60_001);
    expect(dom.query('[data-session-attention="agent"]')).toBeNull();
  });

  it.each(["exec", "plugin"] as const)("prioritizes %s approvals over run errors", async (kind) => {
    const approval = approvalRequest(sessionKey, {
      kind,
      pluginTitle: kind === "exec" ? undefined : "Enable the calendar plugin",
    });
    const { sidebar, dom } = await mountAttention([failedRow()], undefined, null, [approval]);

    const indicator = dom.query('[data-session-attention="approval"]');
    expect(indicator?.getAttribute("aria-label")).toBe(
      `Waiting for approval\n${kind === "exec" ? "git status" : "Enable the calendar plugin"}`,
    );
    expect(indicator?.getAttribute("tabindex")).toBe("0");
    const row = dom.query(`[data-session-key="${sessionKey}"]`);
    expect(row?.classList.contains("sidebar-recent-session--single-line")).toBe(true);
    expect(row?.querySelector(".sidebar-recent-session__subtitle")).toBeNull();
    expect(sidebar.textContent).not.toContain("Run failed:");
  });

  it("uses canonical main attention without duplicating the agent header approval badge", async () => {
    const mainKey = "agent:main:main";
    const approval = approvalRequest(mainKey, { id: "approval-main" });
    const { sidebar } = await mountSidebar(
      createGateway({} as GatewayBrowserClient),
      createSessionsHarness("main", [mainKey]).sessions,
      "panel",
      TWO_AGENTS,
      [approval],
    );
    const dom = domProbe(sidebar);

    sidebar.connected = true;
    sidebar.sidebarAgentsMode = "roster";
    await settleRoster(sidebar);
    const homeAttention = dom.query(
      '[data-agent-group="main"] .sidebar-agent-roster__header [data-session-attention="approval"]',
    );
    expect(homeAttention).not.toBeNull();
    expect(
      homeAttention
        ?.closest("openclaw-tooltip")
        ?.querySelector(".sidebar-session-attention-tooltip__preview")?.textContent,
    ).toBe("git status");

    expect(dom.attr(".sidebar-workspace-header__main", "aria-label")).not.toContain(
      "pending approval",
    );
  });

  it("keeps a read failure dismissed after the sessions list refreshes", async () => {
    const { sidebar, sessions, dom } = await mountAttention([failedRow()]);

    expect(dom.query('[data-session-attention="error"]')).not.toBeNull();
    setRows(sessions, [failedRow(sessionKey, { lastReadAt: 2 })]);
    await settleLitElement(sidebar);

    expect(dom.query('[data-session-attention="error"]')).toBeNull();
    expect(sidebar.textContent).not.toContain("Run failed:");
  });

  it("attributes a nested failure to its child session while its ancestors continue", async () => {
    const parentKey = "agent:main:release";
    const childKey = "agent:main:subagent:validation";
    const failedKey = "agent:main:subagent:review";
    const rows = [
      directRow(parentKey, "Release preparation", 4, {
        status: "done",
        childSessions: [childKey],
      }),
      directRow(childKey, "Validate candidate", 3, {
        status: "running",
        hasActiveRun: true,
        spawnedBy: parentKey,
        childSessions: [failedKey],
      }),
      failedRow(failedKey, { label: "Source review", spawnedBy: childKey }),
    ].map((row) => Object.assign({}, row, { agentId: "main" }));
    const { sidebar, sessions, result, context } = await mountRoster(TWO_AGENTS, rows);
    const dom = domProbe(sidebar);
    const parentRow = () => dom.query(`[data-session-key="${parentKey}"]`)!;
    const childFailure = "Child session Source review failed: Provider credits exhausted";
    const description = await errorDescription(parentRow());
    expect(description).toContain(childFailure);
    expect(description).not.toContain("Run failed:");

    sidebar.sidebarAgentsMode = "roster";
    const agentHeader = () => dom.query('[data-agent-group="main"] .sidebar-agent-roster__header');
    await waitForFast(() => {
      expect(
        dom.query(`openclaw-sidebar-agent-roster [data-session-key="${parentKey}"]`),
      ).toBeNull();
      expect(
        agentHeader()
          ?.querySelector('[data-session-attention="error"]')
          ?.closest('[role="img"]')
          ?.getAttribute("aria-label"),
      ).toBe(childFailure);
    });

    result.sessions = rows.map((row) =>
      row.key === failedKey ? Object.assign({}, row, { lastReadAt: 2 }) : row,
    );
    setRows(sessions, result.sessions);
    await rosterActivityStore(context).refresh();
    await waitForFast(() => {
      expect(agentHeader()).not.toBeNull();
      expect(agentHeader()?.querySelector('[data-session-attention="error"]')).toBeNull();
    });
  });

  it("shows attention again when a later failure follows a read", async () => {
    const { sidebar, sessions, dom } = await mountAttention([
      failedRow(sessionKey, { lastReadAt: 2 }),
    ]);

    expect(dom.query('[data-session-attention="error"]')).toBeNull();
    setRows(sessions, [failedRow(sessionKey, { endedAt: 3, updatedAt: 3, lastReadAt: 2 })]);
    await settleLitElement(sidebar);

    expect(await errorDescription(sidebar)).toContain("Run failed: Provider credits exhausted");
  });

  it("marks a collapsed section that contains agent-declared attention", async () => {
    localStorage.setItem(
      "openclaw:sidebar:sessions:collapsed-sections",
      JSON.stringify(["ungrouped"]),
    );
    const { dom } = await mountAttention([agentAttentionRow(), peerRow(1)]);

    const section = dom.query('[data-session-section="ungrouped"]');
    expect(dom.query('[data-session-section="work"]')).not.toBeNull();
    expect(
      section?.querySelector(".sidebar-session-group-toggle")?.getAttribute("aria-expanded"),
    ).toBe("false");
    expect(section?.querySelector(".sidebar-session-group-attention")).not.toBeNull();
    expect(section?.querySelector(".sidebar-recent-session")).toBeNull();
  });

  it("bubbles unloaded child attention to its parent and collapsed section", async () => {
    const parentKey = "agent:main:parent";
    for (const kind of ["question", "approval"] as const) {
      localStorage.setItem("openclaw:sidebar:sessions:collapsed-sections", "[]");
      const childKey = `agent:main:subagent:${kind}`;
      const gatewayHarness = questionsGateway();
      const approval = approvalRequest(childKey, { id: "approval-child" });
      const { sidebar, dom } = await mountAttention(
        [{ key: parentKey, kind: "direct", updatedAt: 1, childSessions: [childKey] }, peerRow(0)],
        gatewayHarness.gateway,
        null,
        kind === "approval" ? [approval] : [],
      );
      if (kind === "question") {
        publishQuestion(gatewayHarness, "question-child", childKey);
        await settleLitElement(sidebar);
      }
      expect(
        dom.attr(
          `[data-session-key="${parentKey}"] [data-session-attention="${kind}"]`,
          "aria-label",
        ),
      ).toBe(
        kind === "question"
          ? "Waiting for your answer\nContinue?"
          : "Waiting for approval\ngit status",
      );
      expect(dom.query(`[data-session-key="${childKey}"]`)).toBeNull();
      expect(dom.query('[data-session-section="work"]')).not.toBeNull();
      dom.query<HTMLButtonElement>(".sidebar-session-group-toggle")?.click();
      await settleLitElement(sidebar);
      expect(
        dom.query('[data-session-section="ungrouped"] .sidebar-session-group-attention'),
      ).not.toBeNull();
      sidebar.remove();
    }
  });

  it("keeps a parent approval visible while an older child question leads the row", async () => {
    const parentKey = "agent:main:parent";
    const childKey = "agent:main:subagent:question";
    const gatewayHarness = questionsGateway();
    const { sidebar, dom } = await mountAttention(
      [{ key: parentKey, kind: "direct", updatedAt: 1, childSessions: [childKey] }, peerRow(0)],
      gatewayHarness.gateway,
      null,
      [approvalRequest(parentKey, { createdAtMs: Date.now() })],
    );
    publishQuestion(gatewayHarness, "question-child", childKey, { createdAtMs: Date.now() - 1000 });
    await settleLitElement(sidebar);
    const row = dom.query(`[data-session-key="${parentKey}"]`)!;
    expect(row.querySelector('[data-session-attention="question"]')).not.toBeNull();
    expect(row.querySelector(".session-row-badge--approval")?.getAttribute("aria-label")).toBe(
      "Approval needed",
    );
  });

  it("bubbles descendant attention and keeps its branch visible past the child cap", async () => {
    const parentKey = "agent:main:parent";
    const childKeys = Array.from(
      { length: 6 },
      (_, index) => `agent:main:dashboard:child-${index + 1}`,
    );
    const sessions = createSessionsHarness("main", [parentKey]);
    sessions.list.mockResolvedValue(
      sessionList(
        childKeys.map((key, index) =>
          index === 5
            ? { ...agentAttentionRow(key), spawnedBy: parentKey, label: "Attention child" }
            : directRow(key, `Quiet child ${index + 1}`, index + 1, {
                spawnedBy: parentKey,
              }),
        ),
        3,
      ),
    );
    setRows(sessions, [
      directRow(parentKey, "Parent task", 1, {
        childSessions: childKeys,
      }),
    ]);
    const { sidebar } = await mountSidebar(
      createGateway({} as GatewayBrowserClient),
      sessions.sessions,
    );
    const dom = domProbe(sidebar);

    dom.query<HTMLButtonElement>(`[data-child-session-toggle="${parentKey}"]`)?.click();
    await waitForFast(() => {
      expect(
        dom.query(`[data-session-key="${parentKey}"] [data-session-attention="agent"]`),
      ).not.toBeNull();
      expect(dom.query(`[data-session-key="${childKeys[5]}"]`)).not.toBeNull();
    });
    expect(dom.query(`[data-session-key="${childKeys[4]}"]`)).toBeNull();
    expect(dom.text("[data-show-more-children]")?.trim()).toBe("Show 1 more");
  });
});
