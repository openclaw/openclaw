import { describe, expect, it, vi } from "vitest";
import { rosterActivityStore } from "../../lib/agents/roster-activity-store.ts";
import { selectSidebarView } from "../app-sidebar-setup.ts";
import {
  createGatewayHarness,
  createSessionsHarness,
  mountSidebar,
  TWO_AGENTS,
} from "../app-sidebar.ts";
import { domProbe } from "../dom-probe.ts";
import { createTestGatewayClient } from "../gateway-client.ts";
import { waitForFast } from "../wait-for.ts";
import {
  approvalRequest,
  attentionLabel,
  confirmQuestion,
  expectAttention,
  publishQuestion,
  sessionList,
} from "./compact.test-support.ts";
import { mountRoster, roster, session, settleRoster } from "./roster.test-support.ts";

describe("AppSidebar session attention details", () => {
  it.each([
    ["main", "research", false],
    ["research", "research", true],
    ["main", undefined, true],
    ["research", undefined, false],
  ] as const)(
    "scopes global attention to %s (requester: %s)",
    async (agentId, requesterAgentId, ownsRequest) => {
      const now = Date.now();
      const requestTarget = { sessionKey: "global", agentId: requesterAgentId };
      const approval = approvalRequest("global", {
        request: { command: "git status --short", ...requestTarget },
        createdAtMs: now + 1,
      });
      const sessionsHarness = createSessionsHarness(agentId, ["global"]);
      const gatewayHarness = createGatewayHarness(
        createTestGatewayClient(async (method) =>
          method === "sessions.list" ? sessionsHarness.sessions.state.result : { questions: [] },
        ),
      );
      gatewayHarness.publish({ assistantAgentId: agentId, sessionKey: "global" });
      const result = sessionList([
        {
          key: "global",
          agentId,
          kind: "global",
          label: "Global conversation",
          updatedAt: now,
          status: "done",
          childSessions: [`agent:${agentId}:subagent:child`],
        },
      ]);
      sessionsHarness.publishList({ result });
      const { sidebar, context } = await mountSidebar(
        gatewayHarness.gateway,
        sessionsHarness.sessions,
        "panel",
        { ...TWO_AGENTS, scope: "global" },
        [approval],
      );
      const dom = domProbe(sidebar);
      const header = () =>
        dom.query(`[data-agent-group="${agentId}"] .sidebar-agent-roster__header`);
      const expectHeader = (label: string) => {
        expect(attentionLabel(header())).toBe(ownsRequest ? label : undefined);
        expect(dom.query('[data-session-key="global"]')).toBeNull();
      };
      sidebar.connected = true;
      sidebar.sidebarAgentsMode = "roster";
      await settleRoster(sidebar);
      publishQuestion(gatewayHarness, "global-question", "global", {
        agentId: requesterAgentId,
        questions: [confirmQuestion([], "Review the changes?")],
        createdAtMs: now,
      });
      await sidebar.updateComplete;
      expectHeader("Waiting for your answer\nReview the changes?");
      await selectSidebarView(sidebar, "pages");
      await selectSidebarView(sidebar, "sessions");
      await settleRoster(sidebar);
      await waitForFast(() => expect(header()).not.toBeNull());
      expectHeader("Waiting for your answer\nReview the changes?");
      gatewayHarness.publishEvent("question.resolved", {
        id: "global-question",
        status: "cancelled",
      });
      await sidebar.updateComplete;
      expectHeader("Waiting for approval\ngit status --short");
      await selectSidebarView(sidebar, "pages");
      await selectSidebarView(sidebar, "sessions");
      await settleRoster(sidebar);
      await waitForFast(() => expect(header()).not.toBeNull());
      sessionsHarness.publishList({ result: { ...result, count: 0, sessions: [] } });
      await rosterActivityStore(context).refresh();
      await settleRoster(sidebar);
      expectHeader("Waiting for approval\ngit status --short");
      sidebar.setSessionOwnerFilter("synthetic-unmatched-owner");
      await sidebar.updateComplete;
      expect(header()?.querySelector("[data-session-attention]")).toBeNull();
      sidebar.setSessionOwnerFilter(null);
      vi.spyOn(context.sessions, "deletionState").mockReturnValue("confirmed");
      await sidebar.updateComplete;
      expect(header()?.querySelector("[data-session-attention]")).toBeNull();
    },
  );

  it.each(["chip", "roster"] as const)(
    "updates oldest question details through resolution and expiry (%s)",
    async (mode) => {
      const now = Date.now();
      const key = "agent:main:deployment";
      const { sidebar, gatewayHarness } = await mountRoster(roster, [
        session("main", now, { key, label: "Deployment" }),
      ]);
      const dom = domProbe(sidebar);
      sidebar.sidebarAgentsMode = mode;
      if (mode === "roster") {
        await waitForFast(() => expect(dom.query('[data-agent-group="main"]')).not.toBeNull());
        expect(dom.query(`[data-session-key="${key}"]`)).toBeNull();
      } else {
        await waitForFast(() => expect(dom.query(`[data-session-key="${key}"]`)).not.toBeNull());
      }
      const publish = (
        id: string,
        questions: string[],
        createdAtMs: number,
        expiresAtMs = now + 60_000,
      ) => {
        publishQuestion(gatewayHarness, id, key, {
          createdAtMs,
          expiresAtMs,
          questions: questions.map((question, index) => ({
            questionId: `question_${index}`,
            header: "Deploy",
            question,
            options: [],
          })),
        });
      };
      publish("newer", ["Which deployment region?"], now + 1);
      publish("oldest", ["Continue with deployment?", "Which environment?"], now);
      await sidebar.updateComplete;
      const target = () =>
        dom.query(
          mode === "roster"
            ? '[data-agent-group="main"] .sidebar-agent-roster__header'
            : `[data-session-key="${key}"]`,
        );
      const expectQuestion = (label: string, options?: Parameters<typeof waitForFast>[1]) =>
        expectAttention(target, label, "question", options);
      await expectQuestion("3 questions need your answer\nContinue with deployment?\n+2 more");
      expect(dom.query(`[data-session-key="${key}"] .sidebar-recent-session__subtitle`)).toBeNull();
      gatewayHarness.publishEvent("question.resolved", {
        id: "oldest",
        status: "answered",
        answers: { answers: { question_0: ["Yes"], question_1: ["Staging"] } },
      });
      await sidebar.updateComplete;
      await expectQuestion("Waiting for your answer\nWhich deployment region?");
      publish("expiring", ["Confirm the release window?"], now - 1, Date.now() + 50);
      await sidebar.updateComplete;
      await expectQuestion("2 questions need your answer\nConfirm the release window?\n+1 more");
      await expectQuestion("Waiting for your answer\nWhich deployment region?", { timeout: 2_000 });
    },
  );

  it.each([false, true])("summarizes mixed requests oldest first (Home=%s)", async (isHome) => {
    const now = Date.now();
    const parentKey = isHome ? "agent:main:main" : "agent:main:deployment";
    const childKey = "agent:main:subagent:deploy";
    const persistentKey = "agent:main:dashboard:release";
    const approval = approvalRequest(parentKey, {
      request: { command: "pnpm test", sessionKey: parentKey },
      createdAtMs: now - 2,
    });
    const parent = session("main", now, {
      key: parentKey,
      isMain: isHome,
      childSessions: [childKey, persistentKey],
    });
    const children = [childKey, persistentKey].map((key) =>
      session("main", now, {
        key,
        isMain: false,
        spawnedBy: parentKey,
      }),
    );
    const { sidebar, gatewayHarness, context } = await mountRoster(
      roster,
      [parent, ...children],
      undefined,
      [],
      [approval],
      children,
    );
    const dom = domProbe(sidebar);
    sidebar.sidebarAgentsMode = "roster";
    await waitForFast(() => expect(dom.query('[data-agent-group="main"]')).not.toBeNull());
    expect(dom.query(`[data-session-key="${parentKey}"]`)).toBeNull();
    for (const [id, key, createdAtMs, question] of [
      ["parent-question", parentKey, now, "Which deployment region?"],
      ["child-question", childKey, now - 1, "Which environment?"],
    ] as const) {
      publishQuestion(gatewayHarness, id, key, {
        createdAtMs,
        questions: [{ questionId: "confirm", header: "Deploy", question, options: [] }],
      });
    }
    await sidebar.updateComplete;
    const header = () => dom.query('[data-agent-group="main"] .sidebar-agent-roster__header');
    await expectAttention(header, "Waiting for approval\npnpm test", "approval");
    context.overlays.snapshot.approvalQueue = [];
    for (const [notify] of vi.mocked(context.overlays.subscribe).mock.calls) {
      notify(context.overlays.snapshot);
    }
    await sidebar.updateComplete;
    await expectAttention(
      header,
      "2 questions need your answer\nWhich environment?\n+1 more",
      "question",
    );
    publishQuestion(gatewayHarness, "persistent-question", persistentKey, {
      createdAtMs: now - 3,
      questions: [
        { questionId: "revision", header: "Release", question: "Which revision?", options: [] },
      ],
    });
    expect(dom.query(`[data-session-key="${childKey}"]`)).toBeNull();
    await expectAttention(header, "3 questions need your answer\nWhich revision?\n+2 more");
  });
});
