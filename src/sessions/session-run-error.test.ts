import { describe, expect, it, vi } from "vitest";
import { appendSessionTranscriptReport } from "../config/sessions/session-accessor.js";
import type { CustomMessageReportAppend } from "../config/sessions/session-accessor.sqlite-transcript-reports.types.js";
import { SessionTranscriptWriterClaimReboundError } from "../config/sessions/session-transcript-writer-claim-error.js";
import { recordGatewaySessionRunFailure, resolveSessionRunError } from "./session-run-error.js";

// mock-isolation: Capture run-failure notices without opening a real session store.
vi.mock("../config/sessions/session-accessor.js", () => ({
  appendSessionTranscriptReport: vi.fn(),
}));

const storageFailures = [
  {
    name: "writer claim rebound",
    error: new SessionTranscriptWriterClaimReboundError(),
    legacyError: "session writer claim changed before transcript persistence",
    summary:
      "This conversation changed while OpenClaw was working. Check its latest messages before continuing.",
    content:
      "⚠️ This conversation changed while OpenClaw was working. Check its latest messages before continuing. For details, open Settings → Logs in the Control UI or run `openclaw logs --follow` in your terminal.",
  },
  {
    name: "SQLite busy",
    error: Object.assign(new Error("Synthetic storage contention"), { code: "SQLITE_BUSY" }),
    legacyError: "database is locked",
    summary:
      "OpenClaw is busy saving your conversation. Wait a moment, then check the conversation before trying again.",
    content:
      "⚠️ OpenClaw is busy saving your conversation. Wait a moment, then check the conversation before trying again. For details, open Settings → Logs in the Control UI or run `openclaw logs --follow` in your terminal.",
  },
];

describe("recordGatewaySessionRunFailure", () => {
  it.each([
    ...storageFailures.flatMap(({ name, error, legacyError, content }) => [
      { name, error, diagnostic: expect.any(String), content },
      { name: `recorded ${name}`, error: legacyError, diagnostic: legacyError, content },
    ]),
    {
      name: "ordinary error",
      error: "Synthetic run failure",
      diagnostic: "Synthetic run failure",
      content: "Your request couldn't be completed: Synthetic run failure",
    },
    {
      name: "workspace permission error",
      error: Object.assign(
        new Error("EACCES: permission denied, scandir '/synthetic/workspace-main'"),
        { code: "EACCES" },
      ),
      diagnostic: '{"code":"EACCES"}',
      content: 'Your request couldn\'t be completed: {"code":"EACCES"}',
    },
  ])("appends $name copy and retains its diagnostic", async ({ error, diagnostic, content }) => {
    let appended: CustomMessageReportAppend | undefined;
    vi.mocked(appendSessionTranscriptReport).mockImplementation(async (_target, report) => {
      if (report.kind !== "custom") {
        throw new Error("Expected a custom run-failure notice");
      }
      appended = report.selectReport(undefined);
      return { ok: true, value: undefined };
    });

    await recordGatewaySessionRunFailure({
      target: {
        agentId: "main",
        storePath: "/synthetic/sessions.json",
        sessionKey: "agent:main:run-failure-copy",
        sessionId: "run-failure-copy",
      },
      runId: "failed-run",
      error,
    });

    expect(appended).toEqual({
      customType: "run-failed-before-reply",
      content,
      display: true,
      excludeFromContext: true,
      details: { runId: "failed-run", error: diagnostic },
    });
  });
});

describe("resolveSessionRunError", () => {
  it.each(storageFailures)(
    "maps recorded $name errors in session rows",
    ({ legacyError, summary }) => {
      const error = resolveSessionRunError({ error: legacyError }, "failed");
      expect(error).toBe(summary);
    },
  );

  it.each([
    "Synthetic run failure",
    "EACCES: permission denied, scandir '/synthetic/workspace-main'",
  ])("preserves ordinary session-row errors: %s", (error) => {
    expect(resolveSessionRunError({ error }, "failed")).toBe(error);
  });
});
