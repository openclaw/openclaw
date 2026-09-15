import { describe, expect, it } from "vitest";
import type { ExecApprovalRequest } from "../../app/exec-approval.ts";
import { waitForFast } from "../wait-for.ts";
import { mountRoster, roster, session } from "./roster.test-support.ts";

describe("AppSidebar session attention details", () => {
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

  it("summarizes mixed pending requests once in a collapsed agent, oldest first", async () => {
    const now = Date.now();
    const parentKey = "agent:main:deployment";
    const childKey = "agent:main:subagent:deploy";
    const approval = {
      id: "approval-older",
      kind: "exec",
      request: { command: "pnpm test", sessionKey: parentKey },
      createdAtMs: now - 2,
      expiresAtMs: now + 60_000,
    } satisfies ExecApprovalRequest;
    const parent = session("main", now, {
      key: parentKey,
      isMain: false,
      childSessions: [childKey],
    });
    const child = session("main", now, { key: childKey, isMain: false, spawnedBy: parentKey });
    const { sidebar, gatewayHarness, context } = await mountRoster(
      roster,
      [parent, child],
      undefined,
      [],
      [approval],
      [child],
    );
    sidebar.sidebarAgentsMode = "roster";
    await waitForFast(() =>
      expect(sidebar.querySelector('[data-agent-collapse="main"]')).not.toBeNull(),
    );
    await waitForFast(() =>
      expect(sidebar.querySelector(`[data-session-key="${parentKey}"]`)).not.toBeNull(),
    );
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
        header()?.querySelector('[data-session-attention="approval"]')?.getAttribute("aria-label"),
      ).toBe("Waiting for approval\npnpm test"),
    );
    context.overlays.snapshot.approvalQueue = [];
    sidebar.requestUpdate();
    await sidebar.updateComplete;
    await waitForFast(() =>
      expect(
        header()?.querySelector('[data-session-attention="question"]')?.getAttribute("aria-label"),
      ).toBe("2 questions need your answer\nWhich environment?\n+1 more"),
    );
  });
});
