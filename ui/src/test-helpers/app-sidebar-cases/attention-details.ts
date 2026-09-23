import { describe, expect, it } from "vitest";
import type { SessionsListResult } from "../../api/types.ts";
import type { ExecApprovalRequest } from "../../app/exec-approval.ts";
import {
  createGatewayHarness,
  createSessionsHarness,
  mountSidebar,
  TWO_AGENTS,
} from "../app-sidebar.ts";
import { createTestGatewayClient } from "../gateway-client.ts";
import { waitForFast } from "../wait-for.ts";
import { mountRoster, roster, session, toggleRoster } from "./roster.test-support.ts";

describe("AppSidebar session attention details", () => {
  it.each([
    ["main", "research", false],
    ["research", "research", true],
    ["main", undefined, true],
    ["research", undefined, false],
  ] as const)(
    "keeps global Home attention scoped to %s for requester %s",
    async (agentId, requesterAgentId, ownsRequest) => {
      const now = Date.now();
      const requestTarget = { sessionKey: "global", agentId: requesterAgentId };
      const approval = {
        id: "global-approval",
        kind: "exec",
        request: { command: "git status --short", ...requestTarget },
        createdAtMs: now + 1,
        expiresAtMs: now + 60_000,
      } satisfies ExecApprovalRequest;
      const sessionsHarness = createSessionsHarness(agentId, ["global"]);
      const gatewayHarness = createGatewayHarness(
        createTestGatewayClient(async (method) =>
          method === "sessions.list" ? sessionsHarness.sessions.state.result : { questions: [] },
        ),
      );
      gatewayHarness.publish({ assistantAgentId: agentId, sessionKey: "global" });
      const result = {
        ts: 2,
        path: "",
        count: 1,
        defaults: { modelProvider: null, model: null, contextTokens: null },
        sessions: [
          {
            key: "global",
            agentId,
            kind: "global",
            label: "Global conversation",
            updatedAt: now,
            status: "done",
            childSessions: [`agent:${agentId}:subagent:child`],
          },
        ],
      } satisfies SessionsListResult;
      sessionsHarness.publishList({ result });
      const { sidebar } = await mountSidebar(
        gatewayHarness.gateway,
        sessionsHarness.sessions,
        "panel",
        { ...TWO_AGENTS, scope: "global" },
        [approval],
      );
      gatewayHarness.publishEvent("question.requested", {
        id: "global-question",
        ...requestTarget,
        questions: [
          {
            questionId: "confirm",
            header: "Confirm",
            question: "Review the changes?",
            options: [],
          },
        ],
        createdAtMs: now,
        expiresAtMs: now + 60_000,
        status: "pending",
      });
      await sidebar.updateComplete;
      expect(
        sidebar
          .querySelector(".nav-item--home [data-session-attention]")
          ?.getAttribute("aria-label"),
      ).toBe(ownsRequest ? "Waiting for your answer\nReview the changes?" : undefined);
      expect(sidebar.querySelector('[data-session-key="global"]')).toBeNull();
      await toggleRoster(sidebar);
      const header = () =>
        sidebar.querySelector(`[data-agent-group="${agentId}"] .sidebar-agent-roster__header`);
      await waitForFast(() => expect(header()).not.toBeNull());
      expect(sidebar.querySelector('[data-session-key="global"]')).toBeNull();
      expect(header()?.querySelector("[data-session-attention]")?.getAttribute("aria-label")).toBe(
        ownsRequest ? "Waiting for your answer\nReview the changes?" : undefined,
      );
      gatewayHarness.publishEvent("question.resolved", {
        id: "global-question",
        status: "cancelled",
      });
      await sidebar.updateComplete;
      expect(header()?.querySelector("[data-session-attention]")?.getAttribute("aria-label")).toBe(
        ownsRequest ? "Waiting for approval\ngit status --short" : undefined,
      );
      await toggleRoster(sidebar);
      await waitForFast(() => expect(sidebar.querySelector(".nav-item--home")).not.toBeNull());
      sessionsHarness.publishList({ result: { ...result, count: 0, sessions: [] } });
      await sidebar.updateComplete;
      expect(
        sidebar
          .querySelector(".nav-item--home [data-session-attention]")
          ?.getAttribute("aria-label"),
      ).toBe(ownsRequest ? "Waiting for approval\ngit status --short" : undefined);
    },
  );

  it.each(["chip", "roster"] as const)(
    "keeps oldest request details and counts current through resolution and expiry in %s mode",
    async (mode) => {
      const now = Date.now();
      const key = "agent:main:deployment";
      const { sidebar, gatewayHarness } = await mountRoster(roster, [
        session("main", now, { key, label: "Deployment" }),
      ]);
      sidebar.sidebarAgentsMode = mode;
      if (mode === "roster") {
        await waitForFast(() =>
          expect(sidebar.querySelector('[data-agent-collapse="main"]')).not.toBeNull(),
        );
      }
      await waitForFast(() =>
        expect(sidebar.querySelector(`[data-session-key="${key}"]`)).not.toBeNull(),
      );
      const publish = (
        id: string,
        questions: string[],
        createdAtMs: number,
        expiresAtMs = now + 60_000,
      ) => {
        gatewayHarness.publishEvent("question.requested", {
          id,
          sessionKey: key,
          agentId: "main",
          createdAtMs,
          expiresAtMs,
          status: "pending",
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
      const indicator = () =>
        sidebar.querySelector(`[data-session-key="${key}"] [data-session-attention="question"]`);
      await waitForFast(() =>
        expect(indicator()?.getAttribute("aria-label")).toBe(
          "3 questions need your answer\nContinue with deployment?\n+2 more",
        ),
      );
      expect(
        sidebar.querySelector(`[data-session-key="${key}"] .sidebar-recent-session__subtitle`),
      ).toBeNull();
      gatewayHarness.publishEvent("question.resolved", {
        id: "oldest",
        status: "answered",
        answers: { answers: { question_0: ["Yes"], question_1: ["Staging"] } },
      });
      await sidebar.updateComplete;
      await waitForFast(() =>
        expect(indicator()?.getAttribute("aria-label")).toBe(
          "Waiting for your answer\nWhich deployment region?",
        ),
      );
      publish("expiring", ["Confirm the release window?"], now - 1, Date.now() + 50);
      await sidebar.updateComplete;
      await waitForFast(() =>
        expect(indicator()?.getAttribute("aria-label")).toBe(
          "2 questions need your answer\nConfirm the release window?\n+1 more",
        ),
      );
      await waitForFast(
        () =>
          expect(indicator()?.getAttribute("aria-label")).toBe(
            "Waiting for your answer\nWhich deployment region?",
          ),
        { timeout: 2_000 },
      );
    },
  );

  it.each([false, true])(
    "summarizes mixed pending requests once, oldest first (Home=%s)",
    async (isHome) => {
      const now = Date.now();
      const parentKey = isHome ? "agent:main:main" : "agent:main:deployment";
      const childKey = "agent:main:subagent:deploy";
      const persistentKey = "agent:main:dashboard:release";
      const approval = {
        id: "approval-older",
        kind: "exec",
        request: { command: "pnpm test", sessionKey: parentKey },
        createdAtMs: now - 2,
        expiresAtMs: now + 60_000,
      } satisfies ExecApprovalRequest;
      const parent = session("main", now, {
        key: parentKey,
        isMain: isHome,
        childSessions: [childKey, persistentKey],
      });
      const child = session("main", now, { key: childKey, isMain: false, spawnedBy: parentKey });
      const persistent = session("main", now, {
        key: persistentKey,
        isMain: false,
        spawnedBy: parentKey,
      });
      const { sidebar, gatewayHarness, context } = await mountRoster(
        roster,
        [parent, child, persistent],
        undefined,
        [],
        [approval],
        [child, persistent],
      );
      sidebar.sidebarAgentsMode = "roster";
      await waitForFast(() =>
        expect(sidebar.querySelector('[data-agent-collapse="main"]')).not.toBeNull(),
      );
      if (!isHome) {
        await waitForFast(() =>
          expect(sidebar.querySelector(`[data-session-key="${parentKey}"]`)).not.toBeNull(),
        );
      }
      for (const [id, key, createdAtMs, question] of [
        ["parent-question", parentKey, now, "Which deployment region?"],
        ["child-question", childKey, now - 1, "Which environment?"],
      ] as const) {
        gatewayHarness.publishEvent("question.requested", {
          id,
          sessionKey: key,
          agentId: "main",
          createdAtMs,
          expiresAtMs: now + 60_000,
          status: "pending",
          questions: [{ questionId: "confirm", header: "Deploy", question, options: [] }],
        });
      }
      await sidebar.updateComplete;
      sidebar.querySelector<HTMLButtonElement>('[data-agent-collapse="main"]')?.click();
      await waitForFast(() =>
        expect(sidebar.querySelector(`[data-session-key="${parentKey}"]`)).toBeNull(),
      );
      const header = () =>
        sidebar.querySelector('[data-agent-group="main"] .sidebar-agent-roster__header');
      await waitForFast(() =>
        expect(
          header()
            ?.querySelector('[data-session-attention="approval"]')
            ?.getAttribute("aria-label"),
        ).toBe("Waiting for approval\npnpm test"),
      );
      context.overlays.snapshot.approvalQueue = [];
      sidebar.requestUpdate();
      await sidebar.updateComplete;
      await waitForFast(() =>
        expect(
          header()
            ?.querySelector('[data-session-attention="question"]')
            ?.getAttribute("aria-label"),
        ).toBe("2 questions need your answer\nWhich environment?\n+1 more"),
      );
      gatewayHarness.publishEvent("question.requested", {
        id: "persistent-question",
        sessionKey: persistentKey,
        agentId: "main",
        createdAtMs: now - 3,
        expiresAtMs: now + 60_000,
        status: "pending",
        questions: [
          { questionId: "revision", header: "Release", question: "Which revision?", options: [] },
        ],
      });
      sidebar.querySelector<HTMLButtonElement>('[data-agent-collapse="main"]')!.click();
      if (!isHome) {
        await waitForFast(() =>
          expect(
            sidebar.querySelector(`[data-child-session-toggle="${parentKey}"]`),
          ).not.toBeNull(),
        );
        sidebar
          .querySelector<HTMLButtonElement>(`[data-child-session-toggle="${parentKey}"]`)!
          .click();
      }
      const attention = (key: string) =>
        (isHome && key === parentKey
          ? header()?.querySelector("[data-session-attention]")
          : sidebar.querySelector(`[data-session-key="${key}"] [data-session-attention]`)
        )?.getAttribute("aria-label");
      await waitForFast(() =>
        expect(attention(persistentKey)).toBe("Waiting for your answer\nWhich revision?"),
      );
      expect(attention(parentKey)).toBe(
        "2 questions need your answer\nWhich environment?\n+1 more",
      );
      expect(sidebar.querySelector(`[data-session-key="${childKey}"]`)).toBeNull();
      sidebar
        .querySelector<HTMLButtonElement>(
          isHome ? '[data-agent-collapse="main"]' : `[data-child-session-toggle="${parentKey}"]`,
        )!
        .click();
      await waitForFast(() =>
        expect(attention(parentKey)).toBe("3 questions need your answer\nWhich revision?\n+2 more"),
      );
    },
  );
});
