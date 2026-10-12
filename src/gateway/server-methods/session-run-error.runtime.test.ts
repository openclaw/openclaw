import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { assert, expect, it } from "vitest";
import {
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { withSessionEntriesFromStoresInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import {
  recordGatewaySessionRunFailure,
  resolveSessionRunError,
} from "../../sessions/session-run-error.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";

it.each([
  {
    error: "write EPIPE | EPIPE",
    recovery:
      "The agent runtime disconnected. Check the task before retrying. If its worktree was removed, restore it in Worktrees or start a new session.",
  },
  {
    error: "managed worktree was removed: /tmp/example/deleted-worktree",
    recovery:
      "This session's worktree is unavailable. Restore it in Worktrees, then retry, or start a new session in the source repository. Your transcript is preserved.",
  },
])("persists runtime recovery separately from diagnostics: $error", async ({ error, recovery }) => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:main",
      storePath: path.join(state.sessionsDir(), "sessions.json"),
    };
    const sessionId = "runtime-failure-session";
    await upsertSessionEntryCore(scope, { sessionId, updatedAt: 1 });
    const target = await withSessionEntriesFromStoresInWorker(
      [{ ...scope, sessionKeys: [scope.sessionKey], projection: "exact" }],
      ([read]) => {
        const source = read?.result.source;
        assert(source);
        return {
          ...scope,
          sessionId,
          readSource: source,
          target: { canonicalKey: scope.sessionKey, storeKeys: [scope.sessionKey] },
        };
      },
      { ordered: true },
    );
    await recordGatewaySessionRunFailure({ target, runId: "failed-runtime", error });
    const report = (await loadTranscriptEvents(target)).find(
      (event) => isRecord(event) && event.type === "custom_message",
    );
    assert(isRecord(report) && isRecord(report.details));
    expect(report.content).toContain(recovery);
    expect(report.content).toContain(error);
    expect(report.details.error).toBe(error);
    expect(resolveSessionRunError({ error }, "failed")).toBe(recovery);
    expect(resolveSessionRunError({ error: recovery }, "failed")).toBe(recovery);
  });
});

it("does not reinterpret unrelated failures or successful outcomes", () => {
  const error = "managed worktree allocation lease core:managed-worktrees:create/capacity was lost";
  expect(resolveSessionRunError({ error }, "failed")).toBe(error);
  expect(resolveSessionRunError({ error: "write EPIPE | EPIPE" }, "done")).toBeUndefined();
});
