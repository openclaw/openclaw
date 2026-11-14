import { expect, it, vi } from "vitest";
import { appendSessionTranscriptReport } from "../config/sessions/session-accessor.js";
import { SessionTranscriptWriterClaimReboundError } from "../config/sessions/session-transcript-writer-claim-error.js";
import { resolveSessionRunError } from "./session-run-error-format.js";
import { recordGatewaySessionRunFailure } from "./session-run-error.js";

// mock-isolation: Capture run-failure notices without opening a real session store.
vi.mock("../config/sessions/session-accessor.js", () => ({
  appendSessionTranscriptReport: vi.fn(),
}));

const storageFailures = [
  [
    new SessionTranscriptWriterClaimReboundError(),
    "session writer claim changed before transcript persistence",
    "This conversation changed while OpenClaw was working. Check its latest messages before continuing.",
  ],
  [
    Object.assign(new Error("Synthetic storage contention"), { code: "SQLITE_BUSY" }),
    "database is locked",
    "OpenClaw is busy saving your conversation. Wait a moment, then check the conversation before trying again.",
  ],
] as const;

it.each([
  ...[
    "No answer was returned. Ask again if you still need one.",
    "No answer was returned. Ask again if you still need one. Note: some tool actions may have already been executed — please verify before retrying.",
  ].map((notice) => [notice, notice, notice] as const),
  ...storageFailures.map(([error, , summary]) => {
    const content = `⚠️ ${summary} For details, open Settings → Logs in the Control UI or run \`openclaw logs --follow\` in your terminal.`;
    return [error, expect.any(String), content] as const;
  }),
  [
    Object.assign(new Error("EACCES: permission denied, scandir '/synthetic/workspace-main'"), {
      code: "EACCES",
    }),
    "EACCES: permission denied, scandir '/synthetic/workspace-main'",
    "Your request couldn't be completed.",
  ],
] as const)(
  "appends failure copy and retains its diagnostic: %s",
  async (error, diagnostic, content) => {
    expect.hasAssertions();
    vi.mocked(appendSessionTranscriptReport).mockImplementation(async (_target, report) => {
      if (report.kind !== "custom") {
        throw new Error("Expected a custom run-failure notice");
      }
      expect(report.selectReport(undefined)).toMatchObject({
        customType: "run-failed-before-reply",
        content,
        display: true,
        excludeFromContext: true,
        details: { runId: "failed-run", error: diagnostic },
      });
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
  },
);

it.each([
  ...storageFailures.map(([, legacyError, summary]) => [legacyError, summary] as const),
  ...[
    "Synthetic run failure",
    "EACCES: permission denied, scandir '/synthetic/workspace-main'",
  ].map((error) => [error, error] as const),
])("resolves session-row error: %s", (error, expected) => {
  expect(resolveSessionRunError({ error }, "failed")).toBe(expected);
});
