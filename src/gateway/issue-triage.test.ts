import { describe, expect, test, vi } from "vitest";
import {
  ISSUE_TRIAGE_AUTO_FIX_LABEL,
  ISSUE_TRIAGE_DECLINED_LABEL,
  ISSUE_TRIAGE_COMMENT_MARKER,
  parseIssueTriageText,
  triageIssue,
  type IssueTriageService,
} from "./issue-triage.js";

function clawhipText(payload: Record<string, unknown>) {
  return `[clawhip:github.issue-opened] new issue\n\nPayload: ${JSON.stringify(payload, null, 2)}`;
}

function service(overrides: Partial<IssueTriageService> = {}): IssueTriageService {
  return {
    classifyIssue: vi.fn(async () => "delegate"),
    addLabels: vi.fn(async () => {}),
    createComment: vi.fn(async () => {}),
    hasExistingTriageComment: vi.fn(async () => false),
    ...overrides,
  };
}

describe("issue triage helpers", () => {
  test("parses clawhip Payload JSON", () => {
    const parsed = parseIssueTriageText(
      clawhipText({
        repo: "openclaw/openclaw",
        number: 123,
        title: "Bug",
        html_url: "https://github.com/openclaw/openclaw/issues/123",
        labels: [{ name: "bug" }, "needs-triage"],
        body_preview: "broken",
      }),
    );

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.issue).toMatchObject({
        repo: "openclaw/openclaw",
        number: 123,
        title: "Bug",
        labels: ["bug", "needs-triage"],
      });
    }
  });

  test.each([
    { labels: [ISSUE_TRIAGE_AUTO_FIX_LABEL], reason: "already-triaged" },
    { labels: [ISSUE_TRIAGE_DECLINED_LABEL], reason: "already-triaged" },
    { labels: [], state: "closed", reason: "closed" },
    { labels: [], locked: true, reason: "locked" },
  ])("noops for idempotent issue states %#", async (input) => {
    const svc = service();
    const result = await triageIssue(
      {
        repo: "openclaw/openclaw",
        number: 1,
        title: "Bug",
        labels: input.labels,
        state: input.state,
        locked: input.locked,
      },
      svc,
    );

    expect(result).toEqual({ ok: true, status: "noop", reason: input.reason });
    expect(svc.classifyIssue).not.toHaveBeenCalled();
    expect(svc.addLabels).not.toHaveBeenCalled();
  });

  test("delegate classification adds only auto-fix label", async () => {
    const svc = service({ classifyIssue: vi.fn(async () => ({ decision: "delegate" })) });
    const result = await triageIssue(
      { repo: "openclaw/openclaw", number: 1, title: "Bug", labels: [] },
      svc,
    );

    expect(result).toEqual({ ok: true, status: "labeled", decision: "delegate" });
    expect(svc.addLabels).toHaveBeenCalledWith("openclaw/openclaw", 1, [
      ISSUE_TRIAGE_AUTO_FIX_LABEL,
    ]);
    expect(svc.createComment).not.toHaveBeenCalled();
  });

  test("close classification comments before adding declined label", async () => {
    const calls: string[] = [];
    const svc = service({
      classifyIssue: vi.fn(async () => "close"),
      createComment: vi.fn(async (_repo, _number, body) => {
        expect(body).toContain(ISSUE_TRIAGE_COMMENT_MARKER);
        calls.push("comment");
      }),
      addLabels: vi.fn(async () => {
        calls.push("label");
      }),
    });

    const result = await triageIssue(
      { repo: "openclaw/openclaw", number: 1, title: "Bug", labels: [] },
      svc,
    );

    expect(result).toEqual({
      ok: true,
      status: "labeled",
      decision: "close",
      commentCreated: true,
    });
    expect(calls).toEqual(["comment", "label"]);
    expect(svc.addLabels).toHaveBeenCalledWith("openclaw/openclaw", 1, [
      ISSUE_TRIAGE_DECLINED_LABEL,
    ]);
  });

  test("does not duplicate existing close comment", async () => {
    const svc = service({
      classifyIssue: vi.fn(async () => "close"),
      hasExistingTriageComment: vi.fn(async () => true),
    });
    const result = await triageIssue(
      { repo: "openclaw/openclaw", number: 1, title: "Bug", labels: [] },
      svc,
    );

    expect(result).toEqual({
      ok: true,
      status: "labeled",
      decision: "close",
      commentCreated: false,
    });
    expect(svc.createComment).not.toHaveBeenCalled();
    expect(svc.addLabels).toHaveBeenCalledWith("openclaw/openclaw", 1, [
      ISSUE_TRIAGE_DECLINED_LABEL,
    ]);
  });

  test("classifier failures do not label", async () => {
    const svc = service({
      classifyIssue: vi.fn(async () => {
        throw new Error("llm down");
      }),
    });
    const result = await triageIssue(
      { repo: "openclaw/openclaw", number: 1, title: "Bug", labels: [] },
      svc,
    );

    expect(result).toEqual({ ok: false, httpStatus: 503, error: "issue triage classifier failed" });
    expect(svc.addLabels).not.toHaveBeenCalled();
  });

  test("unknown classifier result and GitHub failures map to 502 without unsafe follow-up", async () => {
    const unknownSvc = service({ classifyIssue: vi.fn(async () => "maybe") });
    await expect(
      triageIssue({ repo: "openclaw/openclaw", number: 1, title: "Bug", labels: [] }, unknownSvc),
    ).resolves.toEqual({
      ok: false,
      httpStatus: 502,
      error: "issue triage classifier returned an unknown decision",
    });
    expect(unknownSvc.addLabels).not.toHaveBeenCalled();

    const commentFailsSvc = service({
      classifyIssue: vi.fn(async () => "close"),
      createComment: vi.fn(async () => {
        throw new Error("comment failed");
      }),
    });
    await expect(
      triageIssue(
        { repo: "openclaw/openclaw", number: 1, title: "Bug", labels: [] },
        commentFailsSvc,
      ),
    ).resolves.toEqual({ ok: false, httpStatus: 502, error: "GitHub comment API failed" });
    expect(commentFailsSvc.addLabels).not.toHaveBeenCalled();
  });
});
